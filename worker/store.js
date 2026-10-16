// D1 저장소: 공개 글 스냅샷 한 벌과 글별 미리보기 문서.
//
// snapshot 테이블 (규약의 스키마 그대로):
//   k = 'main'      → 스냅샷 머리: { version, siteName, lastCrawlAt, sources, counts, total, chunks }  (작다)
//   k = 'posts/<n>' → 글 묶음: [[item, boards, hot, hasRead, ts, hotIn?], ...]  (JSON 배열, 같은 version. hotIn 은 게시판별 인기순 점수, 있을 때만)
// D1 은 한 행이 2MB 를 넘을 수 없어 글 목록을 몇 행으로 나눠 둔다. 모든 행은 한 batch(트랜잭션)로 바뀐다.
// 방문자 요청은 'main' 의 version 만 확인하고, 바뀌었을 때만 다시 읽어 isolate 메모리에 둔다.

import { HttpError } from './http.js';

export const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS snapshot (k TEXT PRIMARY KEY, version TEXT NOT NULL, json TEXT NOT NULL, updated_at TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS reads (id TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at TEXT NOT NULL)',
];

const CHUNK_PREFIX = 'posts/';
/** 글 묶음 한 행의 최대 글자 수. UTF-16 한 글자는 UTF-8 로 3바이트 이하라 1.8MB 를 넘지 않는다 (D1 한 행 2MB). */
export const CHUNK_CHARS = 600_000;
/** 화면이 쓰지 않는 게시판 이름 — 공개 글의 boards 에 있어도 버린다 */
const RESERVED_BOARDS = new Set(['adult', 'filtered', 'shorts']);

/** 스키마 만들기: isolate(작업자 인스턴스)마다 한 번 */
export function ensureSchema(state, db) {
  if (!state.schema) {
    state.schema = db.batch(SCHEMA.map((sql) => db.prepare(sql))).catch((e) => {
      state.schema = null; // 실패하면 다음 요청에서 다시
      throw e;
    });
  }
  return state.schema;
}

// ---------- 업로드 정규화 ----------

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : null);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
// new URL() 보다 훨씬 싸다 (글이 수천 개). javascript: 같은 주소만 막으면 된다.
const httpUrl = (v) => (typeof v === 'string' && v.length <= 2048 && /^https?:\/\/[^\s]+$/i.test(v) ? v : null);
const HOST_RE = /^[a-z0-9.-]{1,253}$/;

function normalizeSource(s) {
  if (!s || typeof s !== 'object') return null;
  const id = str(s.id, 64);
  if (!id) return null;
  const name = str(s.name, 100) || id;
  return {
    id,
    name,
    short: str(s.short, 40) || name,
    color: str(s.color, 40),
    homepage: httpUrl(s.homepage),
    active: s.active !== false,
    imageHosts: (Array.isArray(s.imageHosts) ? s.imageHosts : [])
      .map((h) => (typeof h === 'string' ? h.trim().toLowerCase().replace(/^\./, '') : ''))
      .filter((h) => HOST_RE.test(h))
      .slice(0, 50),
    referer: httpUrl(s.referer),
  };
}

function normalizeAlsoOn(list) {
  const out = [];
  if (!Array.isArray(list)) return out;
  for (const a of list) {
    const source = a && typeof a === 'object' ? str(a.source, 64) : null;
    const url = source ? httpUrl(a.url) : null;
    if (url) out.push({ source, url });
    if (out.length >= 20) break;
  }
  return out;
}

/**
 * 스냅샷의 글 하나 → 저장 형식 [item, boards, hot, hasRead, ts, hotIn?]. 쓸 수 없으면 null.
 * item 은 방문자에게 그대로 나가는 모양이다: 규약에 적힌 필드만 남긴다(boards·hot·hotIn·hasRead 와 그 밖의 필드는 버림).
 */
export function normalizePost(p) {
  if (!p || typeof p !== 'object') return null;
  const id = str(p.id, 300);
  const source = str(p.source, 64);
  const url = httpUrl(p.url);
  const status = p.status === 'ok' || p.status === 'adult' ? p.status : null;
  if (!id || !source || typeof p.title !== 'string' || !url || !status) return null;
  const item = {
    id,
    source,
    title: p.title.slice(0, 500),
    url,
    postedAt: str(p.postedAt, 40),
    firstSeenAt: str(p.firstSeenAt, 40),
    commentCount: num(p.commentCount),
    views: num(p.views),
    likes: num(p.likes),
    category: str(p.category, 100),
    status,
    alsoOn: normalizeAlsoOn(p.alsoOn),
  };
  let boards;
  if (status === 'adult') {
    boards = ['adult']; // 므흣 글은 잠금 게시판에만 (올린 쪽 실수로 공개 게시판에 섞이지 않게)
  } else {
    boards = [];
    for (const b of Array.isArray(p.boards) ? p.boards : []) {
      if (typeof b === 'string' && b && b.length <= 64 && !RESERVED_BOARDS.has(b) && !boards.includes(b)) boards.push(b);
      if (boards.length >= 32) break;
    }
  }
  const ts = Date.parse(item.postedAt || item.firstSeenAt || '') || 0;
  const rec = [item, boards, num(p.hot) ?? 0, p.hasRead === true, ts];
  // 게시판별 인기순 점수 (전체·픽·썰처럼 여러 출처가 섞이는 게시판). 이 글이 나오는 게시판 것만 남긴다.
  if (p.hotIn && typeof p.hotIn === 'object' && !Array.isArray(p.hotIn)) {
    let hotIn = null;
    for (const b of boards) {
      const v = Object.hasOwn(p.hotIn, b) ? num(p.hotIn[b]) : null;
      if (v !== null) (hotIn ??= {})[b] = v;
    }
    if (hotIn) rec.push(hotIn);
  }
  return rec;
}

/**
 * PUT /api/sync/snapshot 본문 → 저장할 것들. 틀 자체가 틀리면 400, 글 하나가 틀리면 그 글만 건너뛴다(skipped).
 * @returns {{head: object, chunks: string[], ids: string[], skipped: number}}
 */
export function prepareSnapshot(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, '스냅샷 형식이 달라요');
  const version = str(body.version, 100);
  if (!version || !Array.isArray(body.posts) || !Array.isArray(body.sources)) throw new HttpError(400, '스냅샷 형식이 달라요 (version·sources·posts)');

  const sources = [];
  const seenSrc = new Set();
  for (const s of body.sources) {
    const n = normalizeSource(s);
    if (n && !seenSrc.has(n.id)) {
      seenSrc.add(n.id);
      sources.push(n);
    }
  }

  const records = [];
  const seen = new Set();
  let skipped = 0;
  for (const p of body.posts) {
    const r = normalizePost(p);
    if (!r || seen.has(r[0].id)) {
      skipped++;
      continue;
    }
    seen.add(r[0].id);
    records.push(r);
  }
  // 최신순으로 미리 정렬해 두면 방문자 쪽 게시판 목록이 정렬 없이 최신순이 된다 (같은 시각은 올린 순서 유지)
  records.sort((a, b) => b[4] - a[4]);

  const counts = {};
  for (const r of records) for (const b of r[1]) counts[b] = (Object.hasOwn(counts, b) ? counts[b] : 0) + 1;

  const chunks = [];
  let cur = [];
  let len = 2;
  for (const r of records) {
    const s = JSON.stringify(r);
    if (cur.length && len + s.length + 1 > CHUNK_CHARS) {
      chunks.push(`[${cur.join(',')}]`);
      cur = [];
      len = 2;
    }
    cur.push(s);
    len += s.length + 1;
  }
  if (cur.length) chunks.push(`[${cur.join(',')}]`);

  const head = {
    version,
    siteName: str(body.siteName, 100) || '심심풀이',
    lastCrawlAt: str(body.lastCrawlAt, 40),
    sources,
    counts,
    total: records.length,
    chunks: chunks.length,
  };
  return { head, chunks, ids: records.map((r) => r[0].id), skipped };
}

/**
 * 스냅샷 저장. 같은 버전이 이미 있으면 아무것도 하지 않는다. 스냅샷에 없는 글의 미리보기 문서는 지운다.
 * @returns {Promise<{ok: true, posts: number, pruned: number, skipped: number, unchanged?: true}>}
 */
export async function saveSnapshot(db, body, now) {
  const { head, chunks, ids, skipped } = prepareSnapshot(body);
  const prev = await db.prepare("SELECT version FROM snapshot WHERE k = 'main'").first();
  if (prev?.version === head.version) return { ok: true, posts: head.total, pruned: 0, skipped, unchanged: true };

  const at = new Date(now).toISOString();
  const stmts = [db.prepare("DELETE FROM snapshot WHERE k <> 'main'")];
  chunks.forEach((c, i) => stmts.push(db.prepare('INSERT INTO snapshot (k, version, json, updated_at) VALUES (?, ?, ?, ?)').bind(`${CHUNK_PREFIX}${i}`, head.version, c, at)));
  stmts.push(
    db
      .prepare("INSERT INTO snapshot (k, version, json, updated_at) VALUES ('main', ?, ?, ?) ON CONFLICT(k) DO UPDATE SET version = excluded.version, json = excluded.json, updated_at = excluded.updated_at")
      .bind(head.version, JSON.stringify(head), at),
  );
  const idsJson = JSON.stringify(ids);
  // id 목록 하나가 D1 한 값 상한(2MB)에 가까우면 이번엔 정리를 건너뛴다 (다음 스냅샷 때 다시)
  const prune = idsJson.length <= 600_000;
  if (prune) stmts.push(db.prepare('DELETE FROM reads WHERE id NOT IN (SELECT value FROM json_each(?))').bind(idsJson));
  const results = await db.batch(stmts);
  return { ok: true, posts: head.total, pruned: prune ? Number(results.at(-1)?.meta?.changes ?? 0) : 0, skipped };
}

/** 미리보기 문서 한 개 저장 (규약의 필드만 남겨서). 저장한 JSON 은 항상 비어 있지 않은 객체다. */
export async function saveRead(db, id, body, now) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.html !== 'string') throw new HttpError(400, '미리보기 형식이 달라요');
  const doc = {
    title: typeof body.title === 'string' ? body.title.slice(0, 500) : '',
    html: body.html,
    text: typeof body.text === 'string' ? body.text : '',
    mediaCount: num(body.mediaCount) ?? 0,
    comments: Array.isArray(body.comments) ? body.comments.slice(0, 300) : [],
    commentTotal: num(body.commentTotal),
  };
  const at = str(body.updatedAt, 40) || new Date(now).toISOString();
  await db
    .prepare('INSERT INTO reads (id, json, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at')
    .bind(id, JSON.stringify(doc), at)
    .run();
}

/** GET /api/sync/status */
export async function syncStatus(db) {
  const [main, reads] = await db.batch([
    db.prepare("SELECT version, json, updated_at FROM snapshot WHERE k = 'main'"),
    db.prepare('SELECT COUNT(*) AS n FROM reads'),
  ]);
  const row = main.results?.[0];
  let posts = 0;
  if (row) {
    try {
      posts = Number(JSON.parse(row.json).total) || 0;
    } catch {}
  }
  return { version: row?.version ?? null, posts, reads: Number(reads.results?.[0]?.n ?? 0), updatedAt: row?.updated_at ?? null };
}

// ---------- 방문자 쪽: 버전 확인 + isolate 캐시 ----------

/** 다른 업로드가 끼어들어 글 묶음이 머리와 버전이 맞지 않을 때 */
export class StaleSnapshot extends Error {}

/**
 * 스냅샷 머리. 요청마다 version 만 확인하고(바뀌었을 때만 json 이 같이 온다) 메모리 것을 쓴다.
 * @returns {Promise<object|null>} 아직 업로드가 없으면 null
 */
export async function currentHead(state, db) {
  const known = state.head?.version ?? '';
  const row = await db
    .prepare("SELECT version, CASE WHEN version = ? THEN NULL ELSE json END AS json FROM snapshot WHERE k = 'main'")
    .bind(known)
    .first();
  if (!row) {
    state.head = null;
    return null;
  }
  if (row.json != null) {
    const head = JSON.parse(row.json);
    head.sourceMap = new Map((head.sources || []).map((s) => [s.id, s]));
    state.head = head;
  }
  return state.head;
}

/**
 * 글 목록 (머리와 같은 버전). 버전이 바뀌었을 때만 D1 에서 다시 읽고 게시판별 목록을 만든다.
 * 같은 isolate 의 동시 요청은 한 번만 읽는다.
 */
export async function currentPosts(state, db, head) {
  if (state.posts?.version === head.version) return state.posts;
  if (state.loading?.version === head.version) return state.loading.promise;
  const promise = loadPosts(db, head);
  state.loading = { version: head.version, promise };
  try {
    const posts = await promise;
    if (state.head?.version === head.version) state.posts = posts;
    return posts;
  } finally {
    if (state.loading?.promise === promise) state.loading = null;
  }
}

async function loadPosts(db, head) {
  const { results } = await db.prepare("SELECT k, json FROM snapshot WHERE version = ? AND k <> 'main'").bind(head.version).all();
  if (results.length !== head.chunks) throw new StaleSnapshot('snapshot changed');
  const idx = (k) => Number(String(k).slice(CHUNK_PREFIX.length));
  results.sort((a, b) => idx(a.k) - idx(b.k));
  const byId = new Map();
  /** @type {Map<string, {new: object[], hot: object[]|null}>} 게시판 → 최신순 목록 (인기순은 처음 쓸 때 만든다) */
  const boards = new Map();
  for (const row of results) {
    for (const [item, bs, hot, hasRead, ts, hotIn] of JSON.parse(row.json)) {
      const e = { item, hot, hotIn: hotIn || null, hasRead, ts, lower: null };
      byId.set(item.id, e);
      for (const b of bs) {
        let l = boards.get(b);
        if (!l) boards.set(b, (l = { new: [], hot: null }));
        l.new.push(e);
      }
    }
  }
  return { version: head.version, byId, boards };
}

/**
 * 게시판 목록 (정렬된 것, 캐시). 없는 게시판은 빈 목록.
 * 인기순은 그 게시판의 점수(hotIn[게시판], 없으면 hot)가 큰 순, 같으면 최신순 — 로컬 sortPosts('hot') 과 같은 순서.
 */
export function boardList(posts, board, sort) {
  const l = posts?.boards.get(board);
  if (!l) return [];
  if (sort !== 'hot') return l.new;
  if (!l.hot) {
    const score = (e) => (e.hotIn && Object.hasOwn(e.hotIn, board) ? e.hotIn[board] : e.hot);
    l.hot = l.new
      .map((e) => [score(e), e])
      .sort((a, b) => b[0] - a[0] || b[1].ts - a[1].ts)
      .map((x) => x[1]);
  }
  return l.hot;
}

/** 미리보기 문서 JSON (저장된 문자열 그대로) */
export async function readDoc(db, id) {
  const row = await db.prepare('SELECT json FROM reads WHERE id = ?').bind(id).first();
  const s = row?.json;
  return typeof s === 'string' && s.length > 2 && s[0] === '{' ? s : null;
}
