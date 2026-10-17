// 게시판 소속·정렬: 로컬 서버(server.js)의 목록 API 와 공개 사이트로 올리는 스냅샷(publish.js)이 같은 기준을 쓰도록 여기 한 곳에 둔다.
import * as store from './store.js';
import { isPending, isPublic, groupKey, onePerGroup } from './store.js';
import { vibeGuess } from './filter.js';
import { ruleCaps } from './model/score.js';
import { CRITERIA_VERSION } from './criteria.js';

/**
 * 핸드드립(story)·푸어오버(pick) 게시판에 남겨 두는 글 수: 기간 제한 없이, 조건에 맞는 글 중 가장 최근에 들어온 N개.
 * 이 안에 든 글은 보관 기간(RETENTION_DAYS)이 지나도 지우지 않는다 (crawler.js prune).
 */
export const BOARD_KEEP = Math.max(10, Number(process.env.BOARD_KEEP) || 100);

/** 푸어오버(pick): 공개 글 중 "그냥 웃긴" 글. Claude 판정이 있으면 그걸, 없으면 섞은 점수를 본다. */
export const PICK_MIN = 65;
/**
 * Claude 판정이 없는 글의 대체 기준: 섞은 쇼츠 점수(filter.js shortsScore = 키워드 + 학습 점수, 수집 때마다 p.shortsScore 로 다시 매긴다).
 * 겹 밖 검증 (키워드 판정 ok 인 사이트 글 557개, Claude 기준 양성 79): 섞은 점수 ≥ 60 은 정밀도 0.48·재현율 0.37 (60개),
 * 예전 키워드 점수 ≥ 60 은 0.43·0.16 (30개) — 비슷한 정밀도로 두 배 넘게 찾고, 금지 소재 상한에 걸린 글 50개는 하나도 넘지 않는다 (예전 3개).
 */
export const PICK_FALLBACK_MIN = PICK_MIN - 5;
export function pickWorthy(p) {
  if (p.manual === 'ok' && p.shorts) return true;
  // 지금 기준(STYLE.md §7) 판정은 그대로 믿고, 옛 기준 판정(기준 표시 없음)은 금지 소재 상한도 함께 본다
  // (옛 기준이 통과시킨 친자·축의금·남녀 일반화 같은 §6.5 금지 소재가 남지 않게 — 다시 보기는 상한 걸린 글을 다시 판정하지 않는다)
  if (p.ai) return p.ai.verdict === 'ok' && p.ai.shortsScore >= PICK_MIN && (p.ai.criteria === CRITERIA_VERSION || ruleCaps(p).funny >= PICK_FALLBACK_MIN);
  // 저장된 점수가 예전 키워드 점수(모델을 섞기 전)로 남아 있어도 금지 소재는 들이지 않게 상한을 한 번 더 본다
  return (p.shortsScore ?? 0) >= PICK_FALLBACK_MIN && ruleCaps(p).funny >= PICK_FALLBACK_MIN;
}

/** 글의 "핸드드립" 분위기 점수: 관리자 지정 > Claude 판정(ai.vibe) > 제목 어림값 */
export function vibeOf(p) {
  if (p.manualVibe === true) return 100;
  if (p.manualVibe === false) return 0;
  return typeof p.ai?.vibe === 'number' ? p.ai.vibe : vibeGuess(p);
}
/** 핸드드립(story): 읽어주며 반응하기 좋은 웃긴 글 */
export const STORY_VIBE_MIN = 70;
const STORY_FUNNY_MIN = 55;
export function storyWorthy(p) {
  if (p.manualVibe === true) return true;
  if (p.manualVibe === false) return false;
  // 운영자 요청: 핸드드립은 Claude 판정(웃김 + 분위기 점수)이 끝난 글만. 키워드 어림값만 있는 글은 넣지 않는다.
  return !!p.ai && p.ai.verdict === 'ok' && typeof p.ai.vibe === 'number' && p.ai.shortsScore >= STORY_FUNNY_MIN && p.ai.vibe >= STORY_VIBE_MIN;
}

/**
 * 게시판의 글 목록 (검색·정렬 전). /api/posts 의 total, /api/meta 의 boardCounts·sources[].count,
 * 공개 사이트 스냅샷의 boards 가 모두 이 함수로 센다.
 * - 전체·픽·므흣: 중복 묶음마다 하나만. 대표 글이 보이면 대표 글이, 대표 글이 안 보이면(차단·대기·므흣) 보이는 사본이 대신 나온다.
 * - 출처별: 그 출처의 공개 글 전부 (각 글의 상태로만 판단)
 * @returns {import('./store.js').Post[]|null} 볼 권한이 없으면 null
 */
export function boardPosts(board, { admin = false, adult = false, stage = '' } = {}, all = store.allPosts()) {
  switch (board) {
    case 'all':
      return onePerGroup(all.filter(isPublic));
    case 'pick':
      return newestKept(onePerGroup(all.filter(isPublic)).filter(pickWorthy));
    case 'story':
      return newestKept(onePerGroup(all.filter(isPublic)).filter(storyWorthy));
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

/** 들어온 순서(firstSeenAt)로 가장 최근 BOARD_KEEP 개만 */
function newestKept(posts) {
  if (posts.length <= BOARD_KEEP) return posts;
  return [...posts]
    .sort((a, b) => String(b.firstSeenAt).localeCompare(String(a.firstSeenAt)) || a.id.localeCompare(b.id))
    .slice(0, BOARD_KEEP);
}

/** 핸드드립·푸어오버 게시판에 남아 있는 글 id (보관 기간이 지나도 지우지 않을 글) */
export function keptBoardIds(all = store.allPosts()) {
  return new Set([...boardPosts('story', {}, all), ...boardPosts('pick', {}, all)].map((p) => p.id));
}

/** 방문자에게 보일 출처인지: 수집 중이거나, 수집을 껐어도 공개 글이 남은 출처 (/api/meta 와 공개 스냅샷이 같은 기준) */
export const sourceShown = (sourceId, activeIds, count, admin = false) => admin || activeIds.has(sourceId) || count > 0;

/** 같은 묶음의 다른 글 중 이 글과 같은 상태로 보이는 것 (Claude 검수 대기 중인 사본은 빼고) */
export function alsoOnOf(p, groups) {
  return (groups?.get(groupKey(p)) || [])
    .filter((d) => d.id !== p.id && d.status === p.status && !isPending(d))
    .map((d) => ({ source: d.source, url: d.url }));
}

/** 최신순 기준 시각 (ms) */
export const ts = (p) => new Date(p.postedAt || p.firstSeenAt).getTime() || 0;

/**
 * 인기순 점수: 같은 출처 안에서의 반응 순위(백분위)에 시간 감쇠를 곱한다. 클수록 위.
 * 백분위는 넘겨준 글 목록 안에서 출처별로 센다.
 * @returns {Map<string, number>} id → 점수
 */
export function hotScores(posts, now = Date.now()) {
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
  const out = new Map();
  for (const p of posts) out.set(p.id, pct.get(p.id) * Math.exp(-Math.max(0, now - ts(p)) / (36 * 3600e3)));
  return out;
}

export function sortPosts(posts, sort) {
  if (sort === 'shorts') return posts.sort((a, b) => (b.shortsScore ?? 0) - (a.shortsScore ?? 0) || ts(b) - ts(a));
  if (sort === 'hot') {
    // 점수가 같으면(반응이 출처 최하위라 0점인 글끼리 등) 최신순 — 공개 사이트(Worker)도 같은 순서로 푼다
    const score = hotScores(posts);
    return posts.sort((a, b) => score.get(b.id) - score.get(a.id) || ts(b) - ts(a));
  }
  return posts.sort((a, b) => ts(b) - ts(a));
}
