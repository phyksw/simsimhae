// 수집기: 모든 소스의 목록을 받아 저장소에 반영하고, 키워드 판정 → (켜져 있으면) Claude 검수 → 중복 묶기 → 오래된 글 정리.
// 로컬(npm start)과 클라우드(SiteDO 알람)가 같은 코드를 쓴다. 예약 방법만 setScheduler 로 바꿔 끼운다.
import { EventEmitter } from 'node:events';
import { config } from './config.js';
import { loadSources } from './sources/index.js';
import { classify, shortsScore, titleKey } from './filter.js';
import { classifyPosts } from './ai.js';
import { forgetCached } from './reader.js';
import { withRequestScope } from './lib/http.js';
import * as store from './store.js';
import { keptBoardIds } from './boards.js';

const DUP_WINDOW_MS = 7 * 864e5;
const RANK = { ok: 0, adult: 1, blocked: 2 };
let running = null;

// 수집 시작·끝 알림 ('state' = 실시간 상태, 'crawl' = 수집 1회 끝). 수집 1회마다 각각 한 번씩만 나간다.
export const events = new EventEmitter();

export function isRunning() {
  return !!running;
}

/** 활성 소스 목록 (설정의 SOURCES / DISABLE_SOURCES 반영) */
export async function activeSources() {
  const all = await loadSources();
  return all.filter(
    (s) =>
      !s.disabled &&
      (!config.enabledSources.length || config.enabledSources.includes(s.id)) &&
      !config.disabledSources.includes(s.id),
  );
}

function median(nums) {
  const a = nums.filter((n) => typeof n === 'number' && Number.isFinite(n)).sort((x, y) => x - y);
  if (!a.length) return undefined;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/** 소스별 반응 중앙값 (최근 3일) */
function sourceMedians(posts) {
  const since = Date.now() - 3 * 864e5;
  const by = new Map();
  for (const p of posts) {
    if (new Date(p.firstSeenAt).getTime() < since) continue;
    if (!by.has(p.source)) by.set(p.source, []);
    by.get(p.source).push(p);
  }
  const out = {};
  for (const [src, arr] of by) {
    out[src] = {
      likes: median(arr.map((p) => p.likes)),
      comments: median(arr.map((p) => p.commentCount)),
      views: median(arr.map((p) => p.views)),
    };
  }
  return out;
}

/** 키워드 점수와 Claude 점수를 합친 최종 쇼츠 점수 */
function finalShorts(p, med) {
  const kw = shortsScore(p, med);
  if (p.status !== 'ok') return Math.min(kw, 10);
  return p.ai ? Math.round(p.ai.shortsScore * 0.7 + kw * 0.3) : kw;
}

/** 지금 저장된 글 기준 소스별 반응 중앙값 (여러 글을 다시 계산할 때 한 번만 구해서 넘긴다) */
export function currentMedians() {
  return sourceMedians(store.allPosts());
}

/** 한 글의 쇼츠 점수를 지금 상태 기준으로 다시 계산 (관리자 지정·규칙 재판정·본문 검사로 상태가 바뀌었을 때) */
export function rescorePost(p, med = currentMedians()) {
  p.shortsScore = finalShorts(p, med[p.source]);
  return p.shortsScore;
}

/**
 * 제목으로 다시 판정하되, 본문 검사로 올라간 판정(사유가 '본문 '으로 시작)은 제목이 바뀌었다고 낮추지 않는다.
 * (본문은 다음 미리보기 때 다시 검사한다 — 호출 측이 bodyChecked 를 지운다)
 */
function rejudgeKeepingBody(p, src) {
  const t = classify(p, src);
  const prev = p.auto;
  const bodyReasons = (prev?.reasons || []).filter((r) => r.startsWith('본문 '));
  if (bodyReasons.length && RANK[prev.status] > RANK[t.status]) {
    return { status: prev.status, reasons: [...new Set([...t.reasons, ...bodyReasons])], flags: { ...t.flags, ...(prev.flags || {}) } };
  }
  return t;
}

/** 모든 글의 쇼츠 점수 다시 계산 (Claude 판정이 새로 들어왔거나 반응 수치가 바뀌었을 때) */
export function rescoreAll() {
  const all = store.allPosts();
  const med = sourceMedians(all);
  for (const p of all) {
    const sc = finalShorts(p, med[p.source]);
    if (sc !== p.shortsScore) {
      p.shortsScore = sc;
      store.upsertPost(p);
    }
  }
}

/**
 * 출처 하나의 목록을 받아 반영한다.
 * 목록 요청은 같은 사이트 대기열에서 방문자 미리보기보다 먼저 나가고(priority 'crawl'),
 * signal 이 끊기면(출처별 시간 예산) 보내던 요청을 끊고 그때까지 받은 목록만 반영한다.
 * @param {any} src
 * @param {string} now
 * @param {AbortSignal} [signal]
 */
async function crawlSource(src, now, signal) {
  const t0 = Date.now();
  const items = [];
  const errors = [];
  for (let page = 1; page <= config.pagesPerSource; page++) {
    if (signal?.aborted) {
      errors.push(`p${page}: 시간 초과`);
      break;
    }
    try {
      items.push(...(await withRequestScope({ priority: 'crawl', signal }, () => src.list(page))));
    } catch (e) {
      errors.push(`p${page}: ${signal?.aborted ? '시간 초과' : e.status ? `HTTP ${e.status}` : e.message}`);
      if (page === 1 || signal?.aborted) break;
    }
  }
  let added = 0;
  const fresh = [];
  const seen = new Set();
  for (const it of items) {
    if (!it?.postId || !it.title || !it.url) continue;
    const id = `${src.id}:${it.postId}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const existing = store.getPost(id);
    if (existing) {
      // 반응 수치·썸네일 갱신. 제목이 바뀌었으면 다시 판정.
      const titleChanged = existing.title !== it.title;
      Object.assign(existing, {
        title: it.title,
        commentCount: it.commentCount ?? existing.commentCount ?? null,
        views: it.views ?? existing.views ?? null,
        likes: it.likes ?? existing.likes ?? null,
        thumbnail: existing.thumbnail || it.thumbnail || null,
        nsfwHint: !!(existing.nsfwHint || it.nsfwHint),
        category: it.category ?? existing.category ?? null,
        updatedAt: now,
      });
      if (titleChanged || (it.nsfwHint && existing.auto.status === 'ok')) {
        existing.auto = rejudgeKeepingBody(existing, src);
        existing.titleKey = titleKey(existing.title);
        if (titleChanged) {
          // 글이 고쳐졌으면 본문도 바뀌었을 수 있으니 다음 미리보기 때 본문을 다시 검사한다
          if (existing.bodyChecked) existing.bodyChecked = false;
          forgetCached(existing.id);
          if (config.ai.enabled) {
            existing.aiPending = true;
            existing.aiTries = 0;
            existing.aiNextAt = null;
            existing.aiGaveUp = false;
          }
        }
      }
      existing.status = store.resolveStatus(existing);
      store.upsertPost(existing);
      continue;
    }
    const p = {
      id,
      source: src.id,
      postId: it.postId,
      title: it.title,
      url: it.url,
      author: it.author ?? null,
      postedAt: it.postedAt ?? null,
      firstSeenAt: now,
      updatedAt: now,
      commentCount: it.commentCount ?? null,
      views: it.views ?? null,
      likes: it.likes ?? null,
      category: it.category ?? null,
      nsfwHint: !!it.nsfwHint,
      thumbnail: it.thumbnail ?? null,
      manual: null,
      ai: null,
      aiPending: config.ai.enabled,
      dupOf: null,
      titleKey: titleKey(it.title),
      shorts: null,
    };
    p.auto = classify(p, src);
    p.status = store.resolveStatus(p);
    p.shortsScore = 0;
    store.upsertPost(p);
    fresh.push(p);
    added++;
  }
  const state = {
    lastRunAt: now,
    ms: Date.now() - t0,
    fetched: items.length,
    added,
    ok: errors.length === 0 && items.length > 0,
    error: errors.join(' / ') || (items.length === 0 ? '목록이 비어 있음' : null),
  };
  if (state.ok) state.lastOkAt = now;
  store.setSourceState(src.id, state);
  return fresh;
}

/** 새 글을 기존 글과 제목으로 비교해 같은 글(다른 사이트에 퍼간 것)을 묶는다 */
// 비슷한 제목 비교용 키: 강조어·욕설 강조·파일 꼬리표를 빼서 "택시 탈 때 ㅈㄹ/존나 이해 안되는 반응" 을 같게 본다
const INTENSIFIERS = /존나|졸라|존내|ㅈㄴ|ㅈㄹ|ㅈㄴㄱ|겁나|진짜|ㄹㅇ|레알|너무|완전|jpg|jpeg|gif|mp4|txt|png|webp/g;
function simKey(p) {
  return (p.titleKey || titleKey(p.title)).replace(INTENSIFIERS, '');
}
function bigrams(s) {
  const a = [...s];
  const m = new Map();
  for (let i = 0; i < a.length - 1; i++) {
    const g = a[i] + a[i + 1];
    m.set(g, (m.get(g) || 0) + 1);
  }
  return { m, n: Math.max(0, a.length - 1) };
}
/** 문자 2-gram Dice 계수 (0~1) */
function dice(x, y) {
  if (!x.n || !y.n) return 0;
  let inter = 0;
  for (const [g, c] of x.m) inter += Math.min(c, y.m.get(g) || 0);
  return (2 * inter) / (x.n + y.n);
}
const SIM_MIN = 0.8;

/** 같은 글의 한쪽에 후방 표시가 있으면 다른 쪽에도 옮긴다 (사이트마다 표시 여부가 달라서 잠금 없이 새는 것 방지) */
function shareNsfw(a, b, srcById) {
  if (a.nsfwHint === b.nsfwHint) return;
  for (const p of [a, b]) {
    if (p.nsfwHint) continue;
    p.nsfwHint = true;
    p.auto = rejudgeKeepingBody(p, srcById[p.source] || {});
    p.status = store.resolveStatus(p);
    store.upsertPost(p);
  }
}

/**
 * 새 글을 기존 글과 제목으로 비교해 같은 글(다른 사이트에 퍼간 것)을 묶는다.
 * 1) 정규화한 제목이 같으면 묶고, 2) 아니면 강조어를 뺀 제목의 2-gram 유사도가 0.8 이상인 다른 출처 글과 묶는다.
 */
function linkDuplicates(fresh, srcById = {}) {
  const now = Date.now();
  const index = new Map();
  for (const p of store.allPosts()) {
    if (p.dupOf || !p.titleKey || p.titleKey.length < 6) continue;
    if (now - new Date(p.firstSeenAt).getTime() > DUP_WINDOW_MS) continue;
    const prev = index.get(p.titleKey);
    // 먼저 본 글을 대표로
    if (!prev || prev.firstSeenAt > p.firstSeenAt || (prev.firstSeenAt === p.firstSeenAt && prev.id > p.id)) index.set(p.titleKey, p);
  }
  const candidates = [...index.values()].map((q) => ({ q, key: simKey(q) })).filter((c) => [...c.key].length >= 8);
  for (const c of candidates) c.bg = bigrams(c.key);
  for (const p of fresh) {
    let primary = index.get(p.titleKey);
    if (!primary || primary.id === p.id || primary.source === p.source) {
      primary = null;
      const key = simKey(p);
      const len = [...key].length;
      if (len >= 8) {
        const bg = bigrams(key);
        let best = 0;
        for (const c of candidates) {
          // 항상 "먼저 본 글" 을 대표로 → 서로를 가리키는 고리가 생기지 않는다
          if (c.q.id === p.id || c.q.source === p.source || c.q.dupOf || !seenBefore(c.q, p)) continue;
          const l2 = [...c.key].length;
          if (l2 < len * 0.6 || l2 > len * 1.67) continue;
          const d = c.key === key ? 1 : dice(bg, c.bg);
          if (d >= SIM_MIN && d > best) {
            best = d;
            primary = c.q;
          }
        }
      }
    }
    if (primary && primary.id !== p.id && primary.source !== p.source && !primary.dupOf && seenBefore(primary, p)) {
      p.dupOf = primary.id;
      store.upsertPost(p);
      shareNsfw(p, primary, srcById);
    }
  }
}

const seenBefore = (a, b) => String(a.firstSeenAt) < String(b.firstSeenAt) || (a.firstSeenAt === b.firstSeenAt && a.id < b.id);

/** 이미 저장된 글 전체를 다시 묶는다 (중복 판정 방식이 바뀌었을 때 한 번). 대표 글(사본이 있는 글)은 그대로 둔다. */
export async function relinkAll() {
  const srcById = Object.fromEntries((await loadSources()).map((x) => [x.id, x]));
  const all = store.allPosts();
  const hasCopies = new Set(all.filter((p) => p.dupOf).map((p) => p.dupOf));
  const before = all.filter((p) => p.dupOf).length;
  const list = all.filter((p) => !p.dupOf && !hasCopies.has(p.id)).sort((a, b) => (seenBefore(a, b) ? -1 : 1));
  linkDuplicates(list, srcById);
  return store.allPosts().filter((p) => p.dupOf).length - before;
}

function prune() {
  const cutoff = Date.now() - config.retentionDays * 864e5;
  // 소소한 이야기·웃긴 것만 게시판에 남아 있는 글(각 최근 BOARD_KEEP 개)은 오래돼도 지우지 않는다
  const kept = keptBoardIds();
  let removed = 0;
  for (const p of store.allPosts()) {
    if (p.shorts || p.manual || kept.has(p.id)) continue;
    if (new Date(p.firstSeenAt).getTime() < cutoff) {
      store.deletePost(p.id);
      removed++;
    }
  }
  // 대표 글이 지워진 중복 글은 독립시킨다
  for (const p of store.allPosts()) {
    if (p.dupOf && !store.getPost(p.dupOf)) {
      p.dupOf = null;
      store.upsertPost(p);
    }
  }
  return removed;
}

// 판정 실패 뒤 다시 보내기까지 기다리는 시간: 15분 → 30분 → 1시간 … 최대 6시간
const aiBackoffMs = (tries) => Math.min(15 * 60e3 * 2 ** Math.max(0, tries - 1), 6 * 3600e3);

/**
 * Claude 검수 대기 중인 글을 판정 (이번에 새로 들어온 글 + 지난번 실패분).
 * 새 글부터 최대 config.ai.maxPerRun 개만 보내고, 실패한 글은 횟수를 세어 점점 늦게 다시 보낸다.
 */
async function runAi() {
  if (!config.ai.enabled) return 0;
  const nowMs = Date.now();
  const pending = store
    .allPosts()
    .filter((p) => p.aiPending && !p.manual && (p.aiTries ?? 0) < config.ai.maxTries && !(p.aiNextAt && Date.parse(p.aiNextAt) > nowMs))
    .sort((a, b) => String(b.firstSeenAt).localeCompare(String(a.firstSeenAt)) || a.id.localeCompare(b.id))
    .slice(0, Math.max(1, config.ai.maxPerRun));
  if (!pending.length) return 0;
  const sources = Object.fromEntries((await loadSources()).map((s) => [s.id, s]));
  const results = await classifyPosts(pending.map((p) => ({ title: p.title, category: p.category, sourceName: sources[p.source]?.name || p.source })));
  let done = 0;
  const at = new Date().toISOString();
  pending.forEach((p, i) => {
    const r = results[i];
    if (r === undefined) return; // 이번엔 보내지 않음 (한도·서버 문제로 실행을 접음)
    if (r === null) {
      p.aiTries = (p.aiTries ?? 0) + 1;
      if (p.aiTries >= config.ai.maxTries) {
        // 계속 실패하는 글: 키워드 판정만으로 두고 더는 보내지 않는다 (review-queue 에는 계속 나온다)
        p.aiPending = false;
        p.aiGaveUp = true;
        p.aiNextAt = null;
        p.status = store.resolveStatus(p);
      } else {
        p.aiNextAt = new Date(nowMs + aiBackoffMs(p.aiTries)).toISOString();
      }
      store.upsertPost(p);
      return;
    }
    p.ai = { ...r, model: config.ai.model, at };
    p.aiPending = false;
    p.aiTries = 0;
    p.aiNextAt = null;
    p.aiGaveUp = false;
    p.status = store.resolveStatus(p);
    store.upsertPost(p);
    done++;
  });
  return done;
}

/**
 * 전체 수집 1회. 이미 돌고 있으면 그 작업을 기다린다.
 * 시작할 때 'state'(running:true), 끝나면 'crawl' 이벤트를 수집 1회당 한 번씩만 보낸다.
 * @returns {Promise<{added: number, addedPublic: number, aiReviewed: number, removed: number, ms: number, sources: Record<string, any>, freshIds: string[]}>}
 */
export function crawlAll() {
  if (running) return running;
  const job = (async () => {
    const t0 = Date.now();
    const now = new Date().toISOString();
    const sources = await activeSources();
    // 출처마다 시간 예산: 느린 출처 하나가 수집 전체(알람·옮기기·다음 수집)를 붙잡지 않게
    const budget = config.crawlSourceBudgetMs;
    const freshLists = await Promise.all(
      sources.map((s) =>
        crawlSource(s, now, budget > 0 ? AbortSignal.timeout(budget) : undefined).catch((e) => {
          store.setSourceState(s.id, { lastRunAt: now, ok: false, error: e.message });
          return [];
        }),
      ),
    );
    const fresh = freshLists.flat();
    linkDuplicates(fresh, Object.fromEntries(sources.map((x) => [x.id, x])));
    const aiReviewed = await runAi().catch((e) => {
      console.warn(`[crawl] Claude 검수 실패: ${e.message}`);
      return 0;
    });
    // 쇼츠 점수는 반응 수치가 바뀌므로 매번 다시 계산
    rescoreAll();
    const removed = prune();
    store.setLastCrawl(now);
    store.saveNow();
    // 이번에 새로 들어와 바로 공개 목록('전체' 게시판)에 보이는 글 수 — 목록 API 와 같은 기준
    const shown = new Set(store.onePerGroup(store.allPosts().filter(store.isPublic)).map((p) => p.id));
    const addedPublic = fresh.filter((p) => shown.has(p.id)).length;
    const summary = {
      added: fresh.length,
      addedPublic,
      aiReviewed,
      removed,
      ms: Date.now() - t0,
      sources: store.getDb().sources,
      freshIds: fresh.map((p) => p.id), // 이번에 새로 들어온 글 (서버가 게시판별 새 글 수를 셀 때 씀)
    };
    console.log(
      `[crawl] 새 글 ${fresh.length}개(공개 ${addedPublic}), Claude 검수 ${aiReviewed}개, 정리 ${removed}개 (${(summary.ms / 1000).toFixed(1)}초) — ` +
        sources.map((s) => `${s.short}:${store.getDb().sources[s.id]?.ok ? store.getDb().sources[s.id].added : '실패'}`).join(' '),
    );
    return summary;
  })();
  // finally 를 먼저 걸어 두어 'crawl' 이벤트가 나갈 때는 이미 running 이 풀려 있게 한다
  running = job.finally(() => {
    running = null;
  });
  events.emit('state', liveState());
  job.then(
    (s) => events.emit('crawl', { added: s.added, addedPublic: s.addedPublic, aiReviewed: s.aiReviewed, at: store.getDb().lastCrawlAt, freshIds: s.freshIds }),
    () => {}, // 실패는 기다리는 쪽(tick/crawlNow)이 기록한다
  );
  return running;
}

// ---- 실시간(자동 수집) 스케줄러: 관리자 화면의 ON/OFF 버튼으로 켜고 끈다 ----
// 예약 방법은 바꿔 끼울 수 있다: 로컬은 이 프로세스의 setTimeout, 클라우드는 Durable Object 알람(worker/site.js 가 setScheduler).
// 스케줄러 모양: { arm(ms|null) — ms 뒤에 runScheduled() 가 불리게(없으면 취소), nextRunAt(): ISO|null, pending?(): 곧 돌 수집이 있는지 }

let timer = null;
let timerAt = null;
const timerScheduler = {
  arm(ms) {
    clearTimeout(timer);
    timer = null;
    timerAt = null;
    if (ms == null) return;
    timerAt = new Date(Date.now() + ms).toISOString();
    timer = setTimeout(() => {
      timer = null;
      timerAt = null;
      runScheduled();
    }, ms);
  },
  nextRunAt: () => timerAt,
};
let scheduler = timerScheduler;

/** 예약 방법을 바꾼다 (클라우드: DO 알람). null 이면 기본(setTimeout)으로. */
export function setScheduler(s) {
  if (scheduler === timerScheduler) timerScheduler.arm(null);
  scheduler = s || timerScheduler;
}

/**
 * 클라우드에 관리자 비밀번호(Worker 비밀 ADMIN_PASSWORD)가 없으면 자동 수집을 켜지 않는다.
 * 관리자 화면에 들어갈 수 없어 끌 방법이 없기 때문이다 (비밀을 넣으면 다시 켜진다). 로컬은 늘 비밀번호가 있다.
 */
export function autoCrawlBlocked() {
  return !!config.secretsMissing?.includes('ADMIN_PASSWORD');
}

export function liveState() {
  const s = store.getSettings();
  return {
    live: !autoCrawlBlocked() && (s.live ?? config.crawlIntervalMin > 0),
    intervalMin: s.intervalMin || config.crawlIntervalMin || 15,
    // 클라우드는 '지금 수집'을 알람으로 넘기므로, 알람이 아직 시작되지 않았어도 수집 중으로 보인다
    running: isRunning() || !!scheduler.pending?.(),
    nextRunAt: scheduler.nextRunAt() ?? null,
    lastCrawlAt: store.getDb().lastCrawlAt,
  };
}

/** 예약된 수집 1회 (로컬: 타이머, 클라우드: DO 알람이 부른다). 실패해도 다음 수집을 다시 예약한다. */
export async function runScheduled() {
  try {
    return await crawlAll(); // 시작·끝 이벤트는 crawlAll 이 보낸다
  } catch (e) {
    console.error(`[crawl] 실패: ${e.stack || e.message}`);
    return null;
  } finally {
    schedule();
  }
}

/** 실시간이 켜져 있으면 delayMs(기본: 간격) 뒤로 다음 수집을 예약하고, 꺼져 있으면 예약을 지운다 */
export function schedule(delayMs) {
  const st = liveState();
  scheduler.arm(st.live ? (delayMs ?? st.intervalMin * 60e3) : null);
  events.emit('state', liveState());
}

/** 서버 시작 시 호출. 실시간이 켜져 있으면 곧바로 첫 수집. */
export function startScheduler() {
  const st = liveState();
  console.log(st.live ? `[crawl] 실시간 수집 ON (${st.intervalMin}분 간격)` : '[crawl] 실시간 수집 OFF — 관리자 화면에서 켜거나 "지금 수집"');
  schedule(st.live ? 3000 : undefined);
}

/** 관리자: 실시간 ON/OFF·간격 변경 */
export function setLive({ live, intervalMin }) {
  const patch = {};
  if (typeof live === 'boolean') patch.live = live;
  if (Number.isFinite(intervalMin)) patch.intervalMin = Math.max(3, Math.min(180, Math.round(intervalMin)));
  const wasLive = liveState().live;
  store.updateSettings(patch);
  // 막 켰으면 바로 한 번 수집, 간격만 바꿨으면 새 간격으로 다시 예약
  schedule(!wasLive && liveState().live ? 1000 : undefined);
  return liveState();
}

/** 관리자: 지금 수집 (실시간 꺼져 있어도 동작) */
export async function crawlNow() {
  scheduler.arm(null);
  try {
    return await crawlAll(); // 이미 돌고 있으면 같은 작업을 기다릴 뿐 이벤트를 또 보내지 않는다
  } finally {
    schedule();
  }
}
