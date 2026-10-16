// 글 저장소. 글 수천 개 규모라 메모리에 올려두고, 바뀐 것을 저장소 백엔드에 쓴다.
// - 로컬(Node): data/posts.json 한 파일 (src/platform/node.js). 바뀌면 잠시 뒤 원자적으로(임시 파일 → rename) 통째로 저장.
// - 클라우드: Durable Object SQLite (worker/storage.js). 글 하나가 행 하나라 바뀐 글만 쓰고, 요청·알람이 끝날 때 flush() 한다.
// 백엔드 모양: { load(): db|null, save(db, changes), autosave?: boolean }
//   changes = { all: boolean, meta: boolean, posts: string[](바뀐 글 id), deleted: string[](지운 글 id) }
import * as platform from '#platform';
import { config } from './config.js';

/**
 * @typedef {{
 *   id: string, source: string, postId: string, title: string, url: string,
 *   author?: string|null, postedAt?: string|null, firstSeenAt: string, updatedAt: string,
 *   commentCount?: number|null, views?: number|null, likes?: number|null,
 *   category?: string|null, nsfwHint?: boolean, thumbnail?: string|null,
 *   auto: {status: 'ok'|'adult'|'blocked', reasons: string[]},  // 키워드 판정
 *   ai?: {verdict: string, shortsScore: number, reason: string, model: string, at: string}|null, // Claude 판정
 *   aiPending?: boolean,
 *   manual?: 'ok'|'adult'|'blocked'|null,  // 관리자 수동 지정 (최우선)
 *   status: 'ok'|'adult'|'blocked',         // 최종 상태
 *   shortsScore: number,
 *   dupOf?: string|null, titleKey?: string,
 *   shorts?: {stage: 'candidate'|'script'|'done', note: string, updatedAt: string}|null,
 *   bodyChecked?: boolean,                  // 본문 검사를 했는지 (false 면 다음 미리보기 때 다시 검사)
 *   aiTries?: number, aiNextAt?: string|null, aiGaveUp?: boolean, // Claude 판정 실패 재시도 횟수·다음 시도 시각·포기
 * }} Post
 */

/**
 * settings: 관리자 화면에서 바꾸는 실행 설정 (live = 실시간 자동 수집 ON/OFF, intervalMin = 수집 간격)
 * @type {{posts: Record<string, Post>, sources: Record<string, any>, lastCrawlAt: string|null, settings: {live?: boolean, intervalMin?: number}}}
 */
let db = emptyDb();
let saveTimer = null;
/** 저장소 백엔드 (없으면 메모리에만) */
let backend = platform.storeBackend();
const dirty = { all: false, meta: false, posts: new Set(), deleted: new Set() };

function emptyDb() {
  return { posts: {}, sources: {}, lastCrawlAt: null, settings: {} };
}
function normalize(j) {
  if (!j || typeof j !== 'object') return emptyDb();
  return {
    posts: j.posts && typeof j.posts === 'object' ? j.posts : {},
    sources: j.sources && typeof j.sources === 'object' ? j.sources : {},
    lastCrawlAt: j.lastCrawlAt || null,
    settings: j.settings && typeof j.settings === 'object' ? j.settings : {},
  };
}
function clearDirty() {
  dirty.all = false;
  dirty.meta = false;
  dirty.posts.clear();
  dirty.deleted.clear();
}
const isDirty = () => dirty.all || dirty.meta || dirty.posts.size > 0 || dirty.deleted.size > 0;

/** 저장소 백엔드를 바꾼다 (클라우드: SiteDO). 메모리의 글은 그대로 두니, 이어서 load() 를 부른다. */
export function setBackend(b) {
  clearTimeout(saveTimer);
  saveTimer = null;
  backend = b || null;
  clearDirty();
}

export function load() {
  clearTimeout(saveTimer);
  saveTimer = null;
  db = normalize(backend?.load());
  clearDirty();
  return db;
}

/** 지금 바로 저장 */
export function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (backend) {
    backend.save(db, { all: dirty.all, meta: dirty.meta, posts: [...dirty.posts], deleted: [...dirty.deleted] });
  }
  clearDirty();
}

/** 밀린 변경이 있을 때만 저장 (클라우드: 요청·알람이 끝날 때마다) */
export function flush() {
  if (isDirty()) saveNow();
}

/** 잠시 뒤 저장. 백엔드가 스스로 미루지 않으면(autosave:false) 표시만 해 두고 flush() 를 기다린다. */
export function scheduleSave(ms = 1500) {
  if (saveTimer || !backend || backend.autosave === false) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      saveNow();
    } catch (e) {
      console.error(`[store] 저장 실패: ${e.message}`);
    }
  }, ms);
}

export const getDb = () => db;
export const getPost = (id) => (Object.hasOwn(db.posts, id) ? db.posts[id] : null);
export const allPosts = () => Object.values(db.posts);

export function upsertPost(p) {
  db.posts[p.id] = p;
  dirty.posts.add(p.id);
  dirty.deleted.delete(p.id);
  scheduleSave();
  return p;
}

export function deletePost(id) {
  delete db.posts[id];
  dirty.posts.delete(id);
  dirty.deleted.add(id);
  scheduleSave();
}

export function setSourceState(id, state) {
  db.sources[id] = { ...(db.sources[id] || {}), ...state };
  dirty.meta = true;
  scheduleSave();
}

export const getSettings = () => db.settings;

export function updateSettings(patch) {
  db.settings = { ...db.settings, ...patch };
  dirty.meta = true;
  saveNow();
  return db.settings;
}

export function setLastCrawl(at) {
  db.lastCrawlAt = at;
  dirty.meta = true;
  scheduleSave();
}

/** 상태를 통째로 바꾸고 바로 저장한다 (클라우드로 옮기기: /api/admin/import) */
export function replaceAll(next) {
  db = normalize(next);
  dirty.all = true;
  saveNow();
  return db;
}

/** 최종 상태 계산: 관리자 지정 > (Claude 판정 ∨ 키워드 판정 중 더 엄격한 쪽) */
export function resolveStatus(p) {
  if (p.manual) return p.manual;
  const rank = { ok: 0, adult: 1, blocked: 2 };
  let s = p.auto?.status || 'ok';
  const v = p.ai?.verdict;
  if (v) {
    const aiStatus = v === 'adult' ? 'adult' : v === 'ok' ? 'ok' : 'blocked';
    if (rank[aiStatus] > rank[s]) s = aiStatus;
  }
  return s;
}

// ---------- 공개 여부 (목록 API·/api/meta 게시판 수·수집 요약이 모두 같은 기준을 쓰도록 여기 한 곳에 둔다) ----------

/** Claude 검수 대기 중이라 아직 숨기는 글인지. Claude 가 꺼져 있으면 남은 aiPending 표시는 무시한다. */
export function isPending(p) {
  return !!(
    config.ai.enabled &&
    p.aiPending &&
    !p.manual &&
    Date.now() - new Date(p.firstSeenAt).getTime() < config.ai.pendingMaxMin * 60e3
  );
}

/** 글 자체가 공개 상태인지 (중복 묶음은 따지지 않음) */
export const isPublic = (p) => p.status === 'ok' && !isPending(p);

/** 중복 묶음 키: 대표 글이면 자기 id, 사본이면 대표 글 id */
export const groupKey = (p) => p.dupOf || p.id;

/** 묶음 키 → 그 묶음의 글들 (대표 글 + 사본) */
export function groupIndex(posts = allPosts()) {
  const m = new Map();
  for (const p of posts) {
    const k = groupKey(p);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(p);
  }
  return m;
}

// 묶음 안에서 대신 보일 순서: 대표 글 → 먼저 본 글 → id
const repRank = (a, b) =>
  (a.dupOf ? 1 : 0) - (b.dupOf ? 1 : 0) || String(a.firstSeenAt).localeCompare(String(b.firstSeenAt)) || a.id.localeCompare(b.id);

/**
 * 합쳐 보여주는 게시판(전체·픽·므흣)용: 이미 보이는 조건으로 거른 글들 중 묶음마다 하나만 남긴다.
 * 대표 글이 보이면 대표 글이, 대표 글이 안 보이면(차단·대기·므흣 등) 보이는 사본 중 먼저 본 것이 대신 보인다.
 * @param {Post[]} visible
 */
export function onePerGroup(visible) {
  const best = new Map();
  for (const p of visible) {
    const k = groupKey(p);
    const cur = best.get(k);
    if (!cur || repRank(p, cur) < 0) best.set(k, p);
  }
  const keep = new Set(best.values());
  return visible.filter((p) => keep.has(p));
}

// ---------- 종료 시 저장 (로컬: 'exit'·Ctrl+C·SIGTERM. 클라우드에는 없음) ----------
platform.onExit(() => {
  if (saveTimer) saveNow();
});

/** 예전 이름 (scripts 호환). 신호 처리기는 모듈을 불러올 때 이미 걸린다. */
export function saveOnSignals() {}
