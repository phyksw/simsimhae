// 공개 사이트(Cloudflare Worker): 방문자용 읽기 전용 API + 내 컴퓨터에서 올리는 업로드 API. 규약은 worker/CONTRACT.md.
// 응답 모양은 로컬 서버(src/server.js)의 같은 이름 API 와 같다 (public/app.js 를 그대로 쓰도록).

import { HttpError, json, readJson, isJsonRequest, withSecurityHeaders } from './http.js';
import { ADULT_COOKIE, safeEqual, signAdult, verifyAdult, adultCookieHeader, clearAdultCookieHeader, parseCookies, clientKey, FailLimiter, RateWindow } from './auth.js';
import { ensureSchema, saveSnapshot, saveRead, syncStatus, currentHead, currentPosts, boardList, readDoc, StaleSnapshot } from './store.js';
import { proxyImage } from './img.js';

const SNAPSHOT_MAX_BYTES = 32 * 1024 * 1024;
/** 미리보기 문서 한 개의 상한 (규약 1.5MB) */
export const READ_MAX_BYTES = 1.5 * 1024 * 1024;
const UNLOCK_MAX_BYTES = 64 * 1024;
const ADMIN_BOARDS = new Set(['filtered', 'shorts']);

/** isolate 하나의 상태 (스키마 준비 여부, 스냅샷 캐시, 시도 제한) */
function createState() {
  return {
    schema: null,
    head: null,
    posts: null,
    loading: null,
    unlockFails: new FailLimiter(10, 10 * 60e3), // 접속자당 10분에 10번 틀리면 막음 (로컬과 같음)
    imgRate: new RateWindow(600, 60e3), // 접속자당 분당 600번 (로컬 IMG_RATE_PER_MIN 기본값)
  };
}

/**
 * Worker 하나 만들기. 시험에서는 새 isolate 처럼 쓰려고 여러 개 만들고, 원본 요청(fetch)·시계를 바꿔 끼운다.
 * @param {{fetch?: typeof fetch, now?: () => number}} [opts]
 */
export function createWorker(opts = {}) {
  const state = createState();
  const now = opts.now ?? (() => Date.now());
  const upstream = opts.fetch ?? ((input, init) => fetch(input, init));
  return {
    async fetch(request, env, ctx) {
      let res;
      try {
        res = await route(request, env || {}, ctx, { state, now: now(), upstream });
      } catch (e) {
        if (e instanceof HttpError) res = json({ error: e.message }, e.status);
        else {
          console.error('[worker]', e?.stack || e);
          res = json({ error: '서버 오류가 났어요' }, 500);
        }
      }
      return withSecurityHeaders(res);
    },
  };
}

async function route(request, env, ctx, k) {
  const url = new URL(request.url);
  const path = url.pathname;
  // run_worker_first 가 /api/* 만이라 보통은 오지 않지만, 혹시 오면 정적 파일로 넘긴다
  if (!path.startsWith('/api/')) return env.ASSETS ? env.ASSETS.fetch(request) : json({ error: 'not found' }, 404);

  const db = env.DB;
  if (!db) throw new Error('D1 바인딩(DB)이 없어요');
  await ensureSchema(k.state, db);

  const method = request.method;
  const isGet = method === 'GET' || method === 'HEAD';
  if (path.startsWith('/api/sync/')) return sync(request, env, db, path, method, k);

  if (isGet && path === '/api/meta') return meta(request, env, db, k);
  if (isGet && path === '/api/posts') return listPosts(request, env, db, url, k);
  const m = isGet ? /^\/api\/posts\/([^/]+)\/read$/.exec(path) : null;
  if (m) return readPost(request, env, db, decodeId(m[1]), k);
  if (method === 'POST' && path === '/api/unlock') return unlock(request, env, k);
  if (method === 'POST' && path === '/api/lock') {
    if (!isJsonRequest(request)) return json({ error: 'JSON 요청만 받아요' }, 415);
    return json({ ok: true }, 200, { 'set-cookie': clearAdultCookieHeader() });
  }
  if (isGet && path === '/api/img') {
    const { head } = await snapshot(k.state, db, false);
    return proxyImage({ request, url, head, ctx, upstream: k.upstream, limiter: k.state.imgRate, now: k.now });
  }
  // /api/events(실시간 연결)·관리자 API 등은 공개 사이트에 없다
  return json({ error: 'not found' }, 404);
}

function decodeId(raw) {
  try {
    const id = decodeURIComponent(raw);
    if (id && id.length <= 300) return id;
  } catch {}
  throw new HttpError(400, '잘못된 요청이에요');
}

/** 스냅샷 머리(+ 필요하면 글 목록). 읽는 사이 새 업로드가 끼면 한 번 다시 읽는다. */
async function snapshot(state, db, needPosts) {
  for (let attempt = 0; ; attempt++) {
    const head = await currentHead(state, db);
    if (!head || !needPosts) return { head, posts: null };
    try {
      return { head, posts: await currentPosts(state, db, head) };
    } catch (e) {
      if (!(e instanceof StaleSnapshot) || attempt >= 1) throw e;
    }
  }
}

async function isAdult(request, env, k) {
  const token = parseCookies(request.headers.get('cookie')).get(ADULT_COOKIE);
  return token ? verifyAdult(env.SESSION_SECRET, token, k.now) : false;
}

const countOf = (head, board) => (head && Object.hasOwn(head.counts || {}, board) ? head.counts[board] : 0);

// ---------- 방문자 API ----------

async function meta(request, env, db, k) {
  const [{ head }, adult] = await Promise.all([snapshot(k.state, db, false), isAdult(request, env, k)]);
  // 각 게시판 목록(/api/posts)의 total 과 같은 기준. 잠금 게시판 수는 잠금을 푼 사람에게만.
  const boardCounts = { story: countOf(head, 'story'), pick: countOf(head, 'pick'), all: countOf(head, 'all') };
  if (adult) boardCounts.adult = countOf(head, 'adult');
  return json({
    siteName: head?.siteName || '심심풀이',
    mode: 'public',
    pickCount: boardCounts.pick,
    boardCounts,
    adult,
    admin: false,
    live: { live: true, lastCrawlAt: head?.lastCrawlAt ?? null },
    sources: (head?.sources || []).map((s) => ({
      id: s.id,
      name: s.name,
      short: s.short,
      color: s.color,
      homepage: s.homepage,
      active: s.active,
      count: countOf(head, s.id),
    })),
  });
}

async function listPosts(request, env, db, url, k) {
  const sp = url.searchParams;
  const board = String(sp.get('board') || 'all');
  const sort = sp.get('sort') === 'hot' ? 'hot' : 'new';
  const size = Math.max(5, Math.min(100, Number(sp.get('size')) || 30));
  const page = Math.max(1, Math.floor(Number(sp.get('page')) || 1));
  const q = String(sp.get('q') || '').trim().toLowerCase().slice(0, 50);

  if (ADMIN_BOARDS.has(board)) return json({ error: '관리자 전용' }, 401);
  if (board === 'adult' && !(await isAdult(request, env, k))) return json({ error: 'locked' }, 403);

  const { posts } = await snapshot(k.state, db, true);
  let list = boardList(posts, board, sort);
  if (q) list = list.filter((e) => (e.lower ??= String(e.item.title).toLowerCase()).includes(q));
  const total = list.length;
  const items = list.slice((page - 1) * size, page * size).map((e) => e.item);
  return json({ board, sort, page, size, total, hasMore: page * size < total, items });
}

async function readPost(request, env, db, id, k) {
  const { posts } = await snapshot(k.state, db, true);
  const e = posts?.byId.get(id);
  if (!e) return json({ error: '글을 찾을 수 없어요 (오래되어 정리됐을 수 있어요)' }, 404);
  if (e.item.status === 'adult' && !(await isAdult(request, env, k))) return json({ error: 'locked' }, 403);
  // hasRead 와 상관없이 D1 을 직접 본다 (스냅샷과 미리보기를 어떤 순서로 올려도 맞게)
  const doc = await readDoc(db, id);
  if (!doc) return json({ error: '미리보기를 준비 중이에요', url: e.item.url }, 404);
  // 저장된 문서(JSON 객체 글자)를 다시 해석하지 않고 앞에 post 만 붙인다 (CPU 절약)
  return json(`{"post":${JSON.stringify(e.item)},"statusChanged":false,${doc.slice(1)}`);
}

async function unlock(request, env, k) {
  if (!isJsonRequest(request)) return json({ error: 'JSON 요청만 받아요' }, 415);
  const who = clientKey(request);
  const fails = k.state.unlockFails;
  if (fails.limited(who, k.now)) return json({ error: '시도가 너무 많아요. 10분 뒤에 다시 해주세요' }, 429);
  if (!env.ADULT_PASSWORD || !env.SESSION_SECRET) return json({ error: '지금은 잠금을 풀 수 없어요' }, 503);
  const body = await readJson(request, UNLOCK_MAX_BYTES);
  const password = typeof body?.password === 'string' ? body.password : '';
  if (!(await safeEqual(password, env.ADULT_PASSWORD))) {
    fails.fail(who, k.now);
    return json({ error: '비밀번호가 달라요' }, 401);
  }
  fails.clear(who);
  return json({ ok: true }, 200, { 'set-cookie': adultCookieHeader(await signAdult(env.SESSION_SECRET, k.now)) });
}

// ---------- 업로드 API (내 컴퓨터 → Worker, Bearer 필요) ----------

async function sync(request, env, db, path, method, k) {
  const token = env.PUBLISH_TOKEN;
  if (!token) return json({ error: '업로드 토큰(PUBLISH_TOKEN)이 설정되지 않았어요' }, 503);
  const m = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(request.headers.get('authorization') || '');
  if (!m || !(await safeEqual(m[1], token))) return json({ error: '인증이 필요해요' }, 401, { 'www-authenticate': 'Bearer' });

  if (method === 'PUT' && path === '/api/sync/snapshot') {
    const body = await readJson(request, SNAPSHOT_MAX_BYTES);
    return json(await saveSnapshot(db, body, k.now));
  }
  if (method === 'GET' && path === '/api/sync/status') return json(await syncStatus(db));
  const r = method === 'PUT' ? /^\/api\/sync\/read\/([^/]+)$/.exec(path) : null;
  if (r) {
    const id = decodeId(r[1]);
    const body = await readJson(request, READ_MAX_BYTES);
    await saveRead(db, id, body, k.now);
    return json({ ok: true });
  }
  return json({ error: 'not found' }, 404);
}
