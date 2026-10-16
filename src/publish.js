// 공개 사이트(Cloudflare Worker)로 올리기. 수집·판정·관리는 이 컴퓨터에서 하고, 방문자에게 보일 결과만 Worker 에 올린다.
// 규약: worker/CONTRACT.md
//   1) GET  /api/sync/status      — Worker 가 살아 있고 토큰이 맞는지 먼저 확인 (안 되면 출처 사이트에 요청하지 않고 끝낸다)
//   2) PUT  /api/sync/read/:id    — 아직 안 올렸거나 바뀐 글의 미리보기 (story → pick → all → adult 순, 한 번에 PUBLISH_READ_LIMIT 개, 한 개씩 차례로)
//   3) PUT  /api/sync/snapshot    — 공개 글 목록 전체. 미리보기 본문 검사로 상태가 바뀔 수 있어 맨 마지막에 계산한다 (hasRead 반영)
// 언제: 서버 시작 시, 수집이 끝날 때마다, 관리자 변경 뒤 30초 안에 한 번. 동시에 두 번 돌지 않고, 실패하면 다음 기회에 다시 한다.
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { config } from './config.js';
import * as store from './store.js';
import { isPublic, groupIndex } from './store.js';
import { loadSources } from './sources/index.js';
import { activeSources, events, rescorePost } from './crawler.js';
import { readPost } from './reader.js';
import { boardPosts, hotScores, alsoOnOf, sourceShown, sortPosts } from './boards.js';

const READ_MAX_BYTES = 1_500_000; // 미리보기 문서 하나의 크기 상한 (규약 1.5MB)
const STATUS_TIMEOUT_MS = 20e3;
const READ_TIMEOUT_MS = 30e3;
const SNAPSHOT_TIMEOUT_MS = 120e3;
const RETRY_MS = 5 * 60e3; // 실패하면 이만큼 뒤에 다시 (그 전에 수집·관리자 변경이 있으면 그때)
const READ_FAIL_MAX = 4; // 원문을 못 읽은 글은 점점 늦게 이만큼까지만 다시 시도 (서버를 다시 켜면 처음부터)
const readFailBackoffMs = (n) => Math.min(15 * 60e3 * 2 ** (n - 1), 6 * 3600e3);

/**
 * 스냅샷에 들어가는 글: 공개 글 전부(출처별 게시판 = 그 출처의 공개 글) + 므흣 게시판 글. 걸러진 글·검수 대기 글은 넣지 않는다.
 * 므흣 글은 므흣 게시판에 나오는 것만 넣는다 (같은 글로 묶여 안 보이는 사본은 빼서, Worker 가 므흣 글을 모두 므흣 게시판으로 세도 로컬과 같게).
 * @returns {{pub: import('./store.js').Post[], adult: import('./store.js').Post[]}}
 */
function snapshotLists(all) {
  return { pub: all.filter(isPublic), adult: boardPosts('adult', { adult: true }, all) };
}
function snapshotIds(all = store.allPosts()) {
  const { pub, adult } = snapshotLists(all);
  return new Set([...pub, ...adult].map((p) => p.id));
}

/** 미리보기를 다시 만들어야 하는지 가늠하는 지문: 제목·주소가 바뀌면(글 수정) 달라진다 */
const hashMemo = new WeakMap(); // 글 객체 → {t, u, h} (관리자 화면이 상태를 자주 물어서)
export function readHash(p) {
  const m = hashMemo.get(p);
  if (m && m.t === p.title && m.u === p.url) return m.h;
  const h = createHash('sha1').update(`${p.title}\n${p.url}`).digest('hex').slice(0, 16);
  hashMemo.set(p, { t: p.title, u: p.url, h });
  return h;
}

/** 지금 글 그대로의 미리보기가 Worker 에 올라가 있는지 */
export const hasRead = (p) => !!p.published && p.published.hash === readHash(p);

const st = {
  running: null, // 지금 도는 작업 (Promise)
  queued: null, // 도는 중에 또 요청이 오면 끝난 뒤 한 번 더: { force, promise, resolve }
  debounceTimer: null,
  retryTimer: null,
  lastOkAt: null,
  lastRunAt: null,
  lastError: null,
  lastSnapshotSig: null, // 마지막으로 올린 스냅샷의 내용 지문 (version·hot 제외) — 바뀐 게 없으면 다시 올리지 않는다
  lastVersion: '',
};
const readFails = new Map(); // id -> { n, nextAt, hash }

/** 'state': 올리기 시작({running: true, …})·끝(publishStatus() 전체) 알림 — 서버가 관리자 화면에 SSE 'publish' 로 보낸다 */
export const publishEvents = new EventEmitter();
const emitDone = () =>
  publishStatus()
    .then((s) => publishEvents.emit('state', s))
    .catch(() => {});

// ---------- Worker 요청 ----------

async function call(method, path, body, timeoutMs) {
  let res;
  try {
    res = await fetch(config.publish.url + path, {
      method,
      headers: {
        authorization: `Bearer ${config.publish.token}`,
        accept: 'application/json',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body,
      redirect: 'manual', // 다른 곳으로 돌려보내면 토큰을 따라 보내지 않고 실패로 본다
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const why = e?.name === 'TimeoutError' ? '시간 초과' : e?.cause?.code || e?.message || String(e);
    throw new Error(`${method} ${path} 연결 실패 (${why})`);
  }
  const text = await res.text().catch(() => '');
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  if (!res.ok) {
    const detail = typeof json?.error === 'string' ? `: ${json.error.slice(0, 120)}` : '';
    const hint = res.status === 401 || res.status === 403 ? ' — PUBLISH_TOKEN 이 Worker 비밀과 같은지 확인하세요' : '';
    throw Object.assign(new Error(`${method} ${path} → HTTP ${res.status}${detail}${hint}`), { status: res.status });
  }
  return json;
}

// ---------- 스냅샷 ----------

/** 여러 출처가 섞이는 게시판: 로컬 인기순이 그 게시판 목록 안에서 백분위를 세므로 게시판별 점수(hotIn)를 따로 올린다 */
const MIXED_BOARDS = ['story', 'pick', 'all'];

/**
 * Worker 로 올릴 공개 글 목록. 각 글의 boards 는 로컬 목록 API(boardPosts)와 정확히 같은 결과다.
 * 인기순 점수는 로컬 인기순(sortPosts 'hot')과 같은 식이다.
 * - hot: 출처별 게시판(그 출처의 공개 글)·므흣 게시판 목록 안에서 센 점수
 * - hotIn: { story, pick, all } 중 이 글이 나오는 게시판마다 그 게시판 목록 안에서 센 점수 (Worker 는 있으면 이것을 쓴다)
 * 시간 감쇠는 모든 글에 같은 비율로 곱해지므로 만든 시각이 달라도 순서는 로컬과 같다.
 */
export async function buildSnapshot(all = store.allPosts(), now = Date.now()) {
  const ids = (list) => new Set(list.map((p) => p.id));
  const { pub, adult } = snapshotLists(all);
  const lists = Object.fromEntries(MIXED_BOARDS.map((b) => [b, boardPosts(b, {}, all)]));
  const member = Object.fromEntries(MIXED_BOARDS.map((b) => [b, ids(lists[b])]));
  const hotIn = Object.fromEntries(MIXED_BOARDS.map((b) => [b, hotScores(lists[b], now)]));
  const bySource = new Map();
  for (const sid of new Set(pub.map((p) => p.source))) bySource.set(sid, ids(boardPosts(sid, {}, all)));
  const hot = new Map([...hotScores(adult, now), ...hotScores(pub, now)]);
  const groups = groupIndex(all);

  const posts = [...pub, ...adult].map((p) => ({
    id: p.id,
    source: p.source,
    title: p.title,
    url: p.url,
    postedAt: p.postedAt ?? null,
    firstSeenAt: p.firstSeenAt,
    commentCount: p.commentCount ?? null,
    views: p.views ?? null,
    likes: p.likes ?? null,
    category: p.category ?? null,
    status: p.status,
    alsoOn: alsoOnOf(p, groups),
    boards:
      p.status === 'adult'
        ? ['adult']
        : [...MIXED_BOARDS.filter((b) => member[b].has(p.id)), ...(bySource.get(p.source)?.has(p.id) ? [p.source] : [])],
    hot: hot.get(p.id) ?? 0,
    hotIn: p.status === 'adult' ? {} : Object.fromEntries(MIXED_BOARDS.filter((b) => hotIn[b].has(p.id)).map((b) => [b, hotIn[b].get(p.id)])),
    hasRead: hasRead(p),
  }));

  // 방문자에게 보일 출처: 로컬 /api/meta 의 sources 와 같은 기준 (수집 중이거나 공개 글이 남은 출처)
  const active = new Set((await activeSources()).map((s) => s.id));
  const sources = (await loadSources())
    .filter((s) => sourceShown(s.id, active, bySource.get(s.id)?.size ?? 0))
    .map((s) => ({
      id: s.id,
      name: s.name,
      short: s.short,
      color: s.color,
      homepage: s.homepage,
      active: active.has(s.id),
      imageHosts: Array.isArray(s.imageHosts) ? s.imageHosts : [],
      referer: s.referer || null,
    }));

  return { siteName: config.siteName, lastCrawlAt: store.getDb().lastCrawlAt || null, sources, posts };
}

// ---------- 미리보기 ----------

/** 원문을 못 읽어 잠시 쉬는 중인 글인지 (글이 바뀌면 처음부터 다시) */
function readResting(p, nowMs) {
  const f = readFails.get(p.id);
  if (!f) return false;
  if (f.hash !== readHash(p)) {
    readFails.delete(p.id);
    return false;
  }
  return f.n >= READ_FAIL_MAX || f.nextAt > nowMs;
}
function noteReadFail(p, hash, giveUp = false) {
  const n = giveUp ? READ_FAIL_MAX : (readFails.get(p.id)?.hash === hash ? readFails.get(p.id).n : 0) + 1;
  readFails.set(p.id, { n, hash, nextAt: Date.now() + readFailBackoffMs(n) });
}

/**
 * 미리보기를 만들 글, 올릴 순서대로: 썰·대화 → 웃긴 것만 → 전체 → 므흣 → 나머지(출처별 게시판에만 나오는 사본), 각 게시판 안에서는 최신순.
 * 수집을 끈 출처의 글은 자동으로 읽으러 가지 않는다 (화면은 원문 링크로 안내).
 */
function readQueue(all, activeIds, nowMs) {
  const out = [];
  const seen = new Set();
  const add = (list) => {
    for (const p of sortPosts(list, 'new')) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      if (activeIds.has(p.source) && !hasRead(p) && !readResting(p, nowMs)) out.push(p);
    }
  };
  add(boardPosts('story', {}, all));
  add(boardPosts('pick', {}, all));
  add(boardPosts('all', {}, all));
  const { pub, adult } = snapshotLists(all);
  add(adult);
  add(pub);
  return out;
}

/** 미리보기 문서 (규약 형태). 크기 상한을 넘으면 댓글을 줄이고, 그래도 넘으면 null. */
function readBody(data) {
  const body = {
    title: String(data.title ?? ''),
    html: String(data.html ?? ''),
    text: String(data.text ?? ''),
    mediaCount: Number(data.mediaCount) || 0,
    comments: Array.isArray(data.comments) ? data.comments : [],
    commentTotal: Number.isFinite(data.commentTotal) ? data.commentTotal : null,
    updatedAt: new Date().toISOString(),
  };
  let json = JSON.stringify(body);
  while (Buffer.byteLength(json) > READ_MAX_BYTES && body.comments.length) {
    body.comments = body.comments.slice(0, Math.floor(body.comments.length / 2));
    json = JSON.stringify(body);
  }
  return Buffer.byteLength(json) > READ_MAX_BYTES ? null : json;
}

function forgetPublished(keepIds) {
  let n = 0;
  for (const p of store.allPosts()) {
    if (p.published && !keepIds?.has(p.id)) {
      delete p.published;
      store.upsertPost(p);
      n++;
    }
  }
  return n;
}

// ---------- 한 번 올리기 ----------

async function runOnce(force) {
  const t0 = Date.now();
  st.lastRunAt = new Date().toISOString();

  // 1) Worker 확인. 저장소가 비어 있으면(새로 만들었거나 지워짐) 올린 기록을 지워 미리보기를 처음부터 다시 올린다.
  const remote = await call('GET', '/api/sync/status', undefined, STATUS_TIMEOUT_MS);
  if (typeof remote?.reads === 'number' && remote.reads === 0) {
    const n = forgetPublished(null);
    if (n) console.log(`[publish] 공개 사이트에 미리보기가 없어 처음부터 다시 올려요 (${n}개)`);
  }
  // 다른 곳에서 올렸거나 Worker 가 비었으면 바뀐 게 없어도 스냅샷을 다시 올린다
  if (!remote?.version || remote.version !== st.lastVersion) st.lastSnapshotSig = null;

  // 2) 미리보기: 출처 사이트 부담을 생각해 한 개씩 차례로, 한 번에 PUBLISH_READ_LIMIT 개까지
  const limit = config.publish.readLimit;
  const activeIds = new Set((await activeSources()).map((s) => s.id));
  const queue = limit > 0 ? readQueue(store.allPosts(), activeIds, Date.now()) : [];
  let attempted = 0;
  let uploaded = 0;
  let failed = 0;
  for (const q of queue) {
    if (attempted >= limit) break;
    const p = store.getPost(q.id); // 기다리는 동안 수집이 바꿨을 수 있어 매번 지금 상태로
    if (!p || hasRead(p) || !snapshotIds().has(p.id)) continue;
    const hash = readHash(p);
    attempted++;
    let data;
    try {
      data = await readPost(p);
    } catch (e) {
      noteReadFail(p, hash);
      failed++;
      if (failed <= 3) console.warn(`[publish] 미리보기 실패 ${p.id}: ${e.status ? `HTTP ${e.status}` : e.message}`);
      continue;
    }
    const fresh = store.getPost(p.id);
    if (!fresh) continue;
    if (data.statusChanged) {
      // 로컬 미리보기(/api/posts/:id/read)와 같게: 본문 검사로 상태가 바뀌면 쇼츠 점수도 지금 상태로
      rescorePost(fresh);
      store.upsertPost(fresh);
    }
    if (!snapshotIds().has(fresh.id)) continue; // 본문 검사로 걸러진 글은 올리지 않는다 (스냅샷에서도 빠진다)
    const body = readBody(data);
    if (!body) {
      noteReadFail(fresh, hash, true);
      failed++;
      continue;
    }
    try {
      await call('PUT', `/api/sync/read/${encodeURIComponent(fresh.id)}`, body, READ_TIMEOUT_MS);
    } catch (e) {
      // 이 문서만 받지 않는 경우(형식·크기 400/413 등)는 그 글만 그만두고 계속. 연결·인증·서버 오류는 이번 작업 전체를 실패로.
      if (!(e.status >= 400 && e.status < 500) || [401, 403, 408, 429].includes(e.status)) throw e;
      noteReadFail(fresh, hash, true);
      failed++;
      console.warn(`[publish] 미리보기를 공개 사이트가 받지 않았어요 ${fresh.id}: ${e.message}`);
      continue;
    }
    fresh.published = { readAt: new Date().toISOString(), hash };
    store.upsertPost(fresh);
    readFails.delete(fresh.id);
    uploaded++;
  }

  // 3) 스냅샷 — 미리보기 뒤에 계산
  const snap = await buildSnapshot();
  // 인기순 점수(hot·hotIn)는 시간 감쇠 때문에 매번 조금씩 다르지만 순서는 그대로라 지문에서 뺀다
  const sig = createHash('sha1')
    .update(JSON.stringify([snap.siteName, snap.lastCrawlAt, snap.sources, snap.posts.map(({ hot, hotIn, ...x }) => x)]))
    .digest('hex');
  let sent = false;
  let pruned = 0;
  if (force || sig !== st.lastSnapshotSig) {
    let version = new Date().toISOString();
    if (version <= st.lastVersion) version = new Date(Date.parse(st.lastVersion) + 1).toISOString();
    const res = await call('PUT', '/api/sync/snapshot', JSON.stringify({ version, ...snap }), SNAPSHOT_TIMEOUT_MS);
    st.lastVersion = version;
    st.lastSnapshotSig = sig;
    sent = true;
    pruned = Number(res?.pruned) || 0;
    if (Number(res?.skipped) > 0) console.warn(`[publish] 공개 사이트가 글 ${res.skipped}개를 형식이 달라 건너뛰었어요`);
    // 스냅샷에 없는 글의 미리보기는 Worker 가 지운다 → 올린 기록도 지워, 다시 보이게 되면 새로 올린다
    forgetPublished(new Set(snap.posts.map((p) => p.id)));
  }

  st.lastOkAt = new Date().toISOString();
  st.lastError = null;
  const { pending } = await countReads();
  console.log(
    `[publish] ${sent ? `글 ${snap.posts.length}개 올림` : '바뀐 글 없음'} · 미리보기 +${uploaded}${failed ? ` (못 읽음 ${failed})` : ''}, 남은 ${pending}개 (${((Date.now() - t0) / 1000).toFixed(1)}초)`,
  );
  return { ok: true, sent, posts: snap.posts.length, reads: uploaded, readFailed: failed, pruned };
}

function start(force) {
  clearTimeout(st.debounceTimer);
  st.debounceTimer = null;
  clearTimeout(st.retryTimer);
  st.retryTimer = null;
  const job = runOnce(force).catch((e) => {
    st.lastError = e?.message || String(e);
    console.warn(`[publish] 실패: ${st.lastError} — 다음 수집 때나 ${RETRY_MS / 60e3}분 뒤에 다시 올려요`);
    st.retryTimer = setTimeout(() => publishNow(), RETRY_MS);
    st.retryTimer.unref?.();
    return { ok: false, error: st.lastError };
  });
  st.running = job.finally(() => {
    st.running = null;
    if (st.queued) {
      const q = st.queued;
      st.queued = null;
      start(q.force).then(q.resolve);
    } else emitDone();
  });
  publishEvents.emit('state', { running: true, lastOkAt: st.lastOkAt, lastError: st.lastError });
  return st.running;
}

/**
 * 지금 올리기. 이미 도는 중이면 끝난 뒤 한 번 더 돈다 (그 사이 요청은 하나로 합친다). 실패해도 reject 하지 않는다.
 * @param {{force?: boolean}} [opts] force: 바뀐 게 없어도 스냅샷을 올린다
 * @returns {Promise<{ok: boolean, error?: string, skipped?: string}>}
 */
export function publishNow({ force = false } = {}) {
  if (!config.publish.enabled) return Promise.resolve({ ok: false, skipped: 'disabled' });
  if (st.running) {
    if (st.queued) st.queued.force ||= force;
    else {
      let resolve;
      const promise = new Promise((r) => (resolve = r));
      st.queued = { force, promise, resolve };
    }
    return st.queued.promise;
  }
  return start(force);
}

/** 관리자 변경 뒤: 이미 예약돼 있으면 그대로 두어, 첫 변경 뒤 delayMs 안에 한 번 올린다 */
export function schedulePublish(delayMs = config.publish.debounceMs) {
  if (!config.publish.enabled || st.debounceTimer) return;
  st.debounceTimer = setTimeout(() => {
    st.debounceTimer = null;
    publishNow();
  }, delayMs);
  st.debounceTimer.unref?.();
}

/** 올린 미리보기 수와, 앞으로 올릴 미리보기 수 (수집을 끈 출처의 글·계속 못 읽어 그만둔 글은 빼고) */
async function countReads() {
  const activeIds = new Set((await activeSources()).map((s) => s.id));
  let done = 0;
  let pending = 0;
  const { pub, adult } = snapshotLists(store.allPosts());
  for (const p of [...pub, ...adult]) {
    if (hasRead(p)) done++;
    else if (activeIds.has(p.source) && !gaveUp(p)) pending++;
  }
  return { done, pending };
}
function gaveUp(p) {
  const f = readFails.get(p.id);
  return !!f && f.n >= READ_FAIL_MAX && f.hash === readHash(p);
}

/** 관리자 화면용 상태 (/api/meta 의 publish) */
export async function publishStatus() {
  const c = config.publish;
  return {
    enabled: c.enabled,
    url: c.url || null,
    lastOkAt: st.lastOkAt,
    lastError: c.enabled ? st.lastError : c.error,
    running: !!st.running,
    reads: c.enabled ? await countReads() : { done: 0, pending: 0 },
  };
}

let started = false;
/** 서버 시작 시 한 번: 켜져 있으면 지금 한 번 올리고, 그 뒤로는 수집이 끝날 때마다 */
export function startPublisher() {
  if (started) return;
  started = true;
  const c = config.publish;
  if (!c.enabled) {
    if (c.error) console.warn(`[publish] 공개 사이트 업로드 꺼짐: ${c.error}`);
    return;
  }
  console.log(`[publish] 공개 사이트 업로드 켜짐 → ${c.url} (미리보기 한 번에 ${c.readLimit}개)`);
  events.on('crawl', () => publishNow());
  publishNow();
}
