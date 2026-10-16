// JSON 파일 저장소. 글 수천 개 규모라 메모리에 올려두고, 바뀌면 잠시 뒤 원자적으로(임시 파일 → rename) 저장한다.
import { existsSync, readFileSync, renameSync, writeFileSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR, config } from './config.js';

const FILE = path.join(DATA_DIR, 'posts.json');

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
let db = { posts: {}, sources: {}, lastCrawlAt: null, settings: {} };
let saveTimer = null;

export function load() {
  if (existsSync(FILE)) {
    try {
      const j = JSON.parse(readFileSync(FILE, 'utf8'));
      db = { posts: j.posts || {}, sources: j.sources || {}, lastCrawlAt: j.lastCrawlAt || null, settings: j.settings || {} };
    } catch (e) {
      // 깨진 파일은 보존하고 새로 시작
      const bad = `${FILE}.broken-${Date.now()}`;
      try {
        copyFileSync(FILE, bad);
      } catch {}
      console.error(`[store] posts.json 읽기 실패 (${e.message}) → ${bad} 로 보관하고 새로 시작`);
    }
  }
  return db;
}

export function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  const tmp = `${FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(db));
  renameSync(tmp, FILE);
}

export function scheduleSave(ms = 1500) {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    try {
      saveNow();
    } catch (e) {
      console.error(`[store] 저장 실패: ${e.message}`);
    }
  }, ms);
}

export const getDb = () => db;
export const getPost = (id) => db.posts[id] || null;
export const allPosts = () => Object.values(db.posts);

export function upsertPost(p) {
  db.posts[p.id] = p;
  scheduleSave();
  return p;
}

export function deletePost(id) {
  delete db.posts[id];
  scheduleSave();
}

export function setSourceState(id, state) {
  db.sources[id] = { ...(db.sources[id] || {}), ...state };
  scheduleSave();
}

export const getSettings = () => db.settings;

export function updateSettings(patch) {
  db.settings = { ...db.settings, ...patch };
  saveNow();
  return db.settings;
}

export function setLastCrawl(at) {
  db.lastCrawlAt = at;
  scheduleSave();
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

// ---------- 종료 시 저장 ----------
process.on('exit', () => {
  if (saveTimer) {
    try {
      saveNow();
    } catch (e) {
      console.error(`[store] 종료 저장 실패: ${e.message}`);
    }
  }
});

// 'exit' 이벤트는 처리기 없는 SIGINT(Ctrl+C)/SIGTERM 종료 때는 발생하지 않으므로, 신호를 받으면 밀린 변경을 저장하고 끝낸다.
// (Windows 의 작업 관리자·TerminateProcess 같은 강제 종료는 어떤 처리기도 실행되지 않는다)
let signalsInstalled = false;
export function saveOnSignals() {
  if (signalsInstalled) return;
  signalsInstalled = true;
  let shuttingDown = false;
  const onSignal = (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      if (saveTimer) saveNow();
    } catch (e) {
      console.error(`[store] 종료 저장 실패 (${sig}): ${e.message}`);
    }
    process.exit(0);
  };
  // SIGINT = Ctrl+C, SIGTERM = kill·서비스 관리자, SIGBREAK = Windows Ctrl+Break, SIGHUP = Windows 콘솔 창 닫기
  // (다른 OS 의 SIGHUP 은 nohup 실행을 깨지 않도록 건드리지 않는다)
  const sigs = ['SIGINT', 'SIGTERM', ...(process.platform === 'win32' ? ['SIGBREAK', 'SIGHUP'] : [])];
  for (const sig of sigs) {
    try {
      process.on(sig, () => onSignal(sig));
    } catch {}
  }
}
saveOnSignals();
