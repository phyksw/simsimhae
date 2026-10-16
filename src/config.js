// 설정: 환경변수 → 기본값. 로컬(Node)과 Cloudflare(Durable Object) 양쪽에서 같은 모듈을 쓴다.
// - 로컬: src/platform/node.js 가 .env 를 읽고, 비밀번호/세션 비밀키가 없으면 data/secrets.json 에 무작위로 만들어 둔다.
// - 클라우드: worker/site.js 가 configure(env, { mode: 'cloud' }) 로 Worker 변수·비밀을 넣는다. 비밀은 만들지 않는다(없으면 로그인 503).
// config 객체는 하나뿐이고 configure 가 그 안을 바꾼다 — 다른 모듈은 import 한 config 를 그대로 읽으면 된다.
import * as platform from '#platform';

/** 프로젝트 폴더·데이터 폴더 (로컬에서만. 클라우드는 null) */
export const ROOT = platform.ROOT;
export const DATA_DIR = platform.DATA_DIR;

const num = (v, d) => (v !== undefined && v !== null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
const list = (v) =>
  String(v || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/** @type {Record<string, any>} */
export const config = {};

/**
 * 설정을 (다시) 만든다.
 * @param {Record<string, string|undefined>} env 환경변수 (로컬 process.env, 클라우드 Worker env 바인딩)
 * @param {{mode?: 'local'|'cloud'}} [opts]
 */
export function configure(env = {}, { mode = 'local' } = {}) {
  const e = (k) => {
    const v = env?.[k];
    return typeof v === 'string' ? v : v == null ? undefined : String(v);
  };
  const cloud = mode === 'cloud';
  // 로컬은 환경변수가 없으면 data/secrets.json 의 값을, 클라우드는 Worker 비밀만 쓴다
  const file = !cloud && platform.secrets ? platform.secrets : null;
  const pick = (name, fileKey) => e(name) || (file ? file[fileKey] : '') || '';
  const next = {
    mode,
    siteName: e('SITE_NAME') || '심심풀이',
    port: num(e('PORT'), 3000),
    host: e('HOST') || '127.0.0.1',

    // 잠금 게시판(므흣) / 관리자 비밀번호 / 쿠키 서명 비밀
    adultPassword: pick('ADULT_PASSWORD', 'adultPassword'),
    adminPassword: pick('ADMIN_PASSWORD', 'adminPassword'),
    sessionSecret: pick('SESSION_SECRET', 'sessionSecret'),
    secretsFile: file?.file ?? null,
    passwordsFromEnv: { adult: !!e('ADULT_PASSWORD'), admin: !!e('ADMIN_PASSWORD') },
    // secrets.json 에 비밀번호를 이번 실행에서 새로 만들었는지 (처음 실행)
    secretsCreated: file?.created ?? { adult: false, admin: false },
    // 클라우드에서 설정되지 않은 비밀 (있으면 그 비밀이 필요한 로그인·잠금 해제는 503)
    secretsMissing: cloud ? ['ADMIN_PASSWORD', 'ADULT_PASSWORD', 'SESSION_SECRET'].filter((k) => !e(k)) : [],

    // 리버스 프록시: 어느 프록시의 X-Forwarded-For / X-Forwarded-Proto 를 믿을지 (express 'trust proxy' 값).
    // 같은 컴퓨터의 프록시면 기본값 그대로, 도커·NAS 등 다른 주소면 예: TRUST_PROXY=loopback,172.16.0.0/12
    trustProxy: e('TRUST_PROXY') || 'loopback',
    // 인증 쿠키 Secure 속성: 비우면 HTTPS 요청(req.secure)일 때만, 1 이면 항상, 0 이면 붙이지 않음. 클라우드는 기본이 항상.
    cookieSecure: e('COOKIE_SECURE') === '1' ? true : e('COOKIE_SECURE') === '0' ? false : cloud ? true : null,

    // 이미지/영상 프록시 남용 방지
    imgProxy: {
      perMin: num(e('IMG_RATE_PER_MIN'), 600), // IP 당 분당 요청 수
      maxConcurrent: num(e('IMG_MAX_CONCURRENT'), 64), // 서버 전체 동시 연결
      maxConcurrentPerIp: num(e('IMG_MAX_CONCURRENT_PER_IP'), 16), // IP 당 동시 연결
      maxBytes: num(e('IMG_MAX_BYTES'), 80 * 1024 * 1024), // 응답 하나의 최대 크기
    },

    // 수집
    crawlIntervalMin: num(e('CRAWL_INTERVAL_MIN'), 15), // 0 이면 자동 수집 끔 (관리자 화면에서 켤 수 있음)
    pagesPerSource: num(e('PAGES_PER_SOURCE'), 2),
    retentionDays: num(e('RETENTION_DAYS'), 14), // 쇼츠 후보로 지정한 글은 지우지 않음
    enabledSources: list(e('SOURCES')), // 비우면 disabled 가 아닌 전부
    disabledSources: list(e('DISABLE_SOURCES')),
    // 출처 하나의 목록 수집에 쓰는 최대 시간(초). 넘으면 그 출처만 '시간 초과'로 두고 나머지 출처의 결과로 수집을 끝낸다 (0 이면 제한 없음)
    crawlSourceBudgetMs: Math.max(0, num(e('CRAWL_SOURCE_BUDGET_SEC'), 120)) * 1000,
    // 미리보기가 같은 사이트 요청 간격 대기열에서 기다리는 최대 시간(초). 넘을 것 같으면 기다리지 않고 원문 주소를 준다 (0 이면 제한 없음)
    previewMaxWaitMs: Math.max(0, num(e('PREVIEW_MAX_WAIT_SEC'), 20)) * 1000,

    // Claude 검수: ANTHROPIC_API_KEY 가 있으면 자동으로 켜짐 (AI_MODERATION=0 으로 끄기, =1 로 강제 켜기).
    // 켜져 있으면 새 글은 Claude 판정을 통과한 뒤에 공개 목록에 나온다.
    ai: {
      enabled: e('AI_MODERATION') === '1' || (e('AI_MODERATION') !== '0' && !!(e('ANTHROPIC_API_KEY') || e('ANTHROPIC_AUTH_TOKEN'))),
      // 비우면 SDK 가 process.env 에서 찾는다 (로컬). 클라우드는 Worker 비밀을 넘긴다.
      apiKey: e('ANTHROPIC_API_KEY') || null,
      baseURL: e('ANTHROPIC_BASE_URL') || null,
      model: e('AI_MODEL') || 'claude-opus-5-5',
      effort: e('AI_EFFORT') || 'low',
      batchSize: num(e('AI_BATCH_SIZE'), 40),
      // Claude 호출이 계속 실패할 때, 이 시간(분)이 지나면 키워드 판정만으로 공개
      pendingMaxMin: num(e('AI_PENDING_MAX_MIN'), 60),
      // 수집 1회에 Claude 에 보내는 최대 글 수 (밀린 글이 많아도 수집이 길어지지 않게)
      maxPerRun: num(e('AI_MAX_PER_RUN'), 200),
      // 한 글을 판정 실패로 다시 보내는 최대 횟수 (그 뒤로는 키워드 판정만 쓰고 검수 대기열(/api/admin/review-queue)에 남김)
      maxTries: num(e('AI_MAX_TRIES'), 6),
    },

    // 클라우드(SiteDO) 전용
    cloud: {
      // 미리보기(원문에서 가져와 정리한 본문)를 DO 저장소에 두는 시간
      readCacheHours: Math.max(1, num(e('READ_CACHE_HOURS'), 12)),
      // 알람(수집) 한 번에 미리 준비하는 미리보기 수 (소소한 이야기 → 웃긴 것만 순, 0 이면 안 함)
      prefetchPerRun: Math.max(0, Math.min(100, Math.floor(num(e('PREFETCH_PER_RUN'), 12)))),
      // 알람 한 번의 출처 사이트 요청 상한 (Workers 의 하위 요청 한도 1000 아래로)
      requestBudget: Math.max(50, Math.min(950, Math.floor(num(e('CRAWL_REQUEST_BUDGET'), 800)))),
    },

    // 공개 사이트(Cloudflare Worker)로 올리기 (src/publish.js, worker/CONTRACT.md). 로컬 전용 — 클라우드에서는 늘 꺼짐.
    publish: cloud ? publishOff() : publishConfig(e),
  };
  for (const k of Object.keys(config)) if (!(k in next)) delete config[k];
  Object.assign(config, next);
  return config;
}

function publishOff() {
  return { url: '', token: '', enabled: false, error: null, readLimit: 0, debounceMs: 0 };
}

/**
 * 공개 사이트 업로드 설정. 주소는 https 만(이 컴퓨터 안의 시험용 주소는 http 허용) — 토큰이 평문으로 나가지 않게.
 * 테스트(node --test) 안에서는 이 컴퓨터 안의 주소로만 올린다: .env 에 진짜 주소가 있어도 시험 데이터가 공개 사이트에 올라가지 않게.
 */
function publishConfig(e) {
  const raw = String(e('PUBLISH_URL') || '').trim();
  const token = String(e('PUBLISH_TOKEN') || '').trim();
  const out = {
    url: '',
    token,
    enabled: false,
    error: null, // 켜려고 했지만 설정이 잘못된 경우의 설명
    readLimit: Math.max(0, Math.min(500, Math.floor(num(e('PUBLISH_READ_LIMIT'), 40)))), // 한 번에 새로 만들 미리보기 수
    debounceMs: Math.max(0, num(e('PUBLISH_DEBOUNCE_SEC'), 30)) * 1000, // 관리자 변경 뒤 이 시간 안에 한 번 올림
  };
  if (!raw) return token ? { ...out, error: 'PUBLISH_URL 이 비어 있어요' } : out;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return { ...out, error: 'PUBLISH_URL 주소 형식이 잘못됐어요' };
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return { ...out, error: 'PUBLISH_URL 은 https:// 주소여야 해요' };
  if (u.username || u.password || u.search || u.hash) return { ...out, error: 'PUBLISH_URL 에는 주소만 넣어 주세요 (토큰은 PUBLISH_TOKEN 에)' };
  out.url = `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
  if (!token) return { ...out, error: 'PUBLISH_TOKEN 이 비어 있어요' };
  if (e('NODE_TEST_CONTEXT') && !local) return { ...out, error: '테스트 중에는 공개 사이트로 올리지 않아요' };
  out.enabled = true;
  return out;
}

configure(platform.env, { mode: platform.kind === 'node' ? 'local' : 'cloud' });
