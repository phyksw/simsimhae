// 클라우드로 옮기기: 로컬 data/posts.json(글·출처 상태·설정) + data/custom-rules.json 을 받아 상태를 통째로 바꾼다.
// POST /api/admin/import (src/api.js) 가 부르고, scripts/push-to-cloud.js 가 로컬 파일을 나눠 올린다.
import { loadSources } from './sources/index.js';
import { classify, saveCustomRules, rulesFingerprint } from './filter.js';
import { rescoreAll } from './crawler.js';
import * as store from './store.js';

const STATUSES = ['ok', 'adult', 'blocked'];
/** 글 하나의 크기 상한 (DO 저장소 한 행 2MB 보다 넉넉히 아래) */
export const POST_MAX_CHARS = 1_000_000;

/** 받은 글 목록: 배열이든 posts.json 처럼 id → 글 객체든 배열로 */
export function postList(posts) {
  if (Array.isArray(posts)) return posts;
  if (posts && typeof posts === 'object') return Object.values(posts);
  return [];
}

/**
 * 받은 글 하나를 검사·정리한다. 형식이 틀리면 null.
 * @param {any} raw
 * @param {Record<string, any>} srcById
 */
export function cleanPost(raw, srcById = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  // published: 예전 공개 사이트 업로드 기록 (클라우드에는 필요 없다)
  const { published, ...p } = raw; // eslint-disable-line no-unused-vars
  if (typeof p.id !== 'string' || !p.id || p.id.length > 300) return null;
  if (typeof p.source !== 'string' || !/^[a-z0-9_-]{1,40}$/i.test(p.source)) return null;
  if (typeof p.title !== 'string' || !p.title || p.title.length > 1000) return null;
  if (typeof p.url !== 'string' || p.url.length > 2000 || !/^https?:\/\//i.test(p.url)) return null;
  if (typeof p.firstSeenAt !== 'string' || Number.isNaN(Date.parse(p.firstSeenAt))) return null;
  if (!p.auto || typeof p.auto !== 'object' || !STATUSES.includes(p.auto.status)) p.auto = classify(p, srcById[p.source] || {});
  if (p.manual != null && !STATUSES.includes(p.manual)) p.manual = null;
  p.status = store.resolveStatus(p);
  if (typeof p.shortsScore !== 'number' || !Number.isFinite(p.shortsScore)) p.shortsScore = 0;
  if (JSON.stringify(p).length > POST_MAX_CHARS) return null;
  return p;
}

/** 실행 설정 중 옮길 것만 (규칙 지문은 이쪽에서 새로 계산한다) */
function cleanSettings(s) {
  const out = {};
  if (typeof s?.live === 'boolean') out.live = s.live;
  if (Number.isFinite(Number(s?.intervalMin)) && s?.intervalMin != null) out.intervalMin = Math.max(3, Math.min(180, Math.round(Number(s.intervalMin))));
  return out;
}

function cleanSources(s) {
  const out = {};
  if (!s || typeof s !== 'object') return out;
  for (const [id, st] of Object.entries(s)) if (/^[a-z0-9_-]{1,40}$/i.test(id) && st && typeof st === 'object' && !Array.isArray(st)) out[id] = st;
  return out;
}

/**
 * 상태를 통째로 바꾼다.
 * @param {{sources?: any, lastCrawlAt?: string|null, settings?: any, rules?: {block?: string[], adult?: string[], allow?: string[]}}} data
 * @param {any[]} rawPosts
 * @returns {Promise<{posts: number, skipped: number, rules: boolean}>}
 */
export async function applyImport(data, rawPosts) {
  const list = await loadSources();
  const srcById = Object.fromEntries(list.map((s) => [s.id, s]));
  const posts = {};
  let skipped = 0;
  for (const raw of rawPosts) {
    const p = cleanPost(raw, srcById);
    if (!p || Object.hasOwn(posts, p.id)) {
      skipped++;
      continue;
    }
    posts[p.id] = p;
  }
  // 대표 글이 빠졌거나 사본을 가리키는 묶음은 풀어 둔다 (고리·끊긴 묶음 방지)
  for (const p of Object.values(posts)) {
    if (p.dupOf && (!Object.hasOwn(posts, p.dupOf) || posts[p.dupOf].dupOf || p.dupOf === p.id)) p.dupOf = null;
  }
  const lastCrawlAt = typeof data?.lastCrawlAt === 'string' && !Number.isNaN(Date.parse(data.lastCrawlAt)) ? data.lastCrawlAt : null;
  store.replaceAll({ posts, sources: cleanSources(data?.sources), lastCrawlAt, settings: cleanSettings(data?.settings) });
  const withRules = data?.rules !== undefined;
  if (withRules) saveCustomRules(data.rules || {});
  rescoreAll();
  // 같은 코드·규칙으로 이미 판정된 글이라 다시 판정하지 않는다 (지금 규칙의 지문을 적어 둔다)
  store.updateSettings({ rulesHash: rulesFingerprint(list) });
  return { posts: Object.keys(posts).length, skipped, rules: withRules };
}
