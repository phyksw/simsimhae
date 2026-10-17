// SiteDO: 사이트 전체 상태를 가진 Durable Object 하나('main'). 로컬의 src/server.js 한 프로세스와 같은 역할이다.
//   - 상태: 메모리(src/store.js) + DO SQLite(worker/storage.js)에 영속. 요청·알람이 끝날 때마다 바뀐 것만 저장한다.
//   - 알람: 실시간 ON 이면 간격마다 수집(src/crawler.js crawlAll — 수집 → 키워드 판정 → [API 키 있으면 Claude] → 점수·묶음),
//           끝나면 핸드드립·웃긴 것만 글의 미리보기를 몇 개 미리 준비한다. '지금 수집'도 알람으로 돈다(Workers 한도 안에서).
//   - API: src/api.js (로컬과 같은 경로·응답 모양). /api/events·/api/sync/*·/api/admin/publish 는 없다(404).
// 설계: worker/CLOUD.md
import { DurableObject } from 'cloudflare:workers';
import { configure, config } from '../src/config.js';
import * as store from '../src/store.js';
import * as crawler from '../src/crawler.js';
import { setRulesBackend, loadCustomRules } from '../src/filter.js';
import { setReadCache, readPost, hasCached, forgetAll } from '../src/reader.js';
import { boardPosts, sortPosts } from '../src/boards.js';
import { requestCount } from '../src/lib/http.js';
import { createApi } from '../src/api.js';
import { rejudgeIfRulesChanged } from '../src/rejudge.js';
import { migrate, kvStore, postsBackend, rulesBackend, readCache, pruneReads, attemptsStore, stagingStore } from './storage.js';
import { HttpError, readBody } from './http.js';

/** 요청 본문 상한: 보통 64KB (로컬 express 와 같음) */
export const BODY_MAX_BYTES = 64 * 1024;
/**
 * 옮기기(/api/admin/import) 한 번의 본문 상한. 관리자 로그인을 확인한 요청만 이만큼 읽는다.
 * scripts/push-to-cloud.js 는 기본 2MB(최대 3MB)씩 나눠 보낸다 — 해석할 때 DO 메모리(128MB)를 넉넉히 남기게 작게 둔다.
 */
export const IMPORT_MAX_BYTES = 4 * 1024 * 1024;
const IMPORT_PATH = '/api/admin/import';
/** 미리보기를 못 가져온 글은 점점 늦게, 이만큼까지만 다시 시도 */
const PREFETCH_FAIL_MAX = 4;
const prefetchBackoffMs = (n) => Math.min(15 * 60e3 * 2 ** (n - 1), 6 * 3600e3);
/** 미리 준비는 알람 시작부터 이 시간 안에서만 (못 가져오는 글 하나가 재시도로 1분 넘게 걸릴 수 있다) */
export const PREFETCH_BUDGET_MS = 4 * 60e3;
/** 도중에 끊긴 '지금 수집'을 다시 돌리는 최대 횟수 (수집이 매번 isolate 를 죽이는 경우 무한히 되풀이하지 않게) */
export const CRAWL_RETRY_MAX = 3;

export class SiteDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    this.alarmAt = null;
    // 준비가 끝날 때까지 다른 요청·알람을 받지 않는다
    this.ready = ctx.blockConcurrencyWhile(() => this.init());
  }

  async init() {
    configure(this.env || {}, { mode: 'cloud' });
    const storage = this.ctx.storage;
    migrate(storage.sql);
    this.kv = kvStore(storage.sql);
    store.setBackend(postsBackend(storage));
    store.load();
    setRulesBackend(rulesBackend(this.kv));
    setReadCache(readCache(storage.sql), { ttlMs: config.cloud.readCacheHours * 3600e3 });
    this.alarmAt = (await storage.getAlarm()) ?? null;
    crawler.setScheduler(this.scheduler());
    this.api = createApi({
      crawlNow: () => this.requestCrawl(),
      attempts: attemptsStore(storage.sql),
      staging: stagingStore(storage.sql, this.kv),
      afterImport: () => forgetAll(),
    });
    try {
      const n = await rejudgeIfRulesChanged();
      if (n !== null && store.allPosts().length) console.log(`[filter] 판정 규칙이 바뀌어 저장된 글을 다시 판정했어요 (상태가 바뀐 글 ${n}개)`);
    } catch (e) {
      console.error(`[filter] 시작 재판정 실패: ${e.message}`);
    }
    store.flush();
    if (crawler.autoCrawlBlocked()) console.warn('[site] Worker 비밀 ADMIN_PASSWORD 가 없어 자동 수집을 시작하지 않아요 (넣으면 다시 켜져요)');
    await this.checkAlarm(); // 배포·재시작 뒤에도 실시간 수집이 이어지게
  }

  /** 저장에 실패했을 때: 메모리를 저장된 상태로 되돌린다 (실패로 알린 변경이 나중에 저장되지 않게) */
  reloadState() {
    try {
      store.load();
      loadCustomRules();
    } catch (e) {
      console.error(`[store] 저장된 상태 다시 읽기 실패: ${e.message}`);
    }
  }

  /** 밀린 변경 저장. 실패해도 던지지 않는다 (밀린 변경은 남겨 두고 다음 요청·알람 때 다시 시도) */
  flushQuietly() {
    try {
      store.flush();
      return true;
    } catch (e) {
      console.error(`[store] 저장 실패: ${e.message}`);
      return false;
    }
  }

  // ---------- 알람 ----------

  /** crawler.js 의 예약을 DO 알람으로 */
  scheduler() {
    return {
      arm: (ms) => {
        // '지금 수집' 요청이 기다리고 있으면 어떤 예약(간격 변경·옮기기·수집 뒤 다음 차례)도 그 요청을 늦추거나 지우지 못한다.
        // 알람이 그 수집을 시작하면 표시에 startedAt 이 붙어 더는 기다리는 요청이 아니므로, 수집 뒤 schedule() 이 다시 0 으로 걸지 않는다.
        if (this.requested()) ms = 0;
        if (ms == null) this.clearAlarm();
        else this.armAt(Date.now() + Math.max(0, ms));
      },
      nextRunAt: () => (this.alarmAt ? new Date(this.alarmAt).toISOString() : null),
      pending: () => !!this.crawlFlag(),
    };
  }

  armAt(at) {
    this.alarmAt = at;
    this.ctx.storage.setAlarm(at)?.catch?.((e) => console.error(`[site] 알람 설정 실패: ${e.message}`));
  }

  clearAlarm() {
    this.alarmAt = null;
    this.ctx.storage.deleteAlarm()?.catch?.((e) => console.error(`[site] 알람 지우기 실패: ${e.message}`));
  }

  /**
   * 관리자 '지금 수집' 표시 { at, startedAt?, tries? }.
   * startedAt 이 없으면 아직 기다리는 요청, 있으면 알람이 그 수집을 시작했다는 뜻이다 (수집이 끝나면 지운다 —
   * 남아 있으면 도중에 끊긴 것이라 다음 알람이 다시 돌린다).
   */
  crawlFlag() {
    const v = this.kv.get('crawlRequested');
    if (typeof v === 'number') return { at: v }; // 예전 형식 (요청 시각만)
    return v && typeof v === 'object' ? v : null;
  }

  /** 관리자 '지금 수집'이 아직 시작되지 않고 기다리고 있는지 */
  requested() {
    const f = this.crawlFlag();
    return !!f && !f.startedAt;
  }

  /** 관리자 '지금 수집': 알람으로 넘긴다 (수집은 요청 한도가 아니라 알람 한도 안에서 돈다) */
  requestCrawl() {
    if (crawler.isRunning()) return { started: false, running: true };
    const waiting = this.requested();
    // 도중에 끊긴 채 남은 표시가 있어도 새 요청으로 처음부터 센다
    if (!waiting) this.kv.set('crawlRequested', { at: Date.now() });
    this.armAt(Date.now());
    return { started: !waiting, running: true };
  }

  async alarm() {
    await this.ready;
    this.alarmAt = null;
    const now = Date.now();
    let flag = this.crawlFlag();
    if (flag?.startedAt && (flag.tries || 1) >= CRAWL_RETRY_MAX) {
      // 같은 '지금 수집'이 여러 번 도중에 끊겼다 → 더 되풀이하지 않는다 (실시간이 켜져 있으면 다음 차례에 다시 돈다)
      console.error(`[alarm] '지금 수집'이 ${flag.tries}번 도중에 끊겨 다시 돌리지 않아요`);
      this.kv.del('crawlRequested');
      flag = null;
    }
    // 기다리는 '지금 수집', 또는 도중에 끊긴 '지금 수집'(Cloudflare 가 알람을 다시 부른 경우)
    const forced = !!flag;
    const st = crawler.liveState();
    const intervalMs = st.intervalMin * 60e3;
    // 안전망: 수집 도중 isolate 가 끝나도 다음 수집이 남게 먼저 걸어 둔다 (끝나면 crawler 가 다시 맞춘다)
    if (st.live) this.armAt(now + intervalMs);
    const last = Date.parse(st.lastCrawlAt || '') || 0;
    if (!forced && (!st.live || now - last < intervalMs / 2)) {
      // 실시간이 꺼졌거나 방금 수집했다 (겹침 방지) → 다음 차례만 맞춘다
      if (st.live) this.armAt(Math.max(now + 1000, last + intervalMs));
      else this.clearAlarm();
      this.flushQuietly();
      return;
    }
    // 시작했다고 먼저 적어 둔다: 수집 도중 끊겨 알람이 다시 오면 이 표시를 보고 다시 돌린다
    if (forced) this.kv.set('crawlRequested', { at: flag.at ?? now, startedAt: now, tries: (flag.tries || 0) + 1 });
    const before = requestCount();
    try {
      try {
        await crawler.runScheduled(); // 실패해도 다음 수집을 예약한다
      } finally {
        if (forced) this.kv.del('crawlRequested');
      }
      // 수집 결과를 먼저 저장하고 오래된 미리보기를 정리한다 (미리 준비가 길어지거나 끊겨도 남게)
      store.flush();
      pruneReads(this.ctx.storage.sql, config.cloud.readCacheHours * 3600e3);
      const n = await this.prefetch(before, { startedAt: now });
      store.flush();
      console.log(`[alarm] 수집 끝 — 미리보기 ${n}개 준비, 출처 요청 ${requestCount() - before}회`);
    } catch (e) {
      console.error(`[alarm] 실패: ${e?.stack || e?.message || e}`);
    } finally {
      this.flushQuietly();
      // 무슨 일이 있어도 실시간이 켜져 있으면 다음 알람이 남아 있게
      if (crawler.liveState().live && !this.alarmAt) this.armAt(Date.now() + intervalMs);
    }
  }

  /**
   * 핸드드립 → 웃긴 것만 글 중 미리보기가 없는 것을 몇 개 미리 가져온다 (방문자가 열 때 기다리지 않게).
   * - 수집을 끈 출처, 이번 수집에서 목록을 못 받은 출처, PC 가 받아 넣는 출처(crawler.pcFed)의 글과 PC 미리보기가 붙은 글은 가져오지 않는다.
   * - 못 가져온 글은 점점 늦게 몇 번만 다시 시도한다. 실패 기록은 실패할 때마다 바로 저장한다 (알람이 도중에 끊겨도 남게).
   * - 한 번에 시도하는 수는 성공 목표의 두 배까지, 시간은 알람 시작부터 budgetMs 까지.
   * @param {number} before 이번 알람이 시작될 때의 요청 수 (요청 상한을 넘지 않게)
   * @param {{startedAt?: number, budgetMs?: number}} [o] 알람 시작 시각과 시간 예산
   */
  async prefetch(before, { startedAt = Date.now(), budgetMs = PREFETCH_BUDGET_MS } = {}) {
    const limit = config.cloud.prefetchPerRun;
    if (!limit) return 0;
    const active = new Set((await crawler.activeSources()).map((s) => s.id));
    const listFailed = (id) => store.getDb().sources[id]?.ok === false;
    const all = store.allPosts();
    const queue = [];
    const seen = new Set();
    for (const board of ['story', 'pick']) {
      for (const p of sortPosts(boardPosts(board, {}, all), 'new')) {
        if (seen.has(p.id)) continue;
        seen.add(p.id);
        queue.push(p);
      }
    }
    const fails = this.kv.get('prefetchFails') || {};
    const save = () => {
      try {
        this.kv.set('prefetchFails', fails);
      } catch (e) {
        console.error(`[prefetch] 실패 기록 저장 실패: ${e.message}`);
      }
    };
    const now = Date.now();
    const busy = new Set(); // 같은 사이트 요청이 밀려 있는 출처 (이번 알람에서는 더 시도하지 않는다)
    let done = 0;
    let tries = 0;
    try {
      for (const p of queue) {
        if (done >= limit || tries >= limit * 2) break;
        if (Date.now() - startedAt > budgetMs) break;
        if (requestCount() - before >= config.cloud.requestBudget) break;
        // PC 가 받아 넣는 출처(여기서는 403)와 PC 미리보기가 붙은 글은 원문을 받지 않는다 — 방문자 미리보기는 PC 미리보기로 나간다
        if (!active.has(p.source) || listFailed(p.source) || crawler.pcFed(p.source) || p.pcRead || busy.has(p.source) || hasCached(p.id)) continue;
        const f = fails[p.id];
        if (f && (f.n >= PREFETCH_FAIL_MAX || f.nextAt > now)) continue;
        tries++;
        try {
          const data = await readPost(p);
          delete fails[p.id];
          if (data.statusChanged) {
            const fresh = store.getPost(p.id);
            if (fresh) {
              crawler.rescorePost(fresh);
              store.upsertPost(fresh);
            }
          }
          done++;
        } catch (e) {
          // 요청이 밀려 기다리지 않은 것은 글 탓이 아니다 → 실패로 세지 않고 그 출처만 이번에 건너뛴다
          if (e?.busy) {
            busy.add(p.source);
            continue;
          }
          const n = (f?.n || 0) + 1;
          fails[p.id] = { n, nextAt: Date.now() + prefetchBackoffMs(n) };
          save();
        }
      }
    } finally {
      for (const id of Object.keys(fails)) if (!store.getPost(id)) delete fails[id];
      save();
    }
    return done;
  }

  /**
   * 알람이 살아 있는지 확인하고 없으면 다시 건다 (Worker 의 cron 이 5분마다 RPC 로 부른다).
   * @returns {Promise<{live: boolean, nextRunAt: string|null}>}
   */
  async ensureAlarm() {
    await this.ready;
    return this.checkAlarm();
  }

  async checkAlarm() {
    const st = crawler.liveState();
    if (!crawler.isRunning()) {
      const cur = (await this.ctx.storage.getAlarm()) ?? null;
      this.alarmAt = cur;
      const now = Date.now();
      const flag = this.crawlFlag();
      if (flag) {
        // 기다리는 '지금 수집'의 알람이 없거나 늦게 잡혀 있으면, 또는 도중에 끊긴 '지금 수집'이 남아 있으면 바로 돌린다
        if (flag.startedAt || cur == null || cur > now + 5000) this.armAt(now);
      } else if (st.live) {
        const intervalMs = st.intervalMin * 60e3;
        const last = Date.parse(st.lastCrawlAt || '') || 0;
        const due = Math.max(now + 1000, last + intervalMs);
        if (cur == null || cur > due + 60e3) this.armAt(due);
      } else if (cur != null) this.clearAlarm();
    }
    this.flushQuietly();
    return { live: st.live, nextRunAt: this.alarmAt ? new Date(this.alarmAt).toISOString() : null };
  }

  // ---------- API ----------

  /** 요청 하나 → src/api.js 응답 (경로가 없으면 null) */
  async handle(request) {
    const url = new URL(request.url);
    let maxBytes = BODY_MAX_BYTES;
    if (request.method === 'POST' && url.pathname === IMPORT_PATH) {
      // 옮기기의 큰 본문은 관리자만: 본문을 읽기 전에 쿠키(헤더)로 확인한다.
      // 로그인하지 않은 요청이 큰 본문을 읽고 해석하게 만들어 DO 메모리를 넘기지 못하게.
      if (!this.api.isAdmin(headerRequest(request))) {
        await discardBody(request);
        return { status: 401, body: { error: '관리자 로그인이 필요해요' } };
      }
      maxBytes = IMPORT_MAX_BYTES;
    }
    return this.api.handle(await apiRequest(request, { maxBytes }));
  }

  async fetch(request) {
    await this.ready;
    let out;
    try {
      out = (await this.handle(request)) ?? { status: 404, body: { error: 'not found' } };
    } catch (e) {
      if (e instanceof HttpError) out = { status: e.status, body: { error: e.message } };
      else {
        // 오류 응답에는 내부 정보(스택·경로·비밀)를 내보내지 않는다
        console.error('[site]', e?.stack || e);
        out = { status: 500, body: { error: '서버 오류가 났어요' } };
      }
    }
    // 저장은 응답과 떼어 둔다: 저장소 오류가 이어져도 읽기(GET)는 이미 만든 결과를 그대로 준다 (밀린 변경은 다음에 다시 저장).
    // 쓰기 요청이 저장하지 못했으면 메모리를 저장된 상태로 되돌리고 실패로 알린다 ('실패'인데 메모리에는 반영된 상태가 남지 않게).
    if (!this.flushQuietly() && request.method !== 'GET' && request.method !== 'HEAD') {
      this.reloadState();
      out = { status: 500, body: { error: '저장하지 못했어요' } };
    }
    return toResponse(out);
  }
}

/** 본문 없이 헤더만으로 보는 요청 (관리자 쿠키 확인용) */
function headerRequest(request) {
  return { header: (k) => request.headers.get(k) ?? undefined, isLocal: false };
}

/**
 * 받지 않을 본문을 버린다: 조금(BODY_MAX_BYTES)만 비우고, 더 크면 그 자리에서 멈춘다
 * (알려 준 길이가 크면 읽지 않고, 길이를 모르면 읽다가 넘는 순간 readBody 가 끊는다 — 413 과 같은 방식).
 */
async function discardBody(request) {
  if (request.body) await readBody(request, BODY_MAX_BYTES).catch(() => {});
}

/**
 * Request → src/api.js 요청
 * @param {Request} request
 * @param {{maxBytes?: number}} [o] 읽을 JSON 본문의 상한 (기본 64KB. 옮기기는 관리자를 확인한 뒤에만 크게)
 */
export async function apiRequest(request, { maxBytes = BODY_MAX_BYTES } = {}) {
  const url = new URL(request.url);
  const isJson = /^application\/json\s*(;|$)/i.test(request.headers.get('content-type') || '');
  let body;
  if (request.method === 'POST' && isJson) {
    const text = await readBody(request, maxBytes);
    if (text.trim()) {
      try {
        body = JSON.parse(text);
      } catch {
        throw new HttpError(400, '잘못된 요청이에요');
      }
    } else body = {};
  } else if (request.body) {
    // 받지 않을 본문도 응답 전에 비운다 (읽지 않은 채 응답하면 런타임이 요청 스트림 오류를 남긴다)
    await readBody(request, BODY_MAX_BYTES).catch(() => {});
  }
  return {
    method: request.method,
    path: url.pathname,
    query: (k) => url.searchParams.get(k) ?? undefined,
    header: (k) => request.headers.get(k) ?? undefined,
    body,
    isJson,
    ip: request.headers.get('cf-connecting-ip') || '',
    secure: url.protocol === 'https:',
    isLocal: false, // 클라우드에는 x-admin-key 가 없다 (관리자는 로그인 쿠키로만)
  };
}

/** src/api.js 응답 → Response */
export function toResponse(out) {
  const h = new Headers({ 'cache-control': 'no-store' });
  for (const [k, v] of Object.entries(out.headers || {})) h.set(k, v);
  for (const c of out.cookies || []) h.append('set-cookie', c);
  if (out.body === null || out.body === undefined) return new Response(null, { status: out.status, headers: h });
  h.set('content-type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(out.body), { status: out.status, headers: h });
}
