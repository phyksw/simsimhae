// 웹 서버: 목록/본문 API, 잠금 게시판, 관리자(실시간 ON/OFF·걸러진 글 게시·쇼츠 후보함·금지어), 이미지 프록시, 실시간 알림(SSE).
import express from 'express';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import { config, ROOT } from './config.js';
import * as store from './store.js';
import { isPending, isPublic, groupIndex, groupKey, onePerGroup } from './store.js';
import { loadSources, getSource } from './sources/index.js';
import { crawlNow, events, liveState, setLive, activeSources, isRunning, rescoreAll, rescorePost, currentMedians } from './crawler.js';
import { startScheduler } from './crawler.js';
import { readPost, forgetCached } from './reader.js';
import { fetchRaw } from './lib/http.js';
import { hostMatches } from './lib/util.js';
import { classify, getCustomRules, saveCustomRules, vibeGuess } from './filter.js';
import { aiStatus } from './ai.js';

store.load();
const app = express();
app.disable('x-powered-by');

/** TRUST_PROXY 값 → express 'trust proxy' 값 (숫자 = 앞단 프록시 개수, true/false, 또는 주소·대역 목록) */
function trustProxyValue(v) {
  const s = String(v ?? '').trim();
  if (/^\d+$/.test(s)) return Number(s);
  if (s === 'true' || s === 'false') return s === 'true';
  return s.split(',').map((x) => x.trim()).filter(Boolean);
}
app.set('trust proxy', trustProxyValue(config.trustProxy));

/** async 핸들러의 예외를 express 오류 처리로 넘긴다 (express 4 는 async 핸들러의 promise 를 보지 않아 프로세스가 죽는다) */
const wrap = (fn) => (req, res, next) => Promise.resolve().then(() => fn(req, res, next)).catch(next);

// ---------- 보안 헤더 ----------
app.use((req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "img-src 'self' data: https:",
      "media-src 'self' https:",
      'frame-src https://www.youtube.com https://www.youtube-nocookie.com https://player.vimeo.com https://streamable.com https://clips.twitch.tv',
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "connect-src 'self'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; '),
  );
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});
app.use(express.json({ limit: '64kb' }));

// ---------- 서명 쿠키 (잠금 게시판 / 관리자) ----------
const COOKIE_ADULT = 'hg_adult';
const COOKIE_ADMIN = 'hg_admin';

function sign(value) {
  const mac = createHmac('sha256', config.sessionSecret).update(value).digest('base64url');
  return `${value}.${mac}`;
}
/** 비밀번호에서 만든 짧은 꼬리표. 쿠키에 넣어 두어 비밀번호를 바꾸면(재시작) 이미 발급된 쿠키가 모두 무효가 된다. */
function pwTag(kind) {
  const pw = kind === 'admin' ? config.adminPassword : config.adultPassword;
  return createHmac('sha256', config.sessionSecret).update(`pw|${kind}|${pw}`).digest('base64url').slice(0, 16);
}
function verify(token, kind) {
  if (!token || typeof token !== 'string') return false;
  const i = token.lastIndexOf('.');
  if (i <= 0) return false;
  const value = token.slice(0, i);
  const expected = Buffer.from(sign(value));
  const got = Buffer.from(token);
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) return false;
  const [k, exp, tag] = value.split(':');
  return k === kind && tag === pwTag(kind) && Number(exp) > Date.now();
}
/** Cookie 헤더 해석. 잘못된 %-인코딩이 있어도 예외를 내지 않는다(그 값은 원문 그대로 두고, 서명 확인에서 걸러진다). */
function cookies(req) {
  if (req._hgCookies) return req._hgCookies;
  const out = Object.create(null);
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    if (!k || k in out) continue;
    const raw = part.slice(i + 1).trim();
    let v;
    try {
      v = decodeURIComponent(raw);
    } catch {
      v = raw;
    }
    out[k] = v;
  }
  return (req._hgCookies = out);
}
/** HTTPS(프록시가 X-Forwarded-Proto 로 알려준 경우 포함)면 Secure. COOKIE_SECURE=1/0 으로 강제할 수 있다. */
const secureAttr = (req) => ((config.cookieSecure ?? req.secure) ? '; Secure' : '');
function setAuthCookie(req, res, name, kind, hours) {
  const exp = Date.now() + hours * 3600e3;
  res.append(
    'Set-Cookie',
    `${name}=${encodeURIComponent(sign(`${kind}:${exp}:${pwTag(kind)}`))}; Path=/; HttpOnly; SameSite=Strict${secureAttr(req)}; Max-Age=${hours * 3600}`,
  );
}
function clearCookie(req, res, name) {
  res.append('Set-Cookie', `${name}=; Path=/; HttpOnly; SameSite=Strict${secureAttr(req)}; Max-Age=0`);
}
const isAdmin = (req) =>
  verify(cookies(req)[COOKIE_ADMIN], 'admin') ||
  // 이 컴퓨터에서 도는 스크립트(검수 결과 넣기·예약 작업)용: 로컬 접속 + x-admin-key 헤더
  (isLocal(req) && typeof req.headers['x-admin-key'] === 'string' && safeEqual(req.headers['x-admin-key'], config.adminPassword));
function isLocal(req) {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.ip);
}
const isAdult = (req) => isAdmin(req) || verify(cookies(req)[COOKIE_ADULT], 'adult');

function safeEqual(a, b) {
  const x = createHmac('sha256', 'cmp').update(String(a)).digest();
  const y = createHmac('sha256', 'cmp').update(String(b)).digest();
  return timingSafeEqual(x, y);
}

/** 요청 수 제한용 접속자 키: IPv4 는 그대로, IPv6 는 /64 대역으로 묶는다 */
function clientKey(req) {
  let ip = String(req.ip || '').split('%')[0];
  if (ip.startsWith('::ffff:') && ip.includes('.')) return ip.slice(7);
  if (!ip.includes(':')) return ip;
  let groups;
  if (ip.includes('::')) {
    const [h, t] = ip.split('::');
    const hs = h ? h.split(':') : [];
    const ts = t ? t.split(':') : [];
    groups = [...hs, ...Array(Math.max(0, 8 - hs.length - ts.length)).fill('0'), ...ts];
  } else groups = ip.split(':');
  return `${groups.slice(0, 4).map((x) => x.padStart(4, '0')).join(':')}::/64`;
}

// 비밀번호 시도 제한: 잠금 해제·관리자 로그인을 따로 세고, 틀린 시도만 센다 (접속자당 10분에 10번)
const ATTEMPT_WINDOW_MS = 10 * 60e3;
const MAX_FAILS = 10;
const attempts = { unlock: new Map(), admin: new Map() };
function isLimited(kind, req) {
  const a = attempts[kind].get(clientKey(req));
  return !!a && a.resetAt > Date.now() && a.n >= MAX_FAILS;
}
function recordFailure(kind, req) {
  const m = attempts[kind];
  const k = clientKey(req);
  const now = Date.now();
  const a = m.get(k);
  if (!a || a.resetAt <= now) m.set(k, { n: 1, resetAt: now + ATTEMPT_WINDOW_MS });
  else a.n++;
}
const clearFailures = (kind, req) => attempts[kind].delete(clientKey(req));
setInterval(() => {
  const now = Date.now();
  for (const m of Object.values(attempts)) for (const [k, a] of m) if (a.resetAt <= now) m.delete(k);
}, 60e3).unref();

// 외부에 열어 둔 서버인데 모든 접속이 루프백(프록시)에서 온 것으로 보이면, 시도 제한이 모든 방문자에게 공유된다
let proxyWarned = false;
function warnProxyOnce(req) {
  if (proxyWarned || ['127.0.0.1', '::1', 'localhost'].includes(config.host)) return;
  if (isLocal(req) && !req.headers['x-forwarded-for']) {
    proxyWarned = true;
    console.warn(
      '[보안] 루프백에서 X-Forwarded-For 없이 들어온 로그인 시도가 있어요. 리버스 프록시 뒤라면 X-Forwarded-For 를 넘기도록 설정하세요 ' +
        '(프록시가 다른 주소에 있으면 TRUST_PROXY 에 그 주소를). 그렇지 않으면 모든 방문자가 같은 IP 로 보여 시도 제한을 함께 씁니다.',
    );
  }
}

function requireAdmin(req, res, next) {
  if (!isAdmin(req)) return res.status(401).json({ error: '관리자 로그인이 필요해요' });
  next();
}
function requireJson(req, res, next) {
  // 다른 사이트에서 폼으로 POST 하는 것(CSRF)을 막기 위해 JSON 요청만 받는다
  if (!req.is('application/json')) return res.status(415).json({ error: 'JSON 요청만 받아요' });
  next();
}

// ---------- 게시판 ----------

/** 웃긴 것만(pick): 공개 글 중 "그냥 웃긴" 글. Claude 판정이 있으면 그걸, 없으면 키워드 점수를 본다. */
export const PICK_MIN = 65;
const PICK_DAYS = 7;
function pickWorthy(p) {
  if (Date.now() - new Date(p.firstSeenAt).getTime() > PICK_DAYS * 864e5) return false;
  if (p.manual === 'ok' && p.shorts) return true;
  if (p.ai) return p.ai.verdict === 'ok' && p.ai.shortsScore >= PICK_MIN;
  return (p.shortsScore ?? 0) >= PICK_MIN - 5;
}

/** 글의 "썰·대화" 분위기 점수: 관리자 지정 > Claude 판정(ai.vibe) > 제목 어림값 */
function vibeOf(p) {
  if (p.manualVibe === true) return 100;
  if (p.manualVibe === false) return 0;
  return typeof p.ai?.vibe === 'number' ? p.ai.vibe : vibeGuess(p);
}
/** 썰·대화(story): 운영자가 보여준 쇼츠처럼 읽어주며 반응하기 좋은 웃긴 글 */
export const STORY_VIBE_MIN = 70;
const STORY_FUNNY_MIN = 55;
function storyWorthy(p) {
  if (Date.now() - new Date(p.firstSeenAt).getTime() > PICK_DAYS * 864e5) return false;
  if (p.manualVibe === true) return true;
  if (p.manualVibe === false) return false;
  if (p.ai) return p.ai.verdict === 'ok' && p.ai.shortsScore >= STORY_FUNNY_MIN && vibeOf(p) >= STORY_VIBE_MIN;
  return (p.shortsScore ?? 0) >= STORY_FUNNY_MIN && vibeOf(p) >= 60;
}

/**
 * 게시판의 글 목록 (검색·정렬 전). /api/posts 의 total 과 /api/meta 의 boardCounts·sources[].count 가 모두 이 함수로 센다.
 * - 전체·픽·므흣: 중복 묶음마다 하나만. 대표 글이 보이면 대표 글이, 대표 글이 안 보이면(차단·대기·므흣) 보이는 사본이 대신 나온다.
 * - 출처별: 그 출처의 공개 글 전부 (각 글의 상태로만 판단)
 * @returns {import('./store.js').Post[]|null} 볼 권한이 없으면 null
 */
function boardPosts(board, { admin = false, adult = false, stage = '' } = {}, all = store.allPosts()) {
  switch (board) {
    case 'all':
      return onePerGroup(all.filter(isPublic));
    case 'pick':
      return onePerGroup(all.filter(isPublic)).filter(pickWorthy);
    case 'story':
      return onePerGroup(all.filter(isPublic)).filter(storyWorthy);
    case 'adult':
      return adult ? onePerGroup(all.filter((p) => p.status === 'adult' && !isPending(p))) : null;
    case 'filtered':
      return admin ? all.filter((p) => p.status === 'blocked' || isPending(p)) : null;
    case 'shorts':
      return admin ? all.filter((p) => p.shorts && (!stage || p.shorts.stage === stage)) : null;
    default:
      return all.filter((p) => p.source === board && isPublic(p));
  }
}

// ---------- 직렬화 ----------
function serialize(p, { admin, groups }) {
  const o = {
    id: p.id,
    source: p.source,
    title: p.title,
    url: p.url,
    postedAt: p.postedAt,
    firstSeenAt: p.firstSeenAt,
    commentCount: p.commentCount,
    views: p.views,
    likes: p.likes,
    category: p.category,
    status: p.status,
    shortsScore: p.shortsScore ?? 0,
    // 같은 묶음의 다른 글 중 이 글과 같은 상태로 보이는 것 (Claude 검수 대기 중인 사본은 빼고)
    alsoOn: (groups?.get(groupKey(p)) || [])
      .filter((d) => d.id !== p.id && d.status === p.status && !isPending(d))
      .map((d) => ({ source: d.source, url: d.url })),
  };
  if (admin) {
    Object.assign(o, {
      auto: p.auto,
      ai: p.ai,
      // 관리자 지정이 있으면 검수 대기로 보지 않는다 (지정을 풀면 다시 대기열로 돌아감)
      aiPending: !!(config.ai.enabled && p.aiPending && !p.manual),
      aiGaveUp: !!p.aiGaveUp,
      manual: p.manual || null,
      shorts: p.shorts || null,
      dupOf: p.dupOf || null,
      nsfwHint: !!p.nsfwHint,
      vibe: vibeOf(p),
      manualVibe: typeof p.manualVibe === 'boolean' ? p.manualVibe : null,
      inStory: storyWorthy(p),
    });
  }
  return o;
}

const ts = (p) => new Date(p.postedAt || p.firstSeenAt).getTime() || 0;

function sortPosts(posts, sort) {
  if (sort === 'shorts') return posts.sort((a, b) => (b.shortsScore ?? 0) - (a.shortsScore ?? 0) || ts(b) - ts(a));
  if (sort === 'hot') {
    // 같은 출처 안에서의 반응 순위(백분위)에 시간 감쇠를 곱한다
    const bySrc = new Map();
    const metric = (p) => p.likes ?? p.commentCount ?? p.views ?? null;
    for (const p of posts) {
      if (!bySrc.has(p.source)) bySrc.set(p.source, []);
      bySrc.get(p.source).push(p);
    }
    const pct = new Map();
    for (const arr of bySrc.values()) {
      const vals = arr.map(metric).filter((v) => v != null).sort((a, b) => a - b);
      for (const p of arr) {
        const v = metric(p);
        if (v == null || !vals.length) pct.set(p.id, 0.3);
        else {
          let lo = 0;
          while (lo < vals.length && vals[lo] < v) lo++;
          pct.set(p.id, vals.length > 1 ? lo / (vals.length - 1) : 0.5);
        }
      }
    }
    const now = Date.now();
    const score = (p) => pct.get(p.id) * Math.exp(-Math.max(0, now - ts(p)) / (36 * 3600e3));
    return posts.sort((a, b) => score(b) - score(a));
  }
  return posts.sort((a, b) => ts(b) - ts(a));
}

// ---------- 공개 API ----------
app.get(
  '/api/meta',
  wrap(async (req, res) => {
    const admin = isAdmin(req);
    const adult = isAdult(req);
    const sources = await loadSources();
    const active = new Set((await activeSources()).map((s) => s.id));
    const db = store.getDb();
    const posts = store.allPosts();
    const ctx = { admin, adult };
    const count = (board) => boardPosts(board, ctx, posts)?.length ?? 0;
    // 각 게시판 목록(/api/posts)의 total 과 같은 기준. 볼 수 없는 게시판은 넣지 않는다.
    const boardCounts = { story: count('story'), pick: count('pick'), all: count('all') };
    if (adult) boardCounts.adult = count('adult');
    if (admin) {
      boardCounts.filtered = count('filtered');
      boardCounts.shorts = count('shorts');
    }
    const lv = liveState();
    res.json({
      siteName: config.siteName,
      pickCount: boardCounts.pick,
      boardCounts,
      adult,
      admin,
      live: { live: lv.live, lastCrawlAt: lv.lastCrawlAt, ...(admin ? lv : {}) },
      // 방문자에게는 수집 중인 출처와, 수집을 껐어도(disabled·SOURCES·DISABLE_SOURCES) 아직 공개 글이 남은 출처를 보낸다.
      // 그 글들은 전체 게시판에 계속 나오므로, 빼면 화면의 출처 배지·"같은 글:" 배지가 이름 대신 id 로 보인다.
      sources: sources
        .map((s) => ({ s, n: count(s.id) }))
        .filter(({ s, n }) => admin || active.has(s.id) || n > 0)
        .map(({ s, n }) => ({
          id: s.id,
          name: s.name,
          short: s.short,
          color: s.color,
          homepage: s.homepage,
          active: active.has(s.id),
          count: n,
          ...(admin ? { disabled: !!s.disabled, disabledReason: s.disabledReason || null, state: db.sources[s.id] || null, strictness: s.strictness } : {}),
        })),
      ...(admin
        ? {
            ai: aiStatus(),
            stats: {
              total: posts.length,
              public: posts.filter(isPublic).length,
              adult: posts.filter((p) => p.status === 'adult').length,
              blocked: posts.filter((p) => p.status === 'blocked').length,
              pending: posts.filter(isPending).length,
              shorts: posts.filter((p) => p.shorts).length,
            },
            secretsFile: config.secretsFile,
          }
        : {}),
    });
  }),
);

app.get('/api/posts', (req, res) => {
  const admin = isAdmin(req);
  const board = String(req.query.board || 'all');
  const sort = ['new', 'hot', 'shorts'].includes(req.query.sort) ? req.query.sort : 'new';
  const size = Math.max(5, Math.min(100, Number(req.query.size) || 30));
  const page = Math.max(1, Math.floor(Number(req.query.page) || 1));
  const q = String(req.query.q || '').trim().toLowerCase().slice(0, 50);
  const stage = String(req.query.stage || '');

  let posts = boardPosts(board, { admin, adult: board === 'adult' && isAdult(req), stage });
  if (!posts) return board === 'adult' ? res.status(403).json({ error: 'locked' }) : res.status(401).json({ error: '관리자 전용' });
  if (q) posts = posts.filter((p) => p.title.toLowerCase().includes(q));
  if (board === 'shorts' && sort === 'new') posts.sort((a, b) => String(b.shorts.updatedAt).localeCompare(String(a.shorts.updatedAt)));
  else sortPosts(posts, sort);

  const groups = groupIndex(store.allPosts());
  const total = posts.length;
  const items = posts.slice((page - 1) * size, page * size).map((p) => serialize(p, { admin, groups }));
  res.json({ board, sort, page, size, total, hasMore: page * size < total, items });
});

app.get(
  '/api/posts/:id/read',
  wrap(async (req, res) => {
    const p = store.getPost(req.params.id);
    if (!p) return res.status(404).json({ error: '글을 찾을 수 없어요 (오래되어 정리됐을 수 있어요)' });
    const admin = isAdmin(req);
    if (p.status === 'adult' && !isAdult(req)) return res.status(403).json({ error: 'locked' });
    if ((p.status === 'blocked' || isPending(p)) && !admin) return res.status(404).json({ error: '볼 수 없는 글이에요' });
    let data;
    try {
      data = await readPost(p);
    } catch (e) {
      return res.status(502).json({ error: `원문을 불러오지 못했어요 (${e.status ? `HTTP ${e.status}` : e.message})`, url: p.url });
    }
    const fresh = store.getPost(p.id) || p;
    // 본문 검사로 상태가 바뀌었으면 쇼츠 점수도 지금 상태로 (공개→차단이면 10 이하로, 그 반대도)
    if (data.statusChanged) {
      rescorePost(fresh);
      store.upsertPost(fresh);
    }
    // 본문 검사로 상태가 바뀌어 이제 볼 수 없게 됐다면 막는다
    if (!admin && (fresh.status === 'blocked' || (fresh.status === 'adult' && !isAdult(req)))) {
      return res.status(409).json({ error: fresh.status === 'adult' ? '본문을 확인해 보니 므흣 게시판 글이라 옮겼어요' : '본문을 확인해 보니 걸러야 할 글이라 숨겼어요', status: fresh.status });
    }
    res.json({ post: serialize(fresh, { admin, groups: groupIndex(store.allPosts()) }), ...data });
  }),
);

app.post('/api/unlock', requireJson, (req, res) => {
  warnProxyOnce(req);
  if (isLimited('unlock', req)) return res.status(429).json({ error: '시도가 너무 많아요. 10분 뒤에 다시 해주세요' });
  if (!safeEqual(req.body?.password || '', config.adultPassword)) {
    recordFailure('unlock', req);
    return res.status(401).json({ error: '비밀번호가 달라요' });
  }
  clearFailures('unlock', req);
  setAuthCookie(req, res, COOKIE_ADULT, 'adult', 12);
  res.json({ ok: true });
});
app.post('/api/lock', requireJson, (req, res) => {
  clearCookie(req, res, COOKIE_ADULT);
  res.json({ ok: true });
});

// ---------- 실시간 알림 (Server-Sent Events) ----------
const clients = new Set();
app.get('/api/events', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write('retry: 5000\n\n');
  // 관리자 여부는 연결할 때의 쿠키로 정해진다 — 로그인·로그아웃 뒤에는 화면이 EventSource 를 다시 연결해야 한다
  const c = { res, admin: isAdmin(req) };
  clients.add(c);
  req.on('close', () => clients.delete(c));
});
function broadcast(event, data, adminOnly = false) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) if (!adminOnly || c.admin) c.res.write(msg);
}
events.on('crawl', ({ freshIds = [], ...d }) => {
  // 공개 게시판별로 이번에 새로 보이게 된 글 수 (목록 API 와 같은 기준). 므흣·관리자 게시판 수는 모두에게 가는 이벤트라 넣지 않는다.
  const fresh = new Set(freshIds);
  const posts = store.allPosts();
  const freshIn = (board) => boardPosts(board, {}, posts).filter((p) => fresh.has(p.id)).length;
  const bySource = {};
  for (const p of posts) bySource[p.source] ??= 0;
  for (const p of posts) if (fresh.has(p.id) && isPublic(p)) bySource[p.source]++;
  broadcast('crawl', { ...d, counts: { all: freshIn('all'), pick: freshIn('pick'), story: freshIn('story'), bySource } });
});
events.on('state', (s) => {
  broadcast('live', { live: s.live, lastCrawlAt: s.lastCrawlAt });
  broadcast('state', s, true);
});
setInterval(() => {
  for (const c of clients) c.res.write(': ping\n\n');
}, 25e3).unref();

// ---------- 관리자 ----------
app.post('/api/admin/login', requireJson, (req, res) => {
  warnProxyOnce(req);
  if (isLimited('admin', req)) return res.status(429).json({ error: '시도가 너무 많아요. 10분 뒤에 다시 해주세요' });
  if (!safeEqual(req.body?.password || '', config.adminPassword)) {
    recordFailure('admin', req);
    return res.status(401).json({ error: '비밀번호가 달라요' });
  }
  clearFailures('admin', req);
  setAuthCookie(req, res, COOKIE_ADMIN, 'admin', 24 * 7);
  res.json({ ok: true });
});
app.post('/api/admin/logout', requireJson, (req, res) => {
  clearCookie(req, res, COOKIE_ADMIN);
  res.json({ ok: true });
});

app.post('/api/admin/posts/:id', requireJson, requireAdmin, (req, res) => {
  const p = store.getPost(req.params.id);
  if (!p) return res.status(404).json({ error: '없는 글' });
  const b = req.body || {};
  if ('manual' in b) {
    if (b.manual !== null && !['ok', 'adult', 'blocked'].includes(b.manual)) return res.status(400).json({ error: 'manual 값 오류' });
    p.manual = b.manual;
    // 관리자 지정이 있는 동안은 runAi·isPending 이 알아서 건너뛰므로 aiPending 은 그대로 둔다.
    // '자동 판정으로' 되돌릴 때 아직 Claude 판정이 없으면 다시 검수 대기열로 (예전 버전에서 지워진 표시도 복구)
    if (b.manual === null && config.ai.enabled && !p.ai && !p.aiGaveUp) p.aiPending = true;
  }
  // 썰·대화 게시판에 넣기(true)/빼기(false)/자동(null)
  if ('vibe' in b) {
    if (b.vibe !== null && typeof b.vibe !== 'boolean') return res.status(400).json({ error: 'vibe 값 오류' });
    if (b.vibe === null) delete p.manualVibe;
    else p.manualVibe = b.vibe;
  }
  if ('shorts' in b) {
    if (b.shorts === null) p.shorts = null;
    else {
      const stage = ['candidate', 'script', 'done'].includes(b.shorts?.stage) ? b.shorts.stage : 'candidate';
      p.shorts = { stage, note: String(b.shorts?.note ?? p.shorts?.note ?? '').slice(0, 2000), updatedAt: new Date().toISOString() };
    }
  }
  p.status = store.resolveStatus(p);
  rescorePost(p); // 상태가 바뀌면 쇼츠 점수도 바로 (다음 수집까지 기다리지 않게)
  store.upsertPost(p);
  store.saveNow(); // 관리자 지정은 바로 저장 (곧바로 서버를 꺼도 남게)
  forgetCached(p.id);
  res.json({ ok: true, post: serialize(p, { admin: true, groups: groupIndex(store.allPosts()) }) });
});

app.post('/api/admin/live', requireJson, requireAdmin, (req, res) => {
  const { live, intervalMin } = req.body || {};
  res.json(setLive({ live: typeof live === 'boolean' ? live : undefined, intervalMin: intervalMin != null ? Number(intervalMin) : undefined }));
});

app.post('/api/admin/crawl', requireJson, requireAdmin, (req, res) => {
  const already = isRunning();
  crawlNow().catch((e) => console.error(`[crawl] 수동 수집 실패: ${e.message}`));
  res.status(202).json({ started: !already, running: true });
});

// Claude 검수 대기열: 아직 판정이 없는 최근 글 (예약 작업·수동 검수용)
app.get(
  '/api/admin/review-queue',
  requireAdmin,
  wrap(async (req, res) => {
    const limit = Math.max(1, Math.min(1000, Number(req.query.limit) || 300));
    const names = Object.fromEntries((await loadSources()).map((x) => [x.id, x.name]));
    const since = Date.now() - 7 * 864e5;
    const needVibe = req.query.vibe === '1';
    const items = store
      .allPosts()
      .filter((p) =>
        needVibe
          ? p.ai?.verdict === 'ok' && typeof p.ai.vibe !== 'number' && new Date(p.firstSeenAt).getTime() > since
          : !p.ai && !p.manual && p.auto?.status !== 'blocked' && new Date(p.firstSeenAt).getTime() > since,
      )
      .sort((a, b) => String(b.firstSeenAt).localeCompare(String(a.firstSeenAt)))
      .slice(0, limit)
      .map((p) => ({ id: p.id, source: p.source, sourceName: names[p.source] || p.source, title: p.title, category: p.category, likes: p.likes, comments: p.commentCount, auto: p.auto?.status }));
    res.json({ total: items.length, items });
  }),
);

// Claude 검수 결과 넣기: {model, items: [{id, verdict, shortsScore, reason}]}
const VERDICTS = ['ok', 'politics', 'hate', 'dark', 'adult', 'not_humor'];
app.post('/api/admin/verdicts', requireJson, requireAdmin, (req, res) => {
  const model = String(req.body?.model || 'claude').slice(0, 60);
  const at = new Date().toISOString();
  let applied = 0;
  const skipped = [];
  const vibeNum = (v) => (v === undefined || v === null || !Number.isFinite(Number(v)) ? undefined : Math.max(0, Math.min(100, Math.round(Number(v)))));
  for (const it of Array.isArray(req.body?.items) ? req.body.items.slice(0, 2000) : []) {
    const p = store.getPost(String(it?.id || ''));
    // 판정은 그대로 두고 "썰·대화" 분위기 점수만 넣는 경우
    if (p && p.ai && it && it.verdict === undefined && vibeNum(it.vibe) !== undefined) {
      p.ai = { ...p.ai, vibe: vibeNum(it.vibe) };
      store.upsertPost(p);
      applied++;
      continue;
    }
    if (!p || !VERDICTS.includes(it.verdict)) {
      skipped.push(it?.id);
      continue;
    }
    p.ai = { verdict: it.verdict, shortsScore: Math.max(0, Math.min(100, Math.round(Number(it.shortsScore) || 0))), reason: String(it.reason || '').slice(0, 60), model, at };
    if (vibeNum(it.vibe) !== undefined) p.ai.vibe = vibeNum(it.vibe);
    p.aiPending = false;
    p.aiTries = 0;
    p.aiNextAt = null;
    p.aiGaveUp = false;
    p.status = store.resolveStatus(p);
    store.upsertPost(p);
    applied++;
  }
  rescoreAll();
  store.saveNow();
  res.json({ applied, skipped });
});

// ---------- 규칙 재판정 ----------

/** 판정 규칙의 지문: 기본 규칙 파일·관리자 규칙·소스 엄격도가 바뀌면 달라진다 */
function rulesFingerprint(srcs) {
  const h = createHash('sha1');
  for (const f of ['filter.js', 'filter-rules.js']) {
    try {
      h.update(readFileSync(path.join(ROOT, 'src', f)));
    } catch {}
  }
  h.update(JSON.stringify(getCustomRules()));
  h.update(JSON.stringify(srcs.map((s) => [s.id, s.strictness || 'normal'])));
  return h.digest('hex').slice(0, 16);
}

/**
 * 모든 글을 지금 규칙으로 다시 판정한다. 제목 기준으로 판정하고, 본문 검사 표시(bodyChecked)를 지워
 * 다음 미리보기 때 본문을 새 규칙으로 다시 검사하게 한다 (허용 단어로 본문 오탐을 풀 수 있게).
 * @returns {Promise<number>} 상태가 바뀐 글 수
 */
async function rejudgeAll() {
  const list = await loadSources();
  const srcs = Object.fromEntries(list.map((s) => [s.id, s]));
  const med = currentMedians();
  let changed = 0;
  for (const p of store.allPosts()) {
    const before = p.status;
    p.auto = classify(p, srcs[p.source] || {});
    if (p.bodyChecked) {
      p.bodyChecked = false;
      forgetCached(p.id);
    }
    p.status = store.resolveStatus(p);
    if (p.status !== before) {
      changed++;
      rescorePost(p, med);
    }
    store.upsertPost(p);
  }
  store.updateSettings({ rulesHash: rulesFingerprint(list) }); // updateSettings 가 바로 저장한다
  return changed;
}

/** 서버 시작 시: 기본 규칙(filter-rules.js 등)이 지난 실행과 달라졌으면 기존 글을 다시 판정 */
async function rejudgeIfRulesChanged() {
  const hash = rulesFingerprint(await loadSources());
  const prev = store.getSettings().rulesHash;
  if (prev === hash) return;
  const changed = await rejudgeAll();
  if (store.allPosts().length) console.log(`[filter] 판정 규칙이 바뀌어 저장된 글을 다시 판정했어요 (상태가 바뀐 글 ${changed}개)`);
}

app.get('/api/admin/rules', requireAdmin, (req, res) => res.json(getCustomRules()));
app.post(
  '/api/admin/rules',
  requireJson,
  requireAdmin,
  wrap(async (req, res) => {
    const rules = saveCustomRules(req.body || {});
    // 바뀐 규칙으로 모든 글을 다시 판정
    const changed = await rejudgeAll();
    res.json({ rules, changed });
  }),
);

// ---------- 이미지/영상 프록시 (핫링크 차단 사이트용, 소스별 허용 호스트만) ----------

/** 파일 앞부분으로 이미지/영상 형식 판별. SVG·HTML 등 스크립트를 품을 수 있는 형식은 null. */
function sniffMedia(b) {
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG') return 'image/png';
  if (b.toString('latin1', 0, 4) === 'GIF8') return 'image/gif';
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (b.toString('latin1', 0, 2) === 'BM') return 'image/bmp';
  if (b.toString('latin1', 4, 8) === 'ftyp') {
    const brand = b.toString('latin1', 8, 12);
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
    if (brand === 'heic' || brand === 'heix' || brand === 'mif1') return 'image/heic';
    if (brand.startsWith('qt')) return 'video/quicktime';
    return 'video/mp4';
  }
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'video/webm';
  if (b.toString('latin1', 0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return 'audio/mpeg';
  return null;
}

// 남용 방지: 접속자당 분당 요청 수, 동시 연결 수(전체·접속자당), 응답 크기 상한
const imgRate = new Map(); // clientKey -> {n, resetAt}
const imgActive = new Map(); // clientKey -> 지금 열려 있는 연결 수
let imgActiveTotal = 0;
setInterval(() => {
  const now = Date.now();
  for (const [k, r] of imgRate) if (r.resetAt <= now) imgRate.delete(k);
}, 60e3).unref();

app.get(
  '/api/img',
  wrap(async (req, res) => {
    const lim = config.imgProxy;
    const key = clientKey(req);
    const now = Date.now();
    let rate = imgRate.get(key);
    if (!rate || rate.resetAt <= now) imgRate.set(key, (rate = { n: 0, resetAt: now + 60e3 }));
    if (++rate.n > lim.perMin) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((rate.resetAt - now) / 1000))));
      return res.status(429).end();
    }
    if (imgActiveTotal >= lim.maxConcurrent || (imgActive.get(key) || 0) >= lim.maxConcurrentPerIp) {
      res.setHeader('Retry-After', '1');
      return res.status(429).end();
    }
    imgActiveTotal++;
    imgActive.set(key, (imgActive.get(key) || 0) + 1);
    let released = false;
    const ac = new AbortController();
    let stream = null;
    // 응답이 끝나거나 클라이언트가 끊으면 자리를 돌려주고, 끊긴 경우엔 원본 다운로드도 바로 멈춘다 (fetch 전에 건다)
    res.on('close', () => {
      if (!released) {
        released = true;
        imgActiveTotal--;
        const n = (imgActive.get(key) || 1) - 1;
        if (n > 0) imgActive.set(key, n);
        else imgActive.delete(key);
      }
      if (!res.writableFinished) {
        ac.abort();
        stream?.destroy();
      }
    });

    const src = await getSource(String(req.query.s || ''));
    let u;
    try {
      u = new URL(String(req.query.u || ''));
    } catch {
      return res.status(400).end();
    }
    if (!src || !/^https?:$/.test(u.protocol) || !hostMatches(u.hostname, src.imageHosts)) return res.status(403).end();
    try {
      const headers = { accept: 'image/avif,image/webp,image/apng,image/*,video/*,*/*;q=0.8' };
      if (req.headers.range) headers.range = req.headers.range;
      // 리다이렉트는 직접 따라가며 매번 허용 호스트인지 확인 (허용 호스트가 내부 주소로 돌려보내는 SSRF 방지)
      // 시간 제한: 전체 시간이 아니라 "응답이 시작될 때까지 20초" + "데이터가 30초 동안 안 오면" 만 끊는다.
      // (전체 시간으로 끊으면 큰 움짤·영상이 받는 도중 잘려서 이미지 위쪽만 보이는 문제가 생긴다)
      let idleTimer = setTimeout(() => ac.abort(), 20000);
      const bumpIdle = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => ac.abort(), 30000);
      };
      res.on('close', () => clearTimeout(idleTimer));
      let up;
      for (let hop = 0; ; hop++) {
        up = await fetchRaw(u.toString(), { referer: src.referer, headers, throttle: false, timeout: 0, redirect: 'manual', signal: ac.signal });
        const loc = up.status >= 300 && up.status < 400 ? up.headers.get('location') : null;
        if (!loc) break;
        await up.body?.cancel().catch(() => {});
        if (hop >= 3) return res.status(508).end();
        u = new URL(loc, u);
        if (!/^https?:$/.test(u.protocol) || !hostMatches(u.hostname, src.imageHosts)) return res.status(403).end();
      }
      const ct = up.headers.get('content-type') || '';
      if (!(up.ok || up.status === 206) || !/^(image|video|audio)\/|^application\/octet-stream/.test(ct)) {
        await up.body?.cancel().catch(() => {});
        return res.status(up.ok ? 415 : up.status === 404 ? 404 : 502).end();
      }
      const declared = Number(up.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > lim.maxBytes) {
        await up.body?.cancel().catch(() => {});
        return res.status(413).end();
      }
      // 앞부분 바이트로 실제 형식을 확인한다 (디시처럼 octet-stream 으로 주는 곳, 이미지인 척하는 SVG/HTML 차단)
      bumpIdle();
      const reader = up.body?.getReader();
      const first = reader ? await reader.read() : { done: true };
      const head = first.value ? Buffer.from(first.value) : Buffer.alloc(0);
      let type = sniffMedia(head);
      // 영상의 중간 구간(Range) 요청은 앞부분이 없어 판별할 수 없으니 원래 형식(또는 octet-stream)으로 넘긴다
      if (!type && up.status === 206 && !/^bytes 0-/.test(up.headers.get('content-range') || '')) {
        type = /^(video|audio)\//.test(ct) ? ct.split(';')[0] : 'application/octet-stream';
      }
      if (!type) {
        await reader?.cancel().catch(() => {});
        return res.status(415).end();
      }
      res.status(up.status);
      res.setHeader('Content-Type', type);
      for (const h of ['content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag']) {
        const v = up.headers.get(h);
        if (v) res.setHeader(h, v);
      }
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
      let sent = 0;
      stream = Readable.from(
        (async function* () {
          if (head.length) {
            sent += head.length;
            yield head;
          }
          if (first.done) return;
          for (;;) {
            bumpIdle();
            const { done, value } = await reader.read();
            if (done) {
              clearTimeout(idleTimer);
              return;
            }
            sent += value.byteLength;
            // content-length 가 없거나 거짓인 응답도 상한에서 끊는다
            if (sent > lim.maxBytes) throw new Error('응답이 너무 큼');
            yield Buffer.from(value);
          }
        })(),
      );
      stream.on('error', () => {
        ac.abort();
        reader?.cancel().catch(() => {});
        res.destroy();
      });
      stream.pipe(res);
    } catch {
      if (!res.headersSent && !res.destroyed) res.status(504).end();
    }
  }),
);

// ---------- 정적 파일 ----------
app.use(express.static(path.join(ROOT, 'public'), { extensions: ['html'], maxAge: '5m' }));
app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));

// ---------- 오류 처리: 스택·경로를 응답에 노출하지 않는다 (잘못된 JSON 400, 너무 큰 본문 413 등은 상태 코드 유지) ----------
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const raw = Number(err?.status || err?.statusCode);
  const status = raw >= 400 && raw < 600 ? raw : 500;
  if (status >= 500) console.error('[server]', err);
  if (res.headersSent) return res.destroy();
  res.status(status).json({ error: status < 500 ? '잘못된 요청이에요' : '서버 오류가 났어요' });
});

// 마지막 안전망: 어디선가 놓친 promise 오류로 서버 전체가 죽지 않게 기록만 한다
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));

// ---------- 시작 ----------
try {
  await rejudgeIfRulesChanged();
} catch (e) {
  console.error(`[filter] 시작 재판정 실패: ${e.message}`);
}

/** 콘솔에 보여줄 비밀번호 줄: 처음 만든 실행에만 값을 보여주고, 그 뒤로는 파일 위치만 */
function passwordLine(fromEnv, envName, created, value) {
  if (fromEnv) return `(${envName} 환경변수)`;
  if (created) return `${value}   ← 방금 새로 만들었어요. 지금 적어 두세요 (다음 실행부터는 화면에 보여주지 않아요)`;
  return `(${config.secretsFile} 에 있어요)`;
}

const server = app.listen(config.port, config.host, () => {
  const port = server.address()?.port ?? config.port;
  console.log(`\n  ${config.siteName} — http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${port}`);
  console.log(`  잠금 게시판 비밀번호: ${passwordLine(config.passwordsFromEnv.adult, 'ADULT_PASSWORD', config.secretsCreated?.adult, config.adultPassword)}`);
  console.log(`  관리자 비밀번호:     ${passwordLine(config.passwordsFromEnv.admin, 'ADMIN_PASSWORD', config.secretsCreated?.admin, config.adminPassword)}`);
  console.log(`  (비밀번호는 ${config.secretsFile} 또는 .env 에서 바꿀 수 있어요. 바꾸고 다시 시작하면 기존 로그인은 풀려요)`);
  console.log(`  Claude 검수: ${config.ai.enabled ? `켜짐 (${config.ai.model})` : '꺼짐 — .env 에 ANTHROPIC_API_KEY 를 넣으면 켜져요'}\n`);
  startScheduler();
});
