// 내 컴퓨터의 데이터(data/posts.json 의 글·출처 상태·설정 + data/custom-rules.json 금지어)를 클라우드 사이트로 옮긴다.
// 클라우드의 상태는 통째로 바뀐다 (그 전에 클라우드에 모인 글은 사라짐). 관리자 비밀번호로 로그인해서 올린다.
//
// 사용법: node scripts/push-to-cloud.js <사이트 주소> [--data <폴더>] [--yes] [--chunk-mb 2]
//   예:   node scripts/push-to-cloud.js https://simsimhae.board.workers.dev
//   비밀번호: 환경변수 CLOUD_ADMIN_PASSWORD 가 있으면 그것을, 없으면 물어본다 (화면에 보이지 않게). Worker 비밀 ADMIN_PASSWORD 와 같은 값.
//   --data: 데이터 폴더 (기본: 환경변수 DATA_DIR 또는 data)
//   --yes:  확인 질문 없이 바로
//   --chunk-mb: 한 번에 올리는 글 묶음 크기 (기본 2, 최대 3 — 클라우드는 한 요청에 4MB 까지 받는다)
//   사이트가 다른 주소로 보내면(리다이렉트) 따라가지 않고 멈춘다 (비밀번호가 다른 곳으로 나가지 않게)
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REQUEST_TIMEOUT_MS = 120e3;
/** 한 번에 올리는 글 묶음 크기 (MB): 기본·최대. 클라우드가 받는 한 요청의 상한(worker/site.js IMPORT_MAX_BYTES, 4MB)보다 작게 */
export const CHUNK_MB_DEFAULT = 2;
export const CHUNK_MB_MAX = 3;
/** 글 하나의 크기 상한 (src/importer.js POST_MAX_CHARS 와 같다). 넘는 글은 클라우드가 받지 않으므로 보내지 않는다 */
const POST_MAX_CHARS = 1_000_000;

/** 주소 확인: https 만 (이 컴퓨터 안의 시험용 주소는 http 허용) — 비밀번호가 평문으로 나가지 않게 */
export function siteOrigin(raw) {
  let u;
  try {
    u = new URL(String(raw || '').trim());
  } catch {
    throw new Error('사이트 주소 형식이 잘못됐어요 (예: https://simsimhae.board.workers.dev)');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) throw new Error('사이트 주소는 https:// 로 시작해야 해요');
  if (u.username || u.password) throw new Error('주소에 사용자 정보를 넣지 마세요');
  return u.origin;
}

/** 데이터 폴더에서 옮길 것을 읽는다 */
export function readLocalData(dataDir) {
  const postsFile = path.join(dataDir, 'posts.json');
  if (!existsSync(postsFile)) throw new Error(`${postsFile} 이 없어요`);
  const db = JSON.parse(readFileSync(postsFile, 'utf8'));
  const rulesFile = path.join(dataDir, 'custom-rules.json');
  const rules = existsSync(rulesFile) ? JSON.parse(readFileSync(rulesFile, 'utf8')) : { block: [], adult: [], allow: [] };
  const posts = Array.isArray(db.posts) ? db.posts : Object.values(db.posts || {});
  return { posts, sources: db.sources || {}, lastCrawlAt: db.lastCrawlAt || null, settings: db.settings || {}, rules };
}

/** 글을 JSON 크기 기준으로 나눈다 (한 요청이 maxBytes 를 넘지 않게) */
export function chunkPosts(posts, maxBytes) {
  const out = [];
  let cur = [];
  let size = 0;
  for (const p of posts) {
    const n = Buffer.byteLength(JSON.stringify(p)) + 1;
    if (cur.length && size + n > maxBytes) {
      out.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(p);
    size += n;
  }
  if (cur.length) out.push(cur);
  return out;
}

/**
 * 관리자 로그인 세션. 클라우드에는 x-admin-key 가 없어서 관리자 비밀번호로 로그인한 쿠키로 부른다 (로컬 서버도 같은 방식으로 된다).
 * 다 쓰면 logout() 을 부른다. 비밀번호는 어디에도 찍지 않는다.
 * @param {{origin: string, password: string, fetch?: typeof fetch}} o
 * @returns {Promise<{get: (p: string) => Promise<any>, post: (p: string, body: any) => Promise<any>, logout: () => Promise<void>}>}
 */
export async function adminSession({ origin, password, fetch: f = fetch }) {
  let cookie = '';
  const call = async (method, p, body) => {
    const r = await f(`${origin}${p}`, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      // 리다이렉트를 따라가지 않는다: 따라가면 비밀번호·쿠키가 든 요청이 http 나 다른 주소로 다시 나간다
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (r.status >= 300 && r.status < 400) {
      await r.body?.cancel().catch(() => {});
      throw new Error(`${p}: 사이트가 다른 주소(${r.headers.get('location') || '알 수 없음'})로 보냈어요. 주소를 확인하고 그 주소로 다시 실행해 주세요`);
    }
    const text = await r.text();
    let j = null;
    try {
      j = JSON.parse(text);
    } catch {}
    if (!r.ok) throw new Error(`${p} → HTTP ${r.status}${j?.error ? ` (${j.error})` : ''}`);
    return { r, j };
  };
  const { r: lr } = await call('POST', '/api/admin/login', { password });
  const set = typeof lr.headers.getSetCookie === 'function' ? lr.headers.getSetCookie() : [lr.headers.get('set-cookie') || ''];
  const admin = set.map((c) => c.split(';')[0]).find((c) => c.startsWith('hg_admin='));
  if (!admin) throw new Error('로그인 쿠키를 받지 못했어요');
  cookie = admin;
  return {
    get: async (p) => (await call('GET', p)).j,
    post: async (p, body) => (await call('POST', p, body ?? {})).j,
    // 로그아웃 실패는 무시한다 (쿠키는 어차피 이 프로세스 안에만 있다)
    logout: () => call('POST', '/api/admin/logout', {}).then(() => {}, () => {}),
  };
}

/**
 * 로그인 → 시작 → 글 나눠 올리기 → 한 번에 바꾸기 → 로그아웃.
 * @param {{origin: string, password: string, data: ReturnType<typeof readLocalData>, chunkBytes?: number, fetch?: typeof fetch, log?: (s: string) => void}} o
 * @returns {Promise<{posts: number, skipped: number}>}
 */
export async function pushToCloud({ origin, password, data, chunkBytes = CHUNK_MB_DEFAULT * 1024 * 1024, fetch: f = fetch, log = () => {} }) {
  // 클라우드가 받지 않을 만큼 큰 글은 보내지 않는다 (한 요청이 클라우드의 본문 상한을 넘지 않게)
  const posts = data.posts.filter((p) => JSON.stringify(p ?? null).length <= POST_MAX_CHARS);
  const notSent = data.posts.length - posts.length;
  const session = await adminSession({ origin, password, fetch: f });
  const call = async (p, body) => ({ j: await session.post(p, body) });
  try {
    const { j: begin } = await call('/api/admin/import', { step: 'begin' });
    const chunks = chunkPosts(posts, chunkBytes);
    let sent = 0;
    let tooBig = 0; // 너무 커서 받지 않은 글 (클라우드가 알려 준다)
    for (const [i, part] of chunks.entries()) {
      const { j } = await call('/api/admin/import', { step: 'posts', importId: begin.importId, posts: part });
      tooBig += Number(j?.skipped) || 0;
      sent += part.length;
      log(`  글 올리는 중 ${sent}/${posts.length} (${i + 1}/${chunks.length})`);
    }
    const { j: done } = await call('/api/admin/import', {
      step: 'commit',
      importId: begin.importId,
      expect: posts.length - tooBig, // 도중에 빠진 묶음이 있으면 클라우드가 바꾸지 않고 409
      sources: data.sources,
      lastCrawlAt: data.lastCrawlAt,
      settings: data.settings,
      rules: data.rules,
    });
    return { posts: done.posts, skipped: done.skipped + tooBig + notSent };
  } finally {
    await session.logout();
  }
}

// ---------- 명령줄 ----------

function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(q, (a) => (rl.close(), resolve(a))));
}

/** 입력이 화면에 보이지 않게 비밀번호를 묻는다 */
export function askHidden(q) {
  const stdin = process.stdin;
  if (!stdin.isTTY) return Promise.reject(new Error('비밀번호는 환경변수 CLOUD_ADMIN_PASSWORD 로 넘겨 주세요'));
  process.stdout.write(q);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let s = '';
    const done = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', on);
      process.stdout.write('\n');
    };
    const on = (chunk) => {
      for (const c of chunk) {
        if (c === '\r' || c === '\n') {
          done();
          return resolve(s);
        }
        if (c === '\u0003') {
          done();
          return reject(new Error('취소했어요'));
        }
        if (c === '\u007f' || c === '\b') s = s.slice(0, -1);
        else s += c;
      }
    };
    stdin.on('data', on);
  });
}

async function main(argv) {
  const args = argv.slice(2);
  const opt = (name) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const url = args.find((a, i) => !a.startsWith('--') && !['--data', '--chunk-mb'].includes(args[i - 1]));
  if (!url) {
    console.error('사용법: node scripts/push-to-cloud.js <사이트 주소> [--data <폴더>] [--yes] [--chunk-mb 2]');
    return 2;
  }
  const origin = siteOrigin(url);
  const dataDir = path.resolve(ROOT, opt('data') || process.env.DATA_DIR || 'data');
  const chunkMb = Math.max(0.25, Math.min(CHUNK_MB_MAX, Number(opt('chunk-mb')) || CHUNK_MB_DEFAULT));
  const data = readLocalData(dataDir);
  const r = data.rules || {};
  console.log(`옮길 것: ${dataDir}`);
  console.log(`  글 ${data.posts.length}개, 금지어 차단 ${r.block?.length ?? 0} · 므흣 ${r.adult?.length ?? 0} · 예외 ${r.allow?.length ?? 0}`);
  console.log(`  실시간 수집: ${data.settings.live === false ? '끔' : data.settings.live === true ? '켬' : '기본값'}${data.settings.intervalMin ? ` (${data.settings.intervalMin}분)` : ''}`);
  console.log(`  → ${origin} 의 지금 상태는 통째로 바뀝니다.`);
  if (data.settings.live) console.log('  (클라우드가 수집을 시작하니, 내 컴퓨터 서버의 실시간 수집은 꺼 두세요)');
  if (!args.includes('--yes')) {
    const a = (await ask('계속할까요? (y/N) ')).trim().toLowerCase();
    if (a !== 'y' && a !== 'yes') {
      console.log('그만뒀어요.');
      return 1;
    }
  }
  const password = process.env.CLOUD_ADMIN_PASSWORD || (await askHidden('관리자 비밀번호: '));
  const out = await pushToCloud({ origin, password, data, chunkBytes: Math.round(chunkMb * 1024 * 1024), log: (s) => console.log(s) });
  console.log(`끝났어요: 글 ${out.posts}개${out.skipped ? ` (형식이 틀려 건너뛴 글 ${out.skipped}개)` : ''}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  // process.exit() 대신 exitCode: fetch 연결이 닫히는 중에 끝내면 Windows 의 Node 가 libuv 단언 실패로 죽는다
  main(process.argv).then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      console.error(`실패: ${e.message}`);
      process.exitCode = 1;
    },
  );
}
