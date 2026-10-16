// 설정: 환경변수(.env 지원) → 기본값. 비밀번호/세션 비밀키가 없으면 data/secrets.json 에 무작위로 만들어 둔다.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const envFile = path.join(ROOT, '.env');
if (existsSync(envFile)) {
  try {
    process.loadEnvFile(envFile);
  } catch (e) {
    console.warn(`[config] .env 읽기 실패: ${e.message}`);
  }
}

export const DATA_DIR = path.resolve(ROOT, process.env.DATA_DIR || 'data');
mkdirSync(DATA_DIR, { recursive: true });

function loadSecrets() {
  const file = path.join(DATA_DIR, 'secrets.json');
  let saved = {};
  if (existsSync(file)) {
    try {
      saved = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      saved = {};
    }
  }
  const gen = (n = 6) => randomBytes(n).toString('base64url');
  const next = {
    adultPassword: saved.adultPassword || gen(6),
    adminPassword: saved.adminPassword || gen(9),
    sessionSecret: saved.sessionSecret || randomBytes(32).toString('hex'),
  };
  // 이번 실행에서 새로 만든 값 — 서버는 이때만 비밀번호를 콘솔에 보여주고, 그 뒤로는 파일 위치만 알려준다
  const created = { adult: !saved.adultPassword, admin: !saved.adminPassword };
  if (JSON.stringify(next) !== JSON.stringify(saved)) {
    writeFileSync(file, JSON.stringify(next, null, 2));
  }
  return { ...next, file, created };
}

const secrets = loadSecrets();
const num = (v, d) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
const list = (v) =>
  String(v || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

export const config = {
  siteName: process.env.SITE_NAME || '심심풀이',
  port: num(process.env.PORT, 3000),
  host: process.env.HOST || '127.0.0.1',

  // 잠금 게시판(므흣) / 관리자 비밀번호 — 환경변수가 우선, 없으면 data/secrets.json
  adultPassword: process.env.ADULT_PASSWORD || secrets.adultPassword,
  adminPassword: process.env.ADMIN_PASSWORD || secrets.adminPassword,
  sessionSecret: process.env.SESSION_SECRET || secrets.sessionSecret,
  secretsFile: secrets.file,
  passwordsFromEnv: { adult: !!process.env.ADULT_PASSWORD, admin: !!process.env.ADMIN_PASSWORD },
  // secrets.json 에 비밀번호를 이번 실행에서 새로 만들었는지 (처음 실행)
  secretsCreated: secrets.created,

  // 리버스 프록시: 어느 프록시의 X-Forwarded-For / X-Forwarded-Proto 를 믿을지 (express 'trust proxy' 값).
  // 같은 컴퓨터의 프록시면 기본값 그대로, 도커·NAS 등 다른 주소면 예: TRUST_PROXY=loopback,172.16.0.0/12
  trustProxy: process.env.TRUST_PROXY || 'loopback',
  // 인증 쿠키 Secure 속성: 비우면 HTTPS 요청(req.secure)일 때만, 1 이면 항상, 0 이면 붙이지 않음
  cookieSecure: process.env.COOKIE_SECURE === '1' ? true : process.env.COOKIE_SECURE === '0' ? false : null,

  // 이미지/영상 프록시 남용 방지
  imgProxy: {
    perMin: num(process.env.IMG_RATE_PER_MIN, 600), // IP 당 분당 요청 수
    maxConcurrent: num(process.env.IMG_MAX_CONCURRENT, 64), // 서버 전체 동시 연결
    maxConcurrentPerIp: num(process.env.IMG_MAX_CONCURRENT_PER_IP, 16), // IP 당 동시 연결
    maxBytes: num(process.env.IMG_MAX_BYTES, 80 * 1024 * 1024), // 응답 하나의 최대 크기
  },

  // 수집
  crawlIntervalMin: num(process.env.CRAWL_INTERVAL_MIN, 15), // 0 이면 자동 수집 끔
  pagesPerSource: num(process.env.PAGES_PER_SOURCE, 2),
  retentionDays: num(process.env.RETENTION_DAYS, 14), // 쇼츠 후보로 지정한 글은 지우지 않음
  enabledSources: list(process.env.SOURCES), // 비우면 disabled 가 아닌 전부
  disabledSources: list(process.env.DISABLE_SOURCES),

  // Claude 검수: ANTHROPIC_API_KEY 가 있으면 자동으로 켜짐 (AI_MODERATION=0 으로 끄기, =1 로 강제 켜기).
  // 켜져 있으면 새 글은 Claude 판정을 통과한 뒤에 공개 목록에 나온다.
  ai: {
    enabled:
      process.env.AI_MODERATION === '1' ||
      (process.env.AI_MODERATION !== '0' && !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN)),
    model: process.env.AI_MODEL || 'claude-opus-5-5',
    effort: process.env.AI_EFFORT || 'low',
    batchSize: num(process.env.AI_BATCH_SIZE, 40),
    // Claude 호출이 계속 실패할 때, 이 시간(분)이 지나면 키워드 판정만으로 공개
    pendingMaxMin: num(process.env.AI_PENDING_MAX_MIN, 60),
    // 수집 1회에 Claude 에 보내는 최대 글 수 (밀린 글이 많아도 수집이 길어지지 않게)
    maxPerRun: num(process.env.AI_MAX_PER_RUN, 200),
    // 한 글을 판정 실패로 다시 보내는 최대 횟수 (그 뒤로는 키워드 판정만 쓰고 검수 대기열(/api/admin/review-queue)에 남김)
    maxTries: num(process.env.AI_MAX_TRIES, 6),
  },

  // 공개 사이트(Cloudflare Worker)로 올리기 (src/publish.js, worker/CONTRACT.md). PUBLISH_URL·PUBLISH_TOKEN 이 둘 다 있을 때만 켜짐.
  publish: publishConfig(),
};

/**
 * 공개 사이트 업로드 설정. 주소는 https 만(이 컴퓨터 안의 시험용 주소는 http 허용) — 토큰이 평문으로 나가지 않게.
 * 테스트(node --test) 안에서는 이 컴퓨터 안의 주소로만 올린다: .env 에 진짜 주소가 있어도 시험 데이터가 공개 사이트에 올라가지 않게.
 */
function publishConfig() {
  const raw = String(process.env.PUBLISH_URL || '').trim();
  const token = String(process.env.PUBLISH_TOKEN || '').trim();
  const out = {
    url: '',
    token,
    enabled: false,
    error: null, // 켜려고 했지만 설정이 잘못된 경우의 설명
    readLimit: Math.max(0, Math.min(500, Math.floor(num(process.env.PUBLISH_READ_LIMIT, 40)))), // 한 번에 새로 만들 미리보기 수
    debounceMs: Math.max(0, num(process.env.PUBLISH_DEBOUNCE_SEC, 30)) * 1000, // 관리자 변경 뒤 이 시간 안에 한 번 올림
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
  if (process.env.NODE_TEST_CONTEXT && !local) return { ...out, error: '테스트 중에는 공개 사이트로 올리지 않아요' };
  out.enabled = true;
  return out;
}
