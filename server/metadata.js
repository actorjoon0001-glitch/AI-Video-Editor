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
- one_liner: 영상을 한 줄로 요약. 40자 이하, 마침표 없이.
- intro: 집/영상 소개 2~4문장. 설명글 맨 위에 들어갑니다.
- spec: 영상에 나온 집의 제원. 각 항목은 문자열이며, 자막에서 확인되지 않으면
  반드시 빈 문자열("")로 둡니다. 추측해서 채우지 마세요.
    area_pyeong  평수 숫자만 (예: "10")
    area_m2      제곱미터 숫자만 (예: "33")
    method       공법 (예: "경량목구조", "모듈러")
    composition  구성 (예: "방1 거실1 욕실1")
    price        가격대 (예: "5,980만원")
- chapters: 챕터 5~8개. 각 { time, title } 이고 time 은 "0:00" 또는 "1:23:45" 형식.
  첫 챕터는 반드시 "0:00" 입니다. 타임스탬프는 자막에 있는 시각에서만 고릅니다.
- tags: 검색 노출용 태그 12개 이하. 한글 위주, 영어 키워드 1~2개.
- thumbnail_copy: 썸네일에 큰 글자로 박을 6~10자 후크 카피 1개.
- thumbnail_subcopy: 보조 카피 4~8자. 마땅한 게 없으면 빈 문자열.
- thumbnail_line1 / thumbnail_line2 / thumbnail_line3: 썸네일 이미지에 실제로
  얹을 문구를 줄 단위로 나눈 것. 한 줄에 공백 포함 7자를 절대 넘기지 마세요.
  line1 은 가장 강조되는 줄이라 반드시 채웁니다. line2 는 되도록 채우고,
  line3 는 꼭 필요할 때만 쓰고 아니면 빈 문자열로 둡니다.
  예: "1억으로" / "이런 집이" / ""

규칙:
- 영상에 실제 등장한 단어와 주제만 사용합니다. 자막에 없는 사실을 지어내지 않습니다.
- 특히 평수·가격·공법은 자막에서 들리지 않으면 비워 둡니다. 빈 항목은 설명글에서
  줄째로 빠지므로, 틀린 값을 넣는 것보다 비우는 편이 낫습니다.
- tags 안의 영어 키워드를 빼고 모든 출력은 한국어입니다.`;

const METADATA_SCHEMA = {
  type: "object",
  properties: {
    titles: { type: "array", items: { type: "string" } },
    one_liner: { type: "string" },
    intro: { type: "string" },
    spec: {
      type: "object",
      properties: {
        area_pyeong: { type: "string" },
        area_m2: { type: "string" },
        method: { type: "string" },
        composition: { type: "string" },
        price: { type: "string" },
      },
      required: ["area_pyeong", "area_m2", "method", "composition", "price"],
      additionalProperties: false,
    },
    chapters: {
      type: "array",
      items: {
        type: "object",
        properties: { time: { type: "string" }, title: { type: "string" } },
        required: ["time", "title"],
        additionalProperties: false,
      },
    },
    tags: { type: "array", items: { type: "string" } },
    thumbnail_copy: { type: "string" },
    thumbnail_subcopy: { type: "string" },
    thumbnail_line1: { type: "string" },
    thumbnail_line2: { type: "string" },
    thumbnail_line3: { type: "string" },
  },
  required: ["titles", "one_liner", "intro", "spec", "chapters", "tags",
             "thumbnail_copy", "thumbnail_subcopy",
             "thumbnail_line1", "thumbnail_line2", "thumbnail_line3"],
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
  const spec = data.spec && typeof data.spec === "object" ? data.spec : {};
  const chapters = (Array.isArray(data.chapters) ? data.chapters : [])
    .map((c) => ({ time: String(c?.time || "").trim(), title: String(c?.title || "").trim() }))
    .filter((c) => c.time && c.title)
    .slice(0, 10);
  return {
    titles: (Array.isArray(data.titles) ? data.titles : []).map(String).slice(0, 5),
    oneLiner: String(data.one_liner || "").trim(),
    intro: String(data.intro || "").trim(),
    spec: {
      areaPyeong: String(spec.area_pyeong || "").trim(),
      areaM2: String(spec.area_m2 || "").trim(),
      method: String(spec.method || "").trim(),
      composition: String(spec.composition || "").trim(),
      price: String(spec.price || "").trim(),
    },
    chapters,
    tags: (Array.isArray(data.tags) ? data.tags : []).map(String).slice(0, 12),
    thumbnailCopy: String(data.thumbnail_copy || ""),
    thumbnailSubcopy: String(data.thumbnail_subcopy || ""),
    // 썸네일에 얹을 줄. 7자 제한은 렌더러가 다시 확인한다 — 모델이 넘기면
    // 조용히 자르지 않고 카드 생성을 실패시키고 사진으로 올린다.
    thumbnailLine1: String(data.thumbnail_line1 || "").trim(),
    thumbnailLine2: String(data.thumbnail_line2 || "").trim(),
    thumbnailLine3: String(data.thumbnail_line3 || "").trim(),
  };
}

// ── 설명글 조립 ─────────────────────────────────────────────────────────────
//
// 템플릿은 채널 주인이 UI 에서 직접 고쳐 쓰는 문자열이다. 코드에 문구를 박아
// 두면 한 글자 고치는 데 배포가 필요해진다.
//
// 값이 비어 있을 때가 중요하다. 가격을 못 들었는데 "· 가격대 : " 처럼 빈 줄을
// 남기거나 "{가격}" 을 그대로 노출하면 그게 더 나쁘다. 그래서:
//   · 로 시작하는 항목 줄은 빈 값이 들어가면 줄째로 지운다
//   #해시태그 안에 빈 값이 있으면 그 태그만 지운다
//   그 밖에는 빈 문자열로 바꾸고, 마지막에 연속 빈 줄을 정리한다
export function fillDescriptionTemplate(template, vars) {
  const missing = new Set(
    Object.entries(vars).filter(([, v]) => !String(v ?? "").trim()).map(([k]) => k)
  );

  const isBullet = (l) => /^\s*[·•-]\s/.test(l);
  const isRule = (l) => /^[\s━─=_-]+$/.test(l) && l.trim().length > 2;
  const dropped = (l) => [...missing].some((k) => l.includes(`{${k}}`));

  // 1) 값이 빈 항목 줄을 버린다.
  const kept = String(template).split("\n").filter((l) => !(isBullet(l) && dropped(l)));

  // 2) 항목이 하나도 안 남은 소제목은 같이 버린다. "📍 이 집 정보" 만 덩그러니
  //    남고 그 아래가 비어 있으면 그게 더 이상해 보인다.
  const orig = String(template).split("\n");
  const headersToDrop = new Set();
  for (let i = 0; i < orig.length; i++) {
    if (!isBullet(orig[i])) continue;
    let j = i;
    while (j < orig.length && isBullet(orig[j])) j++;
    const block = orig.slice(i, j);
    if (block.every(dropped)) {
      // 블록 바로 위의 비어 있지 않은 줄이 소제목이면 그것도 지운다.
      for (let k = i - 1; k >= 0; k--) {
        if (!orig[k].trim()) continue;
        if (!isRule(orig[k])) headersToDrop.add(orig[k]);
        break;
      }
    }
    i = j;
  }
  const lines = kept.filter((l) => !headersToDrop.has(l));

  let out = lines.join("\n");
  // 빈 값이 낀 해시태그 제거 (#{평수}평주택 → 통째로).
  for (const k of missing) {
    out = out.replace(new RegExp(`#\\S*\\{${k}\\}\\S*\\s?`, "g"), "");
  }
  out = out.replace(/\{([^}]+)\}/g, (_, key) => String(vars[key] ?? "").trim());
  // 치환하면서 생긴 빈 줄 뭉치와, 사이 내용이 사라져 붙어 버린 구분선을 정리한다.
  return out
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^([\s━─=_-]{3,})(?:\n+[\s━─=_-]{3,})+$/gm, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// 템플릿에 넣을 값들. 채널 고정값(링크·이메일)은 호출자가 넘긴다.
export function descriptionVarsFrom(meta, channel = {}) {
  const ch = meta.chapters || [];
  return {
    한줄요약: meta.oneLiner || "",
    집소개: meta.intro || "",
    평수: meta.spec?.areaPyeong || "",
    제곱미터: meta.spec?.areaM2 || "",
    공법: meta.spec?.method || "",
    구성: meta.spec?.composition || "",
    가격: meta.spec?.price || "",
    // 첫 챕터는 템플릿에 "00:00 {챕터1}" 로 이미 시각이 박혀 있다.
    챕터1: ch[0]?.title || "",
    타임라인: ch.slice(1).map((c) => `${c.time} ${c.title}`).join("\n"),
    문의링크: channel.inquiryUrl || "",
    카탈로그링크: channel.catalogUrl || "",
    집번호: channel.houseNo || "",
    이메일: channel.email || "",
    인스타: channel.instagram || "",
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
    chapters.push({ time: formatTimestamp(t), title: String(seg.text).trim().slice(0, 30) });
  }

  return {
    titles,
    one_liner: firstLine.slice(0, 40),
    intro: top.length ? `${top.join(", ")} 에 대해 다룹니다.` : firstLine,
    // 휴리스틱은 자막 빈도만 본다 — 평수·가격 같은 값을 유추할 근거가 없으므로
    // 비워 둔다. 그러면 설명글에서 해당 줄이 통째로 빠진다.
    spec: { area_pyeong: "", area_m2: "", method: "", composition: "", price: "" },
    chapters,
    tags: keywords,
    thumbnail_copy: (top[0] || firstLine).slice(0, 10),
    thumbnail_subcopy: (top[1] || "").slice(0, 8),
    thumbnail_line1: (top[0] || firstLine).slice(0, 7),
    thumbnail_line2: (top[1] || "").slice(0, 7),
    thumbnail_line3: "",
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
