// Claude 검수: 새 글 제목을 묶음으로 보내 분류(정상/정치/혐오/사건사고/므흣/유머아님)와 쇼츠 적합도를 받는다.
// ANTHROPIC_API_KEY 가 있을 때만 켜진다 (config.ai.enabled).
import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';

const VERDICTS = ['ok', 'politics', 'hate', 'dark', 'adult', 'not_humor'];

// 서버 측 거절 대체(fallbacks)를 지원하는 모델
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-sonnet-5-5']);

/**
 * 판정 기준: src/model/STYLE.md §7 의 문장 그대로 (운영자 PC 의 Claude 가 읽는 review/INSTRUCTIONS.md 도 같은 문장을 쓴다 —
 * test/pc-routine.test.js 가 셋이 같은지 본다). scripts/pc-routine.js 가 STYLE.md 가 없을 때 이 두 상수를 정규식으로 읽으므로 한 덩어리 문자열로 둔다.
 *
 * 고치면 새로 들어오는 글부터 새 기준으로 판정된다. 이미 판정된 글(p.ai 가 있는 글)은 기준·모델이 바뀌어도 다시 보내지 않는다:
 * Claude 에 보내는 건 aiPending 인 글(새 글·제목이 바뀐 글)뿐이고, 판정 대기열(/api/admin/review-queue)도 p.ai 가 없는 글만 준다.
 * 규칙 재판정(src/rejudge.js)은 키워드 판정만 다시 하고 p.ai 는 건드리지 않으며, 그 지문(rulesFingerprint)에 이 파일은 들어가지 않는다.
 */
export const CRITERIA = `이 글을 쇼츠에서 화면에 띄워 읽어주며 반응하기 좋은지 판정한다. 통과하려면 모두 만족해야 한다.
① 글자(캡처·대화·댓글·리뷰·짧은 썰·질문과 답)만 읽어도 웃기거나 "아, 그래서 그렇구나" 하는 반전·호기심이 생긴다. 사진·영상이 웃음의 전부면 낮게 준다.
② 30~60초 안에 읽힌다(캡처 1~3장, 대화 몇 줄). 긴 썰은 낮게 준다.
③ 앞뒤 맥락이나 특정 커뮤니티 밈 없이 누구나 이해한다.
④ 소재가 다음 중 하나다: 외국인·한국어·문화 차이, 사투리·지역 화법, 말장난·맞춤법·이름, 가족·친구 대화, 알바·손님·사장님·택배, 직장 신입·학교·교수, 당근·배달 리뷰와 사장님 답글, 동물, 작가·독자·애니·게임 뒷이야기, 음식·물건·장소의 "의외의 이유".
⑤ 등장인물이 모두 귀엽거나 어이없는 정도이고, 누가 혼나거나 당하는 구도가 아니다.
하나라도 해당하면 탈락: 성적 농담·외모 평가, 남녀·세대·지역을 묶은 비교·일반화, 연애·결혼 갈등(바람·이혼·친자·전 애인·헤어짐), 돈 다툼, 분노·하소연·욕설, 참교육·사이다·복수, 정치·사건사고·죽음·질병·범죄, 연예인 가십·논란·이슈 근황, 건강·재테크 정보글.
웃음 대신 "신기한 이유"로 끝나는 가벼운 잡학은 통과시킨다. 애매하면 탈락시킨다.`;

/** vibe 점수표: STYLE.md §7 의 표 그대로 */
export const VIBE_TABLE = `- 85~100: ④ 소재 + ⑤ 톤 + 글로 완결. "~한 ~" 쇼츠 제목이 바로 떠오른다
- 70~84: 궤 안이지만 조금 길거나, 사진에 일부 기대거나, 웃음이 약하다
- 50~69: 무해하지만 궤 밖 소재이거나, 살짝 매운 드립이다
- 0~49: 탈락 조건에 하나라도 걸린다`;

export const SYSTEM = `너는 한국 커뮤니티 유머글 모음 사이트 "브루잉"의 검수자다. 운영자는 여기서 고른 글을 화면에 띄워 읽어주며 반응하는 유튜브 쇼츠를 만든다.
기준 쇼츠: "충청도인이 겪은 역대급 충청도식 프로포즈"(사투리·돌려 말하기), "작가와 독자의 기싸움 레전드썰"(재치 있는 말싸움),
"일본사람이 물어보고 싶었던 한국 표현"(언어·문화 호기심). 한 줄로: 평범한 사람이 겪은 작은 엇박자(착각·문화 차이·말의 재미·의외의 이유)를,
캡처 한두 장 분량으로, 아무도 다치지 않게.
각 글의 [출처]·[말머리]·제목(본문 발췌가 있으면 그것까지)을 보고 판정한다. 제목만 있으면 제목으로 짐작하되, 애매하면 보수적으로 판정한다.

판정 기준:
${CRITERIA}

verdict (하나만, 글의 종류):
- "ok": 웃기려고 쓴 글(썰·대화/카톡/댓글 캡처·드립·반전·황당한 일상·동물·사투리·외국인 반응·말장난), 그리고
  웃음 대신 "신기한 이유"로 끝나는 가벼운 잡학(음식·물건·장소·지명의 의외의 이유, 한국어 표현의 속뜻, 신기한 동물·물건). "…인 이유", "의외로 …", "…의 정체" 같은 글이 여기에 든다.
- "politics": 정치인·정당·선거·정책·진영 갈등·시사 논쟁. 정치인을 소재로 한 밈·조롱도 포함.
- "hate": 성별·지역·세대·인종·국적·종교·장애 비하나 갈등 조장, 특정 집단을 깎아내리는 일반화·조롱("요즘 여자들은~", "한남/한녀", 지역 멸칭 등), 일베식 표현, 국뽕/혐한 갈등 유도.
- "dark": 사망·살인·자살·성범죄·성희롱·성추행·학대·학교폭력·스토킹·참사 등 무거운 사건사고, 질병·투병, 혐오감을 주는 사고 영상.
- "adult": 후방주의·노출·선정적인 사진/내용, 성적인 농담이 중심인 글.
- "not_humor": 웃음도 "신기한 이유"도 없는 글 — 뉴스·이슈·사회 문제·경제/주식·연예인 가십과 논란·이슈 근황·연예인/코스어 사진·스포츠 기록·
  건강·재테크·꿀팁 정보글·제품·홍보·게임 소식·감동/진지한 사연·질문·광고·핫딜·공지. "근황", "이유" 가 붙어도 내용이 이슈·정보면 not_humor.
위 탈락 조건 중 종류로 나뉘지 않는 것(외모 평가, 비하 없는 남녀·세대 비교, 연애·결혼 갈등, 돈 다툼, 분노·하소연·욕설, 참교육·사이다·복수)은
웃기려고 쓴 글이면 verdict 를 "ok" 로 두고 아래 두 점수를 낮춘다. 사투리·지역 특색을 다룬 유쾌한 글은 비하가 아니면 ok 다.

shortsScore (0~100): "그냥 웃긴" 정도. 읽어주며 반응하기 좋은지.
- 85~100: 제목만 봐도 웃기고, 썰·대화·댓글 반응이라 말로 풀기 딱 좋음.
- 65~84: 웃길 가능성이 높은 유머글.
- 40~64: 유머이긴 한데 약하거나, 영상·움짤 위주라 읽어주기 애매함.
- 0~39: 웃음 포인트가 거의 없음.
"신기한 이유"로 끝나는 잡학은 신기한 정도를 웃긴 정도로 쳐서 매긴다(가볍게 신기하면 55~70). 탈락 조건에 하나라도 걸리면 40 이하. verdict 가 ok 가 아니면 0.

vibe (0~100): 위 판정 기준(①~⑤와 탈락 조건)에 맞는 정도.
${VIBE_TABLE}
애매하면 69 이하로 둔다(통과시키지 않는다). verdict 가 ok 가 아니면 0.

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
let clientFor = null;
function getClient() {
  // 키·주소는 설정에서 (클라우드는 Worker 비밀을 configure 로 넣는다). 비어 있으면 SDK 가 환경변수에서 찾는다.
  const key = `${config.ai.apiKey || ''}
${config.ai.baseURL || ''}`;
  if (!client || clientFor !== key) {
    // 재시도는 SDK 안에서 한 번만 (429·5xx 가 이어지면 이번 수집은 접고 다음 수집 때 다시 보낸다)
    client = new Anthropic({
      ...(config.ai.apiKey ? { apiKey: config.ai.apiKey } : {}),
      ...(config.ai.baseURL ? { baseURL: config.ai.baseURL } : {}),
      maxRetries: 1,
      timeout: 120e3,
    });
    clientFor = key;
  }
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
