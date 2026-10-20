// 사이트 API: 경로·응답 모양을 한 곳에 둔다. 로컬 express(src/server.js)와 클라우드 Durable Object(worker/site.js)가 같은 핸들러를 쓴다.
// 실시간 연결(/api/events)·이미지 프록시(/api/img)·정적 파일은 각 실행 환경이 따로 맡는다.
//
// 요청(ApiRequest): { method, path, query(name), header(name), body, isJson, ip, secure, isLocal }
//   - query/header 는 문자열 또는 undefined 를 돌려주는 함수, header 이름은 소문자
//   - isLocal: 이 컴퓨터에서 온 요청 (로컬 스크립트의 x-admin-key 용. 클라우드는 늘 false)
// 응답(ApiResponse): { status, body, headers?, cookies? } — body 는 JSON 으로 보낼 값(null 이면 본문 없음)
// 경로가 없으면 handle() 이 null 을 돌려준다 (각 실행 환경이 404 로).
import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';
import { config } from './config.js';
import * as store from './store.js';
import { isPending, isPublic, groupIndex } from './store.js';
import { loadSources, getSource } from './sources/index.js';
import { liveState, setLive, activeSources, rescoreAll, rescorePost, schedule, isRunning, ingestFromPc, selectionScores, pcReadData, checkBody } from './crawler.js';
import { CRITERIA_VERSION } from './criteria.js';
import { readPost, forgetCached } from './reader.js';
import { getCustomRules, saveCustomRules } from './filter.js';
import { aiStatus } from './ai.js';
import { boardPosts, sortPosts, vibeOf, storyWorthy, alsoOnOf, sourceShown, STORY_VIBE_MIN, topicVisible } from './boards.js';
import { TOPIC_IDS, cleanTopics, topicsOf } from './topics.js';
import { ruleCaps } from './model/score.js';
import { rejudgeAll } from './rejudge.js';
import { applyImport, postList, POST_MAX_CHARS } from './importer.js';

export { PICK_MIN, STORY_VIBE_MIN } from './boards.js';

export const COOKIE_ADULT = 'hg_adult';
export const COOKIE_ADMIN = 'hg_admin';
const VERDICTS = ['ok', 'politics', 'hate', 'dark', 'adult', 'not_humor'];

/** 처리 중에 던지면 그 상태 코드와 문구로 JSON 응답 */
export class ApiError extends Error {
  constructor(status, message = '잘못된 요청이에요') {
    super(message);
    this.status = status;
  }
}

const res = (status, body, extra = {}) => ({ status, body, ...extra });
const ok = (body) => res(200, body);

// ---------- 접속자 키·시도 제한 ----------

/** 요청 수 제한용 접속자 키: IPv4 는 그대로, IPv6 는 /64 대역으로 묶는다 */
export function clientKeyOf(rawIp) {
  const ip = String(rawIp || '').split('%')[0].trim();
  if (!ip) return 'unknown';
  if (ip.startsWith('::ffff:') && ip.includes('.')) return ip.slice(7);
  if (!ip.includes(':')) return ip;
  let groups;
  if (ip.includes('::')) {
    const [h, t] = ip.split('::');
    const hs = h ? h.split(':') : [];
    const ts = t ? t.split(':') : [];
    groups = [...hs, ...Array(Math.max(0, 8 - hs.length - ts.length)).fill('0'), ...ts];
  } else groups = ip.split(':');
  return `${groups.slice(0, 4).map((x) => x.toLowerCase().padStart(4, '0')).join(':')}::/64`;
}

// 비밀번호 시도 제한: 잠금 해제·관리자 로그인을 따로 세고, 틀린 시도만 센다 (접속자당 10분에 10번)
export const ATTEMPT_WINDOW_MS = 10 * 60e3;
export const MAX_FAILS = 10;

/** 메모리 시도 기록 (로컬). 클라우드는 DO 저장소에 둔다(worker/storage.js) — 모양: limited/fail/clear */
export function memoryAttempts() {
  const maps = { unlock: new Map(), admin: new Map() };
  return {
    limited(kind, key, now) {
      const a = maps[kind].get(key);
      return !!a && a.resetAt > now && a.n >= MAX_FAILS;
    },
    fail(kind, key, now) {
      const m = maps[kind];
      if (m.size > 1000) for (const [k, a] of m) if (a.resetAt <= now) m.delete(k);
      const a = m.get(key);
      if (!a || a.resetAt <= now) m.set(key, { n: 1, resetAt: now + ATTEMPT_WINDOW_MS });
      else a.n++;
    },
    clear(kind, key) {
      maps[kind].delete(key);
    },
  };
}

/** 메모리 옮기기 대기열 (클라우드는 DO 저장소에 둔다) — 모양: begin/is/add/count/take/clear */
export function memoryStaging() {
  let id = null;
  let posts = [];
  return {
    begin(next) {
      id = next;
      posts = [];
    },
    is: (x) => !!id && x === id,
    add(x, list) {
      posts.push(...list);
      return posts.length;
    },
    count: () => posts.length,
    take: () => posts,
    clear() {
      id = null;
      posts = [];
    },
  };
}

// ---------- 서명 쿠키 (잠금 게시판 / 관리자) ----------

function sign(value) {
  const mac = createHmac('sha256', config.sessionSecret).update(value).digest('base64url');
  return `${value}.${mac}`;
}
/** 비밀번호에서 만든 짧은 꼬리표. 쿠키에 넣어 두어 비밀번호를 바꾸면 이미 발급된 쿠키가 모두 무효가 된다. */
function pwTag(kind) {
  const pw = kind === 'admin' ? config.adminPassword : config.adultPassword;
  return createHmac('sha256', config.sessionSecret).update(`pw|${kind}|${pw}`).digest('base64url').slice(0, 16);
}
function verify(token, kind) {
  if (!config.sessionSecret || !token || typeof token !== 'string' || token.length > 512) return false;
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
  if (req._cookies) return req._cookies;
  const out = Object.create(null);
  for (const part of String(req.header('cookie') || '').split(';')) {
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
  return (req._cookies = out);
}
/** HTTPS(프록시가 X-Forwarded-Proto 로 알려준 경우 포함)면 Secure. COOKIE_SECURE=1/0 으로 강제(클라우드는 늘 Secure). */
const secureAttr = (req) => ((config.cookieSecure ?? req.secure) ? '; Secure' : '');
function authCookie(req, name, kind, hours) {
  const exp = Date.now() + hours * 3600e3;
  return `${name}=${encodeURIComponent(sign(`${kind}:${exp}:${pwTag(kind)}`))}; Path=/; HttpOnly; SameSite=Strict${secureAttr(req)}; Max-Age=${hours * 3600}`;
}
const clearCookie = (req, name) => `${name}=; Path=/; HttpOnly; SameSite=Strict${secureAttr(req)}; Max-Age=0`;

function safeEqual(a, b) {
  const x = createHmac('sha256', 'cmp').update(String(a)).digest();
  const y = createHmac('sha256', 'cmp').update(String(b)).digest();
  return timingSafeEqual(x, y);
}

function isAdmin(req) {
  if (req._admin !== undefined) return req._admin;
  const key = req.header('x-admin-key');
  return (req._admin =
    verify(cookies(req)[COOKIE_ADMIN], 'admin') ||
    // 이 컴퓨터에서 도는 스크립트(검수 결과 넣기·예약 작업)용: 로컬 접속 + x-admin-key 헤더 (클라우드는 isLocal 이 늘 false)
    (!!req.isLocal && !!config.adminPassword && typeof key === 'string' && safeEqual(key, config.adminPassword)));
}
const isAdult = (req) => isAdmin(req) || verify(cookies(req)[COOKIE_ADULT], 'adult');

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
    alsoOn: alsoOnOf(p, groups),
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
      topics: topicsOf(p),
      manualTopics: Array.isArray(p.manualTopics) ? p.manualTopics : null,
    });
  }
  return o;
}

// ---------- 판정 대기열의 미리보기 요약 ----------
const QUEUE_TEXT_CHARS = 1500;
const QUEUE_BEST_COMMENTS = 5;
const QUEUE_COMMENT_CHARS = 200;
const QUEUE_IMAGES = 3;
const unescapeAttr = (s) =>
  s.replace(/&(amp|quot|lt|gt|#39|#x27);/g, (m, k) => ({ amp: '&', quot: '"', lt: '<', gt: '>', '#39': "'", '#x27': "'" })[k]);

/** 정리된 본문 HTML 에서 이미지 주소 (나온 순서, 영상은 표지 그림). /api/img 프록시 주소는 direct:false */
export function imagesOf(html, max = QUEUE_IMAGES) {
  const out = [];
  const re = /<(img|video)\b([^>]*)>/gi;
  for (let m; (m = re.exec(String(html || ''))) && out.length < max; ) {
    const attr = m[1].toLowerCase() === 'img' ? 'src' : 'poster';
    const v = new RegExp(`\\s${attr}="([^"]*)"`, 'i').exec(m[2]);
    if (!v) continue;
    const src = unescapeAttr(v[1]);
    const proxied = src.startsWith('/api/img?');
    if (!proxied && !/^https?:\/\//i.test(src)) continue; // data: 등은 넣지 않는다
    if (out.some((x) => x.src === src)) continue;
    out.push({ src, direct: !proxied });
  }
  return out;
}

/** 미리보기(readPost 결과 모양) → 판정용 요약: 본문 앞부분, 베스트(없으면 추천 많은) 댓글 몇 개, 이미지 주소 최대 3개 */
export function summarizeRead(data, from) {
  const comments = (Array.isArray(data?.comments) ? data.comments : []).filter((c) => c && c.text);
  const best = [...comments.filter((c) => c.best), ...comments.filter((c) => !c.best).sort((a, b) => (b.likes ?? 0) - (a.likes ?? 0))]
    .slice(0, QUEUE_BEST_COMMENTS)
    .map((c) => ({ text: String(c.text).slice(0, QUEUE_COMMENT_CHARS), likes: c.likes ?? null, best: !!c.best }));
  const text = String(data?.text || '');
  return {
    from,
    text: text.slice(0, QUEUE_TEXT_CHARS),
    textLength: text.length,
    mediaCount: data?.mediaCount ?? 0,
    commentTotal: data?.commentTotal ?? null,
    bestComments: best,
    images: imagesOf(data?.html),
  };
}

/**
 * 옛 기준 판정 다시 보기(review-queue?revisit=1) 대상: Claude 판정이 있지만 지금 기준 표시(ai.criteria = CRITERIA_VERSION)가 없고,
 * 유머 아님(not_humor)이거나 정상인데 분위기 점수가 핸드드립 기준(STORY_VIBE_MIN)에 못 미치는 글 — 새 기준(잡학 통과)이면 들 수 있는 글.
 * 관리자가 상태나 핸드드립 넣기/빼기를 정한 글, 키워드·본문 판정이 차단·므흣인 글, 금지 소재 상한(점수 모델 규칙)에 걸린 글,
 * 대표 글이 남아 있는 사본은 뺀다.
 */
function revisitable(p) {
  const a = p.ai;
  if (!a || a.criteria === CRITERIA_VERSION) return false;
  const lowVibe = a.verdict === 'ok' && !(typeof a.vibe === 'number' && a.vibe >= STORY_VIBE_MIN);
  if (a.verdict !== 'not_humor' && !lowVibe) return false;
  if (p.manual || typeof p.manualVibe === 'boolean') return false;
  if ((p.auto?.status || 'ok') !== 'ok' || p.nsfwHint) return false;
  if (p.dupOf && store.getPost(p.dupOf)) return false;
  const caps = ruleCaps(p);
  return caps.funny >= 100 && caps.vibe >= 100;
}

function decodeParam(raw) {
  try {
    const id = decodeURIComponent(raw);
    if (id && id.length <= 300) return id;
  } catch {}
  throw new ApiError(400);
}

/**
 * @param {{
 *   crawlNow: () => {started: boolean, running: boolean},
 *   onChange?: () => void,
 *   publish?: {status: () => Promise<any>, now: (o: {force: boolean}) => any},
 *   attempts?: ReturnType<typeof memoryAttempts>,
 *   staging?: ReturnType<typeof memoryStaging>,
 *   afterImport?: () => void,
 *   warnProxy?: (req: any) => void,
 * }} host 실행 환경이 맡는 일
 *   - crawlNow: '지금 수집' (로컬: 바로 시작, 클라우드: 알람으로 넘김)
 *   - onChange: 관리자 변경·본문 검사로 글 상태가 바뀌었을 때 (로컬: 공개 사이트 업로드 예약)
 *   - publish: 공개 사이트 업로드 (로컬만) / staging·afterImport: 클라우드로 옮기기 (클라우드만)
 */
export function createApi(host) {
  const attempts = host.attempts || memoryAttempts();
  const changed = () => host.onChange?.();
  const cloud = config.mode === 'cloud';

  const requireJson = (req) => (req.isJson ? null : res(415, { error: 'JSON 요청만 받아요' }));
  const requireAdmin = (req) => (isAdmin(req) ? null : res(401, { error: '관리자 로그인이 필요해요' }));

  // ---------- 공개 ----------

  async function meta(req) {
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
    for (const t of TOPIC_IDS) boardCounts[t] = count(t);
    if (adult) boardCounts.adult = count('adult');
    if (admin) {
      boardCounts.filtered = count('filtered');
      boardCounts.shorts = count('shorts');
    }
    const lv = liveState();
    const publish = admin && host.publish ? await host.publish.status() : null;
    return ok({
      siteName: config.siteName,
      // 클라우드(Cloudflare)에서 도는 사이트: 화면이 SSE 대신 주기적으로 /api/meta 를 다시 받는다
      ...(cloud ? { mode: 'cloud' } : {}),
      pickCount: boardCounts.pick,
      boardCounts,
      adult,
      admin,
      live: { live: lv.live, lastCrawlAt: lv.lastCrawlAt, ...(admin ? lv : {}) },
      // 방문자에게는 수집 중인 출처와, 수집을 껐어도(disabled·SOURCES·DISABLE_SOURCES) 아직 공개 글이 남은 출처를 보낸다.
      // 그 글들은 전체 게시판에 계속 나오므로, 빼면 화면의 출처 배지·"같은 글:" 배지가 이름 대신 id 로 보인다.
      sources: sources
        .map((s) => ({ s, n: count(s.id) }))
        .filter(({ s, n }) => sourceShown(s.id, active, n, admin))
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
            ...(config.secretsFile ? { secretsFile: config.secretsFile } : {}),
            // 공개 사이트(Cloudflare Worker) 업로드 상태 (로컬만)
            ...(host.publish ? { publish } : {}),
          }
        : {}),
    });
  }

  function listPosts(req) {
    const admin = isAdmin(req);
    const board = String(req.query('board') || 'all');
    const sortQ = req.query('sort');
    const sort = ['new', 'hot', 'shorts'].includes(sortQ) ? sortQ : 'new';
    const size = Math.max(5, Math.min(100, Number(req.query('size')) || 30));
    const page = Math.max(1, Math.floor(Number(req.query('page')) || 1));
    const q = String(req.query('q') || '').trim().toLowerCase().slice(0, 50);
    const stage = String(req.query('stage') || '');

    let posts = boardPosts(board, { admin, adult: board === 'adult' && isAdult(req), stage });
    if (!posts) return board === 'adult' ? res(403, { error: 'locked' }) : res(401, { error: '관리자 전용' });
    if (q) posts = posts.filter((p) => p.title.toLowerCase().includes(q));
    if (board === 'shorts' && sort === 'new') posts.sort((a, b) => String(b.shorts.updatedAt).localeCompare(String(a.shorts.updatedAt)));
    else sortPosts(posts, sort);

    const groups = groupIndex(store.allPosts());
    const total = posts.length;
    const items = posts.slice((page - 1) * size, page * size).map((p) => serialize(p, { admin, groups }));
    return ok({ board, sort, page, size, total, hasMore: page * size < total, items });
  }

  async function readOne(req, id) {
    const p = store.getPost(id);
    if (!p) return res(404, { error: '글을 찾을 수 없어요 (오래되어 정리됐을 수 있어요)' });
    const admin = isAdmin(req);
    if (p.status === 'adult' && !isAdult(req)) return res(403, { error: 'locked' });
    // 주제 탭의 정보 글(Claude '유머 아님' 판정이지만 그 주제의 글)은 차단 상태여도 연다 (src/boards.js topicVisible)
    if ((p.status === 'blocked' || isPending(p)) && !admin && !topicVisible(p)) return res(404, { error: '볼 수 없는 글이에요' });
    let data;
    if (p.pcRead) {
      // PC 가 받아 올려 준 미리보기 (이 서버가 원문을 못 가져오는 출처). 규칙이 바뀌어 본문 검사가 풀렸으면 다시 본다.
      const src = await getSource(p.source);
      const statusChanged = !!src && checkBody(p, src, p.pcRead.text || '');
      data = { ...pcReadData(p), statusChanged };
    } else {
      try {
        data = await readPost(p);
      } catch (e) {
        // e.busy: 같은 사이트 요청이 밀려 있어 기다리지 않았다 (src/lib/http.js BusyError)
        const why = e.busy ? '잠시 뒤에 다시 해 주세요' : e.status ? `HTTP ${e.status}` : e.message;
        return res(502, { error: `원문을 불러오지 못했어요 (${why})`, url: p.url });
      }
    }
    const fresh = store.getPost(p.id) || p;
    // 본문 검사로 상태가 바뀌었으면 쇼츠 점수도 지금 상태로 (공개→차단이면 10 이하로, 그 반대도)
    if (data.statusChanged) {
      rescorePost(fresh);
      store.upsertPost(fresh);
      changed();
    }
    // 본문 검사로 상태가 바뀌어 이제 볼 수 없게 됐다면 막는다
    if (!admin && ((fresh.status === 'blocked' && !topicVisible(fresh)) || (fresh.status === 'adult' && !isAdult(req)))) {
      return res(409, { error: fresh.status === 'adult' ? '본문을 확인해 보니 그라운즈 게시판 글이라 옮겼어요' : '본문을 확인해 보니 걸러야 할 글이라 숨겼어요', status: fresh.status });
    }
    return ok({ post: serialize(fresh, { admin, groups: groupIndex(store.allPosts()) }), ...data });
  }

  function unlock(req) {
    host.warnProxy?.(req);
    if (!config.adultPassword || !config.sessionSecret) return res(503, { error: '지금은 잠금을 풀 수 없어요' });
    const who = clientKeyOf(req.ip);
    if (attempts.limited('unlock', who, Date.now())) return res(429, { error: '시도가 너무 많아요. 10분 뒤에 다시 해주세요' });
    if (!safeEqual(req.body?.password || '', config.adultPassword)) {
      attempts.fail('unlock', who, Date.now());
      return res(401, { error: '비밀번호가 달라요' });
    }
    attempts.clear('unlock', who);
    return res(200, { ok: true }, { cookies: [authCookie(req, COOKIE_ADULT, 'adult', 12)] });
  }

  // ---------- 관리자 ----------

  function login(req) {
    host.warnProxy?.(req);
    if (!config.adminPassword || !config.sessionSecret) return res(503, { error: '관리자 비밀번호가 설정되지 않았어요' });
    const who = clientKeyOf(req.ip);
    if (attempts.limited('admin', who, Date.now())) return res(429, { error: '시도가 너무 많아요. 10분 뒤에 다시 해주세요' });
    if (!safeEqual(req.body?.password || '', config.adminPassword)) {
      attempts.fail('admin', who, Date.now());
      return res(401, { error: '비밀번호가 달라요' });
    }
    attempts.clear('admin', who);
    return res(200, { ok: true }, { cookies: [authCookie(req, COOKIE_ADMIN, 'admin', 24 * 7)] });
  }

  function updatePost(req, id) {
    const p = store.getPost(id);
    if (!p) return res(404, { error: '없는 글' });
    const b = req.body || {};
    if ('manual' in b) {
      if (b.manual !== null && !['ok', 'adult', 'blocked'].includes(b.manual)) return res(400, { error: 'manual 값 오류' });
      p.manual = b.manual;
      // 관리자 지정이 있는 동안은 runAi·isPending 이 알아서 건너뛰므로 aiPending 은 그대로 둔다.
      // '자동 판정으로' 되돌릴 때 아직 Claude 판정이 없으면 다시 검수 대기열로 (예전 버전에서 지워진 표시도 복구)
      if (b.manual === null && config.ai.enabled && !p.ai && !p.aiGaveUp) p.aiPending = true;
    }
    // 썰·대화 게시판에 넣기(true)/빼기(false)/자동(null)
    if ('vibe' in b) {
      if (b.vibe !== null && typeof b.vibe !== 'boolean') return res(400, { error: 'vibe 값 오류' });
      if (b.vibe === null) delete p.manualVibe;
      else p.manualVibe = b.vibe;
    }
    // 주제 탭(서브컬처·방송) 지정: 목록이면 그 주제로(빈 목록 = 주제 없음), null 이면 Claude 판정대로
    if ('topics' in b) {
      if (b.topics === null) delete p.manualTopics;
      else {
        const t = cleanTopics(b.topics);
        if (!t) return res(400, { error: 'topics 값 오류' });
        p.manualTopics = t;
      }
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
    changed();
    return ok({ ok: true, post: serialize(p, { admin: true, groups: groupIndex(store.allPosts()) }) });
  }

  function live(req) {
    const { live: on, intervalMin } = req.body || {};
    return ok(setLive({ live: typeof on === 'boolean' ? on : undefined, intervalMin: intervalMin != null ? Number(intervalMin) : undefined }));
  }

  /**
   * Claude 검수 대기열: 아직 판정이 없는 최근 7일 글을 선별 점수(점수 모델, 없으면 키워드 점수) 높은 순으로 (PC 판정 루틴·예약 작업용).
   *   ?limit=300  ?vibe=1 (판정은 정상인데 분위기 점수가 없는 글)
   *   ?revisit=1 — 대신 옛 기준 판정 다시 보기 대상(revisitable, 기간 제한 없음)을 점수 모델의 분위기(vibe) 점수 높은 순으로. 항목마다 previousVerdict (옛 판정)
   *   ?withRead=1&readTop=20 — 위에서 readTop 개는 본문 앞부분·베스트 댓글·이미지 주소(최대 3개)도 (본문 검사로 걸러진 글은 뺀다).
   *     PC 미리보기(p.pcRead)가 있는 글은 readTop 밖이어도 붙인다
   * 응답의 criteria: 지금 판정 기준 표시 (판정을 올리면 이 표시로 저장된다)
   */
  async function reviewQueue(req) {
    const limit = Math.max(1, Math.min(1000, Number(req.query('limit')) || 300));
    const names = Object.fromEntries((await loadSources()).map((x) => [x.id, x.name]));
    const since = Date.now() - 7 * 864e5;
    const needVibe = req.query('vibe') === '1';
    const revisit = !needVibe && req.query('revisit') === '1';
    const all = store.allPosts();
    const recent = (p) => new Date(p.firstSeenAt).getTime() > since;
    const waitingOf = (vibe) =>
      all.filter((p) =>
        vibe ? p.ai?.verdict === 'ok' && typeof p.ai.vibe !== 'number' && recent(p) : !p.ai && !p.manual && p.auto?.status !== 'blocked' && recent(p),
      );
    const revisitList = all.filter(revisitable);
    const waiting = revisit ? revisitList : waitingOf(needVibe);
    const scores = await selectionScores(waiting);
    // 다시 보기는 "핸드드립" 후보를 찾는 일이라 분위기 점수를 먼저 본다
    const key = revisit ? (s) => s.vibe * 1000 + s.priority : (s) => s.priority;
    let picked = waiting
      .sort((a, b) => key(scores.get(b.id)) - key(scores.get(a.id)) || String(b.firstSeenAt).localeCompare(String(a.firstSeenAt)) || a.id.localeCompare(b.id))
      .slice(0, limit);

    const reads = new Map();
    if (req.query('withRead') === '1') {
      const top = Math.max(1, Math.min(40, Number(req.query('readTop')) || 20));
      for (const [id, r] of await readsFor(picked.slice(0, top))) reads.set(id, r);
      // PC 가 올려 준 미리보기가 있는 글은 readTop 밖이어도 붙인다 (저장된 것이라 원문 요청이 없다 — PC 가 같은 글을 다시 읽지 않게)
      for (const p of picked.slice(top)) {
        if (!p.pcRead) continue;
        await recheckPcRead(p);
        reads.set(p.id, { read: summarizeRead(pcReadData(p), 'pc') });
      }
      // 본문 검사로 이제 걸러진 글은 판정할 필요가 없다 (키워드와 Claude 중 더 엄격한 쪽을 따르므로). 다시 보기는 므흣이 된 글도 뺀다.
      picked = picked.filter((p) => {
        const fresh = store.getPost(p.id);
        return needVibe || (revisit ? !!fresh && revisitable(fresh) : fresh?.auto?.status !== 'blocked');
      });
    }
    let lastVerdictAt = null;
    for (const p of all) if (p.ai?.at && (!lastVerdictAt || p.ai.at > lastVerdictAt)) lastVerdictAt = p.ai.at;

    const items = picked.map((p) => {
      const s = scores.get(p.id);
      const o = {
        id: p.id,
        source: p.source,
        sourceName: names[p.source] || p.source,
        title: p.title,
        url: p.url,
        category: p.category,
        likes: p.likes,
        comments: p.commentCount,
        views: p.views,
        postedAt: p.postedAt,
        firstSeenAt: p.firstSeenAt,
        auto: p.auto?.status,
        dupOf: p.dupOf || null,
        modelScore: { funny: s.funny, vibe: s.vibe },
        priority: s.priority,
        scoredBy: s.by,
        ...(needVibe ? { ai: { verdict: p.ai.verdict, shortsScore: p.ai.shortsScore, reason: p.ai.reason } } : {}),
        ...(revisit
          ? {
              previousVerdict: {
                verdict: p.ai.verdict,
                shortsScore: p.ai.shortsScore ?? null,
                vibe: typeof p.ai.vibe === 'number' ? p.ai.vibe : null,
                reason: p.ai.reason || '',
                model: p.ai.model || null,
                at: p.ai.at || null,
              },
            }
          : {}),
      };
      if (reads.has(p.id)) Object.assign(o, reads.get(p.id));
      return o;
    });
    return ok({
      total: items.length,
      waiting: waiting.length,
      waitingVibe: needVibe ? waiting.length : waitingOf(true).length,
      waitingRevisit: revisitList.length,
      ...(revisit ? { revisit: true } : {}),
      criteria: CRITERIA_VERSION,
      lastVerdictAt,
      scoredBy: items.some((x) => x.scoredBy === 'model') ? 'model' : 'rule',
      items,
    });
  }

  /** PC 미리보기가 있는 글: 본문 검사가 풀려 있으면(규칙 재판정 뒤) 저장된 본문으로 다시 검사하고, 상태가 바뀌면 점수·변경 알림까지 */
  async function recheckPcRead(p) {
    if (!p.pcRead || p.bodyChecked) return false;
    const src = await getSource(p.source);
    if (!src || !checkBody(p, src, p.pcRead.text || '')) return false;
    rescorePost(p);
    store.upsertPost(p);
    changed();
    return true;
  }

  /** 판정 대기열에 붙일 미리보기 요약. PC 미리보기 → 캐시 → 원문 순으로, 원문은 정해진 시간 안에 온 것만. */
  const QUEUE_READ_BUDGET_MS = 25e3;
  async function readsFor(posts) {
    const out = new Map();
    const one = async (p) => {
      try {
        let data;
        let from = 'pc';
        if (p.pcRead) {
          // 규칙이 바뀌어 본문 검사가 풀렸으면 저장된 본문으로 다시 본다 (미리보기 API 와 같게 — 걸러지면 아래에서 빠진다)
          await recheckPcRead(p);
          data = pcReadData(p);
        } else {
          from = 'site';
          data = await readPost(p);
          if (data.statusChanged) {
            const fresh = store.getPost(p.id);
            if (fresh) {
              rescorePost(fresh);
              store.upsertPost(fresh);
              changed();
            }
          }
        }
        out.set(p.id, { read: summarizeRead(data, from) });
      } catch (e) {
        out.set(p.id, { read: null, readError: e?.busy ? '요청이 밀려 있어요' : e?.status ? `HTTP ${e.status}` : String(e?.message || e).slice(0, 100) });
      }
    };
    let timer;
    const budget = new Promise((r) => {
      timer = setTimeout(r, QUEUE_READ_BUDGET_MS);
    });
    await Promise.race([Promise.all(posts.map(one)), budget]);
    clearTimeout(timer);
    // 시간 안에 못 받은 글은 표시만 (받던 것은 계속 받아 캐시에 남으니 다음 대기열에서는 바로 나온다)
    for (const p of posts) if (!out.has(p.id)) out.set(p.id, { read: null, readError: '시간 초과' });
    return out;
  }

  /**
   * Claude 검수 결과 넣기: {model, items: [{id, verdict, shortsScore, reason, vibe?}]}
   * verdict 가 있는 항목은 그 글의 판정(p.ai)을 통째로 바꾸고 지금 기준 표시(criteria)를 남긴다 — 이미 판정이 있어도 덮어쓴다
   * (같은 판정 파일을 고쳐 다시 올리기, 옛 기준 다시 보기가 이걸 쓴다). 판정이 있는 글이 다시 판정되지 않게 하는 건 대기열 쪽이다:
   * 기본 대기열은 판정 없는 글만, 다시 보기(revisit=1)는 지금 기준 표시가 없는 글만 준다.
   * verdict 없이 vibe 만 있으면 판정은 그대로 두고 분위기 점수만 바꾼다 (기준 표시도 그대로).
   */
  function verdicts(req) {
    const model = String(req.body?.model || 'claude').slice(0, 60);
    const at = new Date().toISOString();
    let applied = 0;
    const skipped = [];
    const vibeNum = (v) => (v === undefined || v === null || !Number.isFinite(Number(v)) ? undefined : Math.max(0, Math.min(100, Math.round(Number(v)))));
    for (const it of Array.isArray(req.body?.items) ? req.body.items.slice(0, 2000) : []) {
      const p = store.getPost(String(it?.id || ''));
      const topics = cleanTopics(it?.topics);
      // 판정은 그대로 두고 "썰·대화" 분위기 점수나 주제(topics)만 넣는 경우
      if (p && p.ai && it && it.verdict === undefined && (vibeNum(it.vibe) !== undefined || topics)) {
        p.ai = { ...p.ai };
        if (vibeNum(it.vibe) !== undefined) p.ai.vibe = vibeNum(it.vibe);
        if (topics) p.ai.topics = topics;
        store.upsertPost(p);
        applied++;
        continue;
      }
      if (!p || !VERDICTS.includes(it.verdict)) {
        skipped.push(it?.id);
        continue;
      }
      p.ai = { verdict: it.verdict, shortsScore: Math.max(0, Math.min(100, Math.round(Number(it.shortsScore) || 0))), reason: String(it.reason || '').slice(0, 60), model, at, criteria: CRITERIA_VERSION };
      if (vibeNum(it.vibe) !== undefined) p.ai.vibe = vibeNum(it.vibe);
      // 주제는 정상·유머 아님 판정에만 (정치·혐오·사건사고·그라운즈 글은 주제 탭에도 안 보인다)
      if (topics?.length && (it.verdict === 'ok' || it.verdict === 'not_humor')) p.ai.topics = topics;
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
    if (applied) changed();
    return ok({ applied, skipped });
  }

  async function ingest(req) {
    const out = await ingestFromPc(req.body);
    if (out.status === 200 && (out.body.added || out.body.statusChanged || out.body.reads.stored)) changed();
    return res(out.status, out.body);
  }

  async function saveRules(req) {
    const rules = saveCustomRules(req.body || {});
    // 바뀐 규칙으로 모든 글을 다시 판정
    const n = await rejudgeAll();
    if (n) changed();
    return ok({ rules, changed: n });
  }

  // 공개 사이트(Cloudflare Worker)로 지금 올리기 (로컬만). 오래 걸릴 수 있어 바로 202 로 답하고, 결과는 /api/meta 의 publish 로 본다.
  async function publishNow() {
    const st = await host.publish.status();
    if (!st.enabled) return res(409, { error: st.lastError || '공개 사이트 업로드가 꺼져 있어요 (.env 의 PUBLISH_URL·PUBLISH_TOKEN)' });
    host.publish.now({ force: true });
    return res(202, { started: !st.running, running: true });
  }

  /**
   * 클라우드로 옮기기 (클라우드만): 로컬 data/posts.json + custom-rules.json 으로 상태를 통째로 바꾼다.
   * - 한 번에: { posts, sources, lastCrawlAt, settings, rules }
   * - 나눠서: {step:'begin'} → {importId} / {step:'posts', importId, posts:[…]} 여러 번 / {step:'commit', importId, expect, sources, lastCrawlAt, settings, rules}
   *   commit 전에는 지금 상태를 건드리지 않는다.
   */
  async function importData(req) {
    const b = req.body || {};
    const st = host.staging;
    const finish = async (raw) => {
      // 수집이 도는 중에 바꾸면 수집 결과가 옮겨 온 상태에 섞인다
      if (isRunning()) return res(409, { error: '지금 수집 중이에요. 끝난 뒤에 다시 해 주세요' });
      const out = await applyImport(b, raw);
      host.afterImport?.();
      schedule(); // 옮겨 온 실시간 설정대로 다시 예약
      return ok({ ok: true, ...out });
    };
    if (b.step === undefined) {
      // 실수로 빈 요청을 보내 모든 글을 지우지 않게, 글 목록은 꼭 있어야 한다 (빈 목록은 [] 로)
      if (!b.posts || typeof b.posts !== 'object') return res(400, { error: '옮길 글(posts)이 없어요' });
      return finish(postList(b.posts));
    }
    if (b.step === 'begin') {
      const importId = randomBytes(12).toString('base64url');
      st.begin(importId);
      return ok({ ok: true, importId });
    }
    if (!st.is(b.importId)) return res(409, { error: '옮기기를 처음부터 다시 시작해 주세요' });
    if (b.step === 'posts') {
      const list = postList(b.posts);
      const fit = list.filter((p) => p && typeof p === 'object' && JSON.stringify(p).length <= POST_MAX_CHARS);
      const staged = st.add(b.importId, fit);
      return ok({ ok: true, received: list.length, staged, skipped: list.length - fit.length });
    }
    if (b.step === 'commit') {
      if (b.expect != null && Number(b.expect) !== st.count()) return res(409, { error: `받은 글 수가 달라요 (${st.count()}/${b.expect})` });
      if (isRunning()) return res(409, { error: '지금 수집 중이에요. 끝난 뒤에 다시 해 주세요' });
      const raw = st.take(b.importId);
      try {
        return await finish(raw);
      } finally {
        st.clear();
      }
    }
    return res(400, { error: '잘못된 요청이에요' });
  }

  /** @returns {Promise<{status: number, body: any, headers?: Record<string, string>, cookies?: string[]}|null>} */
  async function handle(req) {
    try {
      return await route(req);
    } catch (e) {
      if (e instanceof ApiError) return res(e.status, { error: e.message });
      throw e;
    }
  }

  async function route(req) {
    const method = req.method;
    const path = req.path.length > 1 ? req.path.replace(/\/$/, '') : req.path;
    const get = method === 'GET' || method === 'HEAD';
    const post = method === 'POST';
    let m;
    if (get) {
      if (path === '/api/meta') return meta(req);
      if (path === '/api/posts') return listPosts(req);
      if ((m = /^\/api\/posts\/([^/]+)\/read$/.exec(path))) return readOne(req, decodeParam(m[1]));
      if (path === '/api/admin/review-queue') return requireAdmin(req) || reviewQueue(req);
      if (path === '/api/admin/rules') return requireAdmin(req) || ok(getCustomRules());
      return null;
    }
    if (!post) return null;
    switch (path) {
      case '/api/unlock':
        return requireJson(req) || unlock(req);
      case '/api/lock':
        return requireJson(req) || res(200, { ok: true }, { cookies: [clearCookie(req, COOKIE_ADULT)] });
      case '/api/admin/login':
        return requireJson(req) || login(req);
      case '/api/admin/logout':
        return requireJson(req) || res(200, { ok: true }, { cookies: [clearCookie(req, COOKIE_ADMIN)] });
      case '/api/admin/live':
        return requireJson(req) || requireAdmin(req) || live(req);
      case '/api/admin/crawl':
        return requireJson(req) || requireAdmin(req) || res(202, host.crawlNow());
      case '/api/admin/verdicts':
        return requireJson(req) || requireAdmin(req) || verdicts(req);
      case '/api/admin/ingest':
        // PC 가 직접 받은 출처(클라우드에서 막힌 곳)의 목록·미리보기 받아 넣기 (scripts/pc-routine.js collect)
        return requireJson(req) || requireAdmin(req) || ingest(req);
      case '/api/admin/rules':
        return requireJson(req) || requireAdmin(req) || saveRules(req);
      case '/api/admin/publish':
        if (!host.publish) return null;
        return requireJson(req) || requireAdmin(req) || publishNow();
      case '/api/admin/import':
        if (!host.staging) return null;
        return requireJson(req) || requireAdmin(req) || importData(req);
    }
    if ((m = /^\/api\/admin\/posts\/([^/]+)$/.exec(path))) return requireJson(req) || requireAdmin(req) || updatePost(req, decodeParam(m[1]));
    return null;
  }

  return { handle, isAdmin, isAdult };
}
