// 자막(전사 결과)에서 YouTube 메타데이터(제목 후보/설명/태그/썸네일 카피)를 생성.
//
// 1순위: Claude (ANTHROPIC_API_KEY 있을 때). structured outputs 로 스키마를 강제해
//        파싱 실패를 없애고, system 프롬프트에 prompt caching 을 걸어 반복 호출
//        비용을 줄인다.
// 2순위: 키가 없으면 로컬 휴리스틱 — 자막 빈도 분석으로 태그/제목을 뽑고 챕터를
//        균등 분포로 만든다. Render Free 처럼 키를 안 넣는 배포에서도 stage 가
//        통째로 죽지 않게 하기 위한 fallback.

const MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-5";

export function metadataProvider() {
  return process.env.ANTHROPIC_API_KEY ? "claude" : "heuristic";
}

const SYSTEM_PROMPT = `당신은 한국 유튜브 채널의 메타데이터 카피라이터입니다. 영상 자막 전체를 읽고 다음을 만듭니다.

- titles: 제목 후보 5개. 각 30자 이하, 클릭 유도하되 낚시는 금지.
- description: 영상 설명문. 첫 2줄에 핵심을 담고, 이어서 "0:00 내용" 형식의 챕터 5개를 자막 타임스탬프에서 뽑아 넣습니다.
- tags: 검색 노출용 태그 12개 이하. 한글 위주, 영어 키워드 1~2개.
- thumbnail_copy: 썸네일에 큰 글자로 박을 6~10자 후크 카피 1개.
- thumbnail_subcopy: 보조 카피 4~8자. 마땅한 게 없으면 빈 문자열.

규칙:
- 영상에 실제 등장한 단어와 주제만 사용합니다. 자막에 없는 사실을 지어내지 않습니다.
- 챕터 타임스탬프는 반드시 자막에 있는 시각에서 고릅니다.
- tags 안의 영어 키워드를 빼고 모든 출력은 한국어입니다.`;

const METADATA_SCHEMA = {
  type: "object",
  properties: {
    titles: { type: "array", items: { type: "string" } },
    description: { type: "string" },
    tags: { type: "array", items: { type: "string" } },
    thumbnail_copy: { type: "string" },
    thumbnail_subcopy: { type: "string" },
  },
  required: ["titles", "description", "tags", "thumbnail_copy", "thumbnail_subcopy"],
  additionalProperties: false,
};

// segments: [{ start, end, text }, ...]
export async function generateMetadata(segments, { persona = "", durationSec = 0 } = {}) {
  const clean = (segments || []).filter((s) => String(s?.text || "").trim().length > 0);
  if (clean.length === 0) {
    throw new Error("자막이 비어 있어 메타데이터를 만들 수 없습니다. 자막 단계를 먼저 성공시켜 주세요.");
  }
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const data = await generateWithClaude(clean, persona);
      return { ...normalize(data), source: "claude", model: MODEL };
    } catch (e) {
      // 키가 있어도 호출은 실패할 수 있다 (크레딧 소진, 레이트리밋, 일시적 5xx,
      // 안전장치 거절). 그 때문에 편집·자막까지 끝난 작업의 메타데이터 단계를
      // 통째로 실패시킬 이유는 없으니 휴리스틱으로 내려가고 사유만 남긴다.
      const reason = String(e?.message || e).slice(0, 300);
      console.warn(`[metadata] Claude 실패 — 휴리스틱으로 대체: ${reason}`);
      return {
        ...normalize(generateHeuristic(clean, durationSec)),
        source: "heuristic",
        model: null,
        fallbackFrom: "claude",
        fallbackReason: reason,
      };
    }
  }
  return { ...normalize(generateHeuristic(clean, durationSec)), source: "heuristic", model: null };
}

function normalize(data) {
  return {
    titles: (Array.isArray(data.titles) ? data.titles : []).map(String).slice(0, 5),
    description: String(data.description || ""),
    tags: (Array.isArray(data.tags) ? data.tags : []).map(String).slice(0, 12),
    thumbnailCopy: String(data.thumbnail_copy || ""),
    thumbnailSubcopy: String(data.thumbnail_subcopy || ""),
  };
}

// ── Claude ──────────────────────────────────────────────────────────────────
async function generateWithClaude(segments, persona) {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic();

  // 캐시는 prefix 매칭이라 브레이크포인트 앞에 있는 게 전부 캐시 대상이 된다.
  // 페르소나는 UI 에서 바뀌므로 브레이크포인트 뒤에 둬야 고정 프롬프트가
  // 살아남는다 (예전엔 페르소나 블록에 걸려 있어서, 페르소나를 고치면 캐시가
  // 통째로 날아갔다).
  //
  // 다만 지금 고정 프롬프트는 한국어 약 250 토큰이라 claude-opus-5 의 최소
  // 캐시 길이(512 토큰)에 못 미친다 — 즉 지금은 캐시가 실제로 안 걸린다.
  // 에러는 안 나고 조용히 무시되며, 프롬프트가 길어지면 그때부터 동작한다.
  const system = [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }];
  if (persona) system.push({ type: "text", text: `채널 페르소나/톤: ${persona}` });

  const transcript = segments
    .map((s) => `[${formatTimestamp(s.start)}] ${String(s.text).trim()}`)
    .join("\n");

  const params = {
    model: MODEL,
    max_tokens: 8000,
    system,
    output_config: {
      // 카피라이팅은 깊은 추론이 필요 없다 — 토큰/지연을 낮게.
      effort: "low",
      format: { type: "json_schema", schema: METADATA_SCHEMA },
    },
    messages: [
      {
        role: "user",
        content: `다음은 영상 자막 전체입니다. 위 규칙대로 메타데이터를 만들어 주세요.\n\n<transcript>\n${transcript}\n</transcript>`,
      },
    ],
  };

  const resp = await createWithFallback(client, params);

  if (resp.stop_reason === "refusal") {
    throw new Error(
      `모델이 이 자막에 대한 메타데이터 생성을 거부했습니다 (${resp.stop_details?.category || "사유 미상"}).`
    );
  }
  const text = (resp.content || []).find((b) => b.type === "text")?.text;
  if (!text) throw new Error("모델이 빈 응답을 반환했습니다.");
  return JSON.parse(text);
}

// 안전장치가 요청을 거절하면 서버가 알아서 다른 모델로 재실행하도록 server-side
// fallback 을 기본으로 켠다. 조직에 해당 beta 가 없으면 400 이 나므로, 그때만
// 일반 엔드포인트로 한 번 더 시도한다.
async function createWithFallback(client, params) {
  try {
    return await client.beta.messages.create({
      ...params,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
  } catch (e) {
    const msg = String(e?.message || e);
    const isBetaProblem = e?.status === 400 && /fallback|beta/i.test(msg);
    if (!isBetaProblem) throw e;
    console.warn(`[metadata] server-side fallback 미지원 — 일반 요청으로 재시도: ${msg.slice(0, 200)}`);
    return client.messages.create(params);
  }
}

// ── 로컬 휴리스틱 (API 키 없을 때) ──────────────────────────────────────────
// 완성도 높은 카피를 기대할 수는 없지만, 자막에 실제로 등장한 단어만 쓰기 때문에
// 최소한 "지어낸 정보"는 들어가지 않는다.
const STOPWORDS = new Set([
  "그리고", "그래서", "하지만", "그러니까", "그런데", "이제", "약간", "진짜", "정말",
  "사실", "이거", "그거", "저거", "여기", "거기", "저기", "우리", "제가", "저는",
  "너무", "조금", "많이", "다시", "먼저", "지금", "다음", "때문", "같은", "같이",
  "합니다", "습니다", "입니다", "했습니다", "하는", "하고", "해서", "되는", "있는",
  "없는", "것을", "것이", "부분", "경우", "생각", "the", "and", "for", "you", "that",
  "this", "with", "have", "was", "are", "but", "not",
]);

function tokenize(text) {
  return String(text)
    .toLowerCase()
    .split(/[^가-힣a-z0-9]+/)
    .filter((w) => w.length >= 2 && !STOPWORDS.has(w));
}

function generateHeuristic(segments, durationSec) {
  const freq = new Map();
  for (const s of segments) {
    for (const w of tokenize(s.text)) freq.set(w, (freq.get(w) || 0) + 1);
  }
  const ranked = [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .map(([w]) => w);
  // 한국어는 조사가 붙어 "자동"/"자동으로" 가 따로 잡힌다. 어간이 겹치는 건
  // 먼저(=더 자주) 나온 쪽만 남겨 태그가 같은 말로 도배되는 걸 막는다.
  const keywords = [];
  for (const w of ranked) {
    if (keywords.some((k) => k.startsWith(w) || w.startsWith(k))) continue;
    keywords.push(w);
    if (keywords.length >= 12) break;
  }
  const top = keywords.slice(0, 3);

  const firstLine = String(segments[0].text).trim().slice(0, 40);
  const titles = [
    top.length ? `${top.join(" ")} 총정리` : firstLine,
    firstLine,
    top[0] ? `${top[0]}, 이것만 알면 됩니다` : `${firstLine} | 요약`,
    top.slice(0, 2).join(" · ") || firstLine,
    top[0] ? `${top[0]} 완전 정리` : firstLine,
  ].filter(Boolean).map((t) => t.slice(0, 30));

  const total = durationSec || segments[segments.length - 1].end || 0;
  const chapterCount = Math.min(5, segments.length);
  const chapters = [];
  for (let i = 0; i < chapterCount; i++) {
    // 첫 챕터는 반드시 0:00 (YouTube 챕터 규격), 나머지는 균등 분포.
    const idx = i === 0 ? 0 : Math.floor((segments.length * i) / chapterCount);
    const seg = segments[idx];
    const t = i === 0 ? 0 : seg.start;
    chapters.push(`${formatTimestamp(t)} ${String(seg.text).trim().slice(0, 30)}`);
  }

  const description = [
    firstLine,
    top.length ? `${top.join(", ")} 에 대해 다룹니다.` : "",
    "",
    "타임라인",
    ...chapters,
    "",
    total ? `총 길이 ${formatTimestamp(total)}` : "",
  ].filter((l) => l !== null).join("\n").trim();

  return {
    titles,
    description,
    tags: keywords,
    thumbnail_copy: (top[0] || firstLine).slice(0, 10),
    thumbnail_subcopy: (top[1] || "").slice(0, 8),
  };
}

function formatTimestamp(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(r).padStart(2, "0")}`;
}
