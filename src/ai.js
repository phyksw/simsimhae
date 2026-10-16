// Claude 검수: 새 글 제목을 묶음으로 보내 분류(정상/정치/혐오/사건사고/므흣/유머아님)와 쇼츠 적합도를 받는다.
// ANTHROPIC_API_KEY 가 있을 때만 켜진다 (config.ai.enabled).
import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';

const VERDICTS = ['ok', 'politics', 'hate', 'dark', 'adult', 'not_humor'];

// 서버 측 거절 대체(fallbacks)를 지원하는 모델
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-sonnet-5-5']);

export const SYSTEM = `너는 한국 커뮤니티 유머글 모음 사이트 "심심풀이"의 검수자다. 운영자는 여기서 고른 글을 읽어주며 반응하는 유튜브 쇼츠를 만든다.
운영자가 원하는 건 쇼츠 유머처럼 **맥락 없이 누구나 그냥 웃을 수 있는 글**이다. 예: "충청도인이 겪은 역대급 충청도식 프로포즈",
"작가와 독자의 기싸움 레전드썰", "일본사람이 물어보고 싶었던 한국 표현", "나 우울해서 화분 샀어에 대한 T의 대답", "순대국집에서 직장 상사를 만난 사람".
각 글의 [출처]·[말머리]·제목(본문 발췌가 있으면 그것까지)을 보고 판정한다.

verdict (하나만):
- "ok": 웃기려고 쓴 글. 썰·대화/카톡/댓글 캡처·드립·반전·황당한 일상·동물·사투리·외국인 반응·말장난처럼 웃음이 목적인 글.
- "politics": 정치인·정당·선거·정책·진영 갈등·시사 논쟁. 정치인을 소재로 한 밈·조롱도 포함.
- "hate": 성별·지역·세대·인종·국적·종교·장애 비하나 갈등 조장, 특정 집단 일반화·조롱("요즘 여자들은~", "한남/한녀", 지역 멸칭 등), 일베식 표현, 국뽕/혐한 갈등 유도.
- "dark": 사망·살인·자살·성범죄·학대·참사 등 무거운 사건사고, 혐오감을 주는 사고 영상.
- "adult": 후방주의·노출·선정적인 사진/내용, 성적인 농담이 중심인 글 (가벼운 연애 이야기는 ok).
- "not_humor": 웃음이 목적이 아닌 글 — 뉴스·이슈·사회 문제·경제/주식·연예인 가십과 논란·연예인/코스어 사진·스포츠 기록·
  정보/지식·제품·게임 소식·감동/진지한 사연·질문·광고·핫딜·공지. "근황", "이유" 가 붙어도 내용이 이슈·정보면 not_humor.
애매하면 더 보수적인 쪽으로 판정한다. 사투리·지역 특색을 다룬 유쾌한 글은 비하가 아니면 ok 다.

shortsScore (0~100): 쇼츠 예시처럼 "그냥 웃긴" 정도. 읽어주며 반응하기 좋은지.
- 85~100: 제목만 봐도 웃기고, 썰·대화·댓글 반응이라 말로 풀기 딱 좋음.
- 65~84: 웃길 가능성이 높은 유머글.
- 40~64: 유머이긴 한데 약하거나, 영상·움짤 위주라 읽어주기 애매함.
- 0~39: 웃음 포인트가 거의 없음. verdict 가 ok 가 아니면 0.

vibe (0~100): 위 쇼츠 예시 3개와 얼마나 같은 분위기인지. 형식과 톤을 둘 다 본다.
형식: 글자(썰·대화·댓글·질문과 답·사투리·외국인 반응·한국어 표현)를 읽어주는 것만으로 웃긴 글.
톤: 예시처럼 가볍고 훈훈하고 누구나 편하게 웃는 글 — 귀여운 착각, 재치 있는 말싸움, 문화·언어 호기심, 엉뚱한 일상.
- 80~100: 형식과 톤이 모두 예시와 같음.
- 50~79: 형식은 맞지만 톤이 조금 다르거나(살짝 매운 드립), 짧은 말장난·짤 한 장.
- 0~49: 사진·영상이 웃음 포인트이거나, 톤이 다른 글 — 분노·짜증·하소연·욕설이 중심, 연봉·돈·결혼·이혼·친자·불륜·연애 갈등,
  남녀를 나눠 비교·일반화, 군대·전쟁·종교·질병·사고 같은 무거운 소재, 감동 실화·진지한 사연, 특정 커뮤니티 내부 밈. verdict 가 ok 가 아니면 0.

reason: 한국어 15자 이내 짧은 근거.`;

const SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          i: { type: 'integer' },
          verdict: { type: 'string', enum: VERDICTS },
          shortsScore: { type: 'integer' },
          vibe: { type: 'integer' },
          reason: { type: 'string' },
        },
        required: ['i', 'verdict', 'shortsScore', 'vibe', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
};

let client = null;
function getClient() {
  // 재시도는 SDK 안에서 한 번만 (429·5xx 가 이어지면 이번 수집은 접고 다음 수집 때 다시 보낸다)
  if (!client) client = new Anthropic({ maxRetries: 1, timeout: 120e3 });
  return client;
}

let lastError = null;
export const aiStatus = () => ({ enabled: config.ai.enabled, model: config.ai.model, lastError });

/**
 * @param {Array<{title: string, category?: string|null, sourceName: string}>} posts
 * @returns {Promise<Array<{verdict: string, shortsScore: number, reason: string}|null>>} 입력과 같은 순서
 */
async function classifyBatch(posts) {
  const lines = posts.map((p, i) => `${i}. [${p.sourceName}]${p.category ? `[${p.category}]` : ''} ${p.title}`).join('\n');
  const params = {
    model: config.ai.model,
    max_tokens: 16000,
    system: SYSTEM,
    output_config: {
      effort: config.ai.effort,
      format: { type: 'json_schema', schema: SCHEMA },
    },
    messages: [{ role: 'user', content: `다음 ${posts.length}개 글을 판정해 items 에 i 순서대로 모두 담아라.\n\n${lines}` }],
  };
  const useFallback = FALLBACK_MODELS.has(config.ai.model);
  const res = useFallback
    ? await getClient().beta.messages.create({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
    : await getClient().messages.create(params);

  if (res.stop_reason === 'refusal') {
    throw new Error(`Claude 가 판정을 거절함 (${res.stop_details?.category ?? '사유 없음'})`);
  }
  if (res.stop_reason === 'max_tokens') throw new Error('응답이 max_tokens 에서 잘림');
  const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const parsed = JSON.parse(text);
  const out = new Array(posts.length).fill(null);
  for (const it of parsed.items || []) {
    if (Number.isInteger(it.i) && it.i >= 0 && it.i < posts.length && VERDICTS.includes(it.verdict)) {
      out[it.i] = {
        verdict: it.verdict,
        shortsScore: Math.max(0, Math.min(100, Math.round(Number(it.shortsScore) || 0))),
        vibe: Math.max(0, Math.min(100, Math.round(Number(it.vibe) || 0))),
        reason: String(it.reason || '').slice(0, 60),
      };
    }
  }
  return out;
}

function describeError(e) {
  return e instanceof Anthropic.AuthenticationError
    ? 'API 키가 올바르지 않음'
    : e instanceof Anthropic.PermissionDeniedError
      ? 'API 권한 없음'
      : e instanceof Anthropic.RateLimitError
        ? '요청 한도 초과 (다음 수집 때 재시도)'
        : e instanceof Anthropic.APIConnectionError
          ? `연결 실패: ${e.message}`
          : e instanceof Anthropic.APIError
            ? `API 오류 ${e.status ?? ''}: ${e.message}`
            : e.message;
}

/** 이번 실행의 나머지를 모두 접어야 하는 오류 (키·권한·한도·서버·연결 문제 — 다른 묶음도 똑같이 실패한다) */
class StopRun extends Error {
  constructor(cause, countAsTry) {
    super(cause.message);
    this.cause = cause;
    /** 보낸 묶음을 "판정 실패 1회"로 셀지. 400 같은 요청 오류는 특정 글 때문일 수 있어 센다 */
    this.countAsTry = countAsTry;
  }
}

function asStopRun(e) {
  if (!(e instanceof Anthropic.APIError)) return null; // 거절·잘림·JSON 오류 등은 이 묶음만의 문제
  const transient =
    e instanceof Anthropic.AuthenticationError ||
    e instanceof Anthropic.PermissionDeniedError ||
    e instanceof Anthropic.NotFoundError ||
    e instanceof Anthropic.RateLimitError ||
    e instanceof Anthropic.APIConnectionError ||
    e instanceof Anthropic.InternalServerError ||
    !e.status ||
    e.status >= 500;
  return new StopRun(e, !transient);
}

/**
 * 한 묶음 판정. 이 묶음만의 실패(거절·잘림·JSON 오류)면 반으로 나눠 다시 보내 문제 글만 null 로 남긴다.
 * 실행 전체를 접어야 하는 오류는 StopRun 으로 던진다.
 */
async function classifyChunk(chunk) {
  try {
    const out = await classifyBatch(chunk);
    lastError = null;
    return out;
  } catch (e) {
    const stop = asStopRun(e);
    lastError = { message: describeError(e), at: new Date().toISOString() };
    console.warn(`[ai] 판정 실패 (${chunk.length}개): ${lastError.message}`);
    if (stop) throw stop;
    if (chunk.length <= 1) return chunk.map(() => null);
    const mid = Math.ceil(chunk.length / 2);
    const left = await classifyChunk(chunk.slice(0, mid));
    const right = await classifyChunk(chunk.slice(mid));
    return [...left, ...right];
  }
}

/**
 * 여러 글을 batchSize 씩 나눠 판정한다. 결과는 입력과 같은 순서이고, 각 칸은
 *   - 판정 결과: 성공
 *   - null: 보냈지만 이 글의 판정을 받지 못함 (호출 측이 실패 횟수로 센다)
 *   - undefined: 이번에는 보내지 않음 (키·한도·서버 문제로 실행을 접음 — 실패 횟수로 세지 않는다)
 * @template T
 * @param {Array<T & {title: string, category?: string|null, sourceName: string}>} posts
 * @returns {Promise<Array<{verdict: string, shortsScore: number, reason: string}|null|undefined>>}
 */
export async function classifyPosts(posts) {
  if (!config.ai.enabled || !posts.length) return posts.map(() => undefined);
  const results = new Array(posts.length).fill(undefined);
  const size = Math.max(1, config.ai.batchSize);
  for (let i = 0; i < posts.length; i += size) {
    const chunk = posts.slice(i, i + size);
    try {
      const out = await classifyChunk(chunk);
      out.forEach((r, j) => (results[i + j] = r));
    } catch (e) {
      if (!(e instanceof StopRun)) throw e;
      // 이 묶음은 요청 오류(400 등)일 때만 실패로 세고, 나머지 묶음은 보내지 않은 채로 둔다
      if (e.countAsTry) chunk.forEach((_, j) => (results[i + j] = null));
      break;
    }
  }
  return results;
}
