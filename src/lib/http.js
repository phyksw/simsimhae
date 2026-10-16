// 공용 HTTP 도우미: 브라우저 UA, 호스트별 요청 간격 제한, 간단한 쿠키 저장, 문자셋 자동 디코딩, 재시도.
import { AsyncLocalStorage } from 'node:async_hooks';
import iconv from 'iconv-lite';
import * as cheerio from 'cheerio';

export const USER_AGENT =
  process.env.CRAWL_USER_AGENT ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

const MIN_INTERVAL_MS = Number(process.env.CRAWL_MIN_INTERVAL_MS ?? 1200);
const DEFAULT_TIMEOUT_MS = 15000;

export class HttpError extends Error {
  constructor(status, url, message) {
    super(message || `HTTP ${status} ${url}`);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
  }
}

/** 같은 사이트 대기열이 밀려 있어 기다리지 않고(또는 기다리다) 포기한 요청 — 방문자 미리보기 등 */
export class BusyError extends HttpError {
  constructor(host) {
    super(503, host, `요청이 밀려 있어요 (${host})`);
    this.name = 'BusyError';
    this.busy = true;
  }
}

// ---- 요청의 성격 (수집 목록 / 미리보기) ----
// 출처 어댑터는 fetchHtml 만 부르므로, 누가 부른 요청인지는 호출 범위로 넘긴다:
//   crawler 가 목록을 받을 때 { priority: 'crawl', signal }, reader 가 미리보기를 받을 때 { priority: 'preview', maxWaitMs }.
const scope = new AsyncLocalStorage();

/**
 * fn 안에서 보내는 요청(fetchRaw·fetchText·fetchHtml·fetchJson)에 성격을 붙인다.
 * @template T
 * @param {{priority?: 'crawl'|'normal'|'preview', maxWaitMs?: number, signal?: AbortSignal}} s
 *   - priority: 같은 사이트 대기열에서의 순서. crawl(수집 목록)이 맨 앞, preview(미리보기)가 맨 뒤.
 *   - maxWaitMs: 대기열에서 기다릴 수 있는 최대 시간. 넘을 것 같으면 기다리지 않고 바로, 기다리다 넘으면 그때 BusyError(503).
 *   - signal: 취소되면 대기열 자리를 내놓고 보내던 요청도 끊는다 (재시도하지 않음).
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export function withRequestScope(s, fn) {
  return scope.run({ ...scope.getStore(), ...s }, fn);
}

// ---- 호스트별 요청 간격 제한 (같은 사이트에 연달아 요청하지 않도록) ----
// 호스트마다 대기열 하나. 직전 요청 뒤 interval 이 지나야 다음 요청이 나간다.
// 대기열 안에서는 우선순위(crawl → normal → preview) → 들어온 순서. 간격 자체는 우선순위와 상관없이 늘 지킨다.
const RANK = { crawl: 0, normal: 1, preview: 2 };
const hosts = new Map(); // host -> { last: ms(직전 요청이 나간 시각), queue: Waiter[], timer }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const abortReason = (signal) => signal?.reason ?? new DOMException('요청을 취소했어요', 'AbortError');

function hostState(host) {
  let h = hosts.get(host);
  if (!h) hosts.set(host, (h = { last: 0, queue: [], timer: null }));
  return h;
}

/** 차례가 된 요청을 내보내고, 다음 차례까지 타이머를 건다 */
function pump(h) {
  clearTimeout(h.timer);
  h.timer = null;
  while (h.queue.length) {
    const w = h.queue[0];
    const wait = h.last + w.interval - Date.now();
    if (wait > 0) {
      h.timer = setTimeout(() => pump(h), wait);
      return;
    }
    h.queue.shift();
    h.last = Date.now();
    w.release();
    w.resolve();
  }
}

/**
 * 같은 사이트(host)로 가는 요청의 차례를 기다린다.
 * @param {string} host
 * @param {number} interval 이 요청 앞에 둘 최소 간격(ms)
 * @param {{priority?: string, maxWaitMs?: number, signal?: AbortSignal}} [o]
 */
function throttle(host, interval, { priority, maxWaitMs, signal } = {}) {
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  const h = hostState(host);
  const rank = RANK[priority] ?? RANK.normal;
  const limit = Number.isFinite(maxWaitMs) && maxWaitMs >= 0 ? maxWaitMs : Infinity;
  if (limit !== Infinity) {
    // 지금 대기열로 본 예상 대기: 직전 요청 뒤 남은 간격 + 내 앞(같거나 높은 우선순위) 요청 수 × 간격
    const ahead = h.queue.reduce((n, w) => n + (w.rank <= rank ? 1 : 0), 0);
    const expected = Math.max(0, h.last + interval - Date.now()) + ahead * interval;
    if (expected > limit) return Promise.reject(new BusyError(host));
  }
  return new Promise((resolve, reject) => {
    let deadline = null;
    const onAbort = () => drop(abortReason(signal));
    const w = {
      rank,
      interval,
      resolve,
      release() {
        clearTimeout(deadline);
        signal?.removeEventListener('abort', onAbort);
      },
    };
    // 대기열에서 빠진다 (취소·시간 초과). 맨 앞이 빠졌으면 다음 차례를 다시 계산한다.
    const drop = (err) => {
      const i = h.queue.indexOf(w);
      if (i < 0) return;
      h.queue.splice(i, 1);
      w.release();
      reject(err);
      if (i === 0) pump(h);
    };
    // 뒤에 들어온 높은 우선순위 요청에 밀려 상한을 넘기면 그때 포기한다
    if (limit !== Infinity) deadline = setTimeout(() => drop(new BusyError(host)), limit);
    signal?.addEventListener('abort', onAbort, { once: true });
    let i = h.queue.length;
    while (i > 0 && h.queue[i - 1].rank > rank) i--;
    h.queue.splice(i, 0, w);
    pump(h);
  });
}

/** 이 요청을 그만둬야 하는지 (재시도하지 않는다): 대기열이 밀려 포기했거나, 부른 쪽이 취소했다 */
function giveUp(err, opts) {
  return !!(err?.busy || opts.signal?.aborted || scope.getStore()?.signal?.aborted);
}

// ---- 아주 단순한 쿠키 저장소 (호스트의 등록 도메인 단위) ----
const cookieJar = new Map(); // baseDomain -> Map(name -> value)

function baseDomain(host) {
  const parts = host.split('.');
  // co.kr / or.kr 같은 2단계 국가 도메인 처리
  if (parts.length >= 3 && parts[parts.length - 1] === 'kr' && parts[parts.length - 2].length <= 3) {
    return parts.slice(-3).join('.');
  }
  return parts.slice(-2).join('.');
}

function storeCookies(host, res) {
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  if (!list.length) return;
  const key = baseDomain(host);
  const jar = cookieJar.get(key) || new Map();
  for (const line of list) {
    const [pair] = line.split(';');
    const idx = pair.indexOf('=');
    if (idx <= 0) continue;
    const name = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (/max-age=0/i.test(line) || value === 'deleted') jar.delete(name);
    else jar.set(name, value);
  }
  cookieJar.set(key, jar);
}

function cookieHeader(host) {
  const jar = cookieJar.get(baseDomain(host));
  if (!jar || jar.size === 0) return null;
  return [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
}

export function setCookie(host, name, value) {
  const key = baseDomain(host);
  const jar = cookieJar.get(key) || new Map();
  jar.set(name, value);
  cookieJar.set(key, jar);
}

// ---- 요청 ----

// 지금까지 보낸 요청 수 (클라우드 알람이 한 번에 보내는 하위 요청 수를 Workers 한도 아래로 지키려고 센다)
let requestTotal = 0;
/** 이 isolate 에서 지금까지 보낸 요청 수 (차이로 쓴다) */
export const requestCount = () => requestTotal;

/**
 * 원본 Response 를 반환한다 (스트리밍용: 이미지 프록시 등). 상태 코드 검사는 호출 측 책임.
 * @param {string} url
 * @param {{referer?: string, headers?: Record<string,string>, timeout?: number, throttle?: boolean,
 *          interval?: number, method?: string, body?: any, redirect?: RequestRedirect, signal?: AbortSignal,
 *          priority?: 'crawl'|'normal'|'preview', maxWaitMs?: number}} [opts]
 *   priority·maxWaitMs 를 주지 않으면 withRequestScope 로 정한 값을 쓴다.
 */
export async function fetchRaw(url, opts = {}) {
  const u = new URL(url);
  const sc = scope.getStore() || {};
  const outer = [opts.signal, sc.signal].filter(Boolean);
  const cancel = outer.length > 1 ? AbortSignal.any(outer) : outer[0];
  if (opts.throttle !== false) {
    await throttle(u.host, opts.interval ?? MIN_INTERVAL_MS, { priority: opts.priority ?? sc.priority, maxWaitMs: opts.maxWaitMs ?? sc.maxWaitMs, signal: cancel });
  }
  const headers = {
    'user-agent': USER_AGENT,
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'accept-language': 'ko-KR,ko;q=0.9,en-US;q=0.6,en;q=0.5',
    ...opts.headers,
  };
  if (opts.referer) headers.referer = opts.referer;
  const ck = cookieHeader(u.host);
  if (ck && !headers.cookie) headers.cookie = ck;
  requestTotal++;

  // timeout: 0 이면 전체 시간 제한 없음 (큰 이미지·영상 스트리밍용 — 호출 측이 signal 로 직접 제한)
  const timeoutMs = opts.timeout ?? DEFAULT_TIMEOUT_MS;
  const timeoutSignal = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : null;
  const signal = cancel && timeoutSignal ? AbortSignal.any([cancel, timeoutSignal]) : cancel || timeoutSignal || undefined;
  const res = await fetch(u, {
    method: opts.method || 'GET',
    headers,
    body: opts.body,
    redirect: opts.redirect || 'follow',
    signal,
  });
  storeCookies(u.host, res);
  return res;
}

function detectCharset(contentType, bytes) {
  const m = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType || '');
  if (m) return m[1].toLowerCase();
  const head = bytes.subarray(0, 4096).toString('latin1');
  const meta = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head);
  if (meta) return meta[1].toLowerCase();
  return 'utf-8';
}

/**
 * HTML/텍스트를 받아 올바른 문자셋으로 디코딩한다. 5xx/429/네트워크 오류는 재시도한다.
 * @param {string} url
 * @param {{encoding?: string, retries?: number} & Parameters<typeof fetchRaw>[1]} [opts]
 * @returns {Promise<{text: string, status: number, url: string, headers: Headers}>}
 */
export async function fetchText(url, opts = {}) {
  const retries = opts.retries ?? 2;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetchRaw(url, opts);
      if (!res.ok) {
        // 본문은 버리고 상태만 보고
        await res.arrayBuffer().catch(() => {});
        const err = new HttpError(res.status, url);
        if (res.status === 429 || res.status >= 500) {
          lastErr = err;
          if (attempt < retries) await sleep(1500 * (attempt + 1));
          continue;
        }
        throw err;
      }
      const bytes = Buffer.from(await res.arrayBuffer());
      const charset = (opts.encoding || detectCharset(res.headers.get('content-type'), bytes)).toLowerCase();
      const text =
        charset === 'utf-8' || charset === 'utf8' ? bytes.toString('utf8') : iconv.decode(bytes, charset);
      return { text, status: res.status, url: res.url || url, headers: res.headers };
    } catch (err) {
      // 대기열이 밀려 포기했거나 부른 쪽이 취소했으면 다시 시도하지 않는다
      if (giveUp(err, opts)) throw err;
      if (err instanceof HttpError && !(err.status === 429 || err.status >= 500)) throw err;
      lastErr = err;
      if (attempt < retries) await sleep(1500 * (attempt + 1));
    }
  }
  throw lastErr;
}

/**
 * HTML 을 받아 cheerio 로 로드한다.
 * @returns {Promise<{$: import('cheerio').CheerioAPI, text: string, url: string, status: number}>}
 */
export async function fetchHtml(url, opts = {}) {
  const r = await fetchText(url, opts);
  return { $: cheerio.load(r.text), text: r.text, url: r.url, status: r.status };
}

/** JSON API 용 */
export async function fetchJson(url, opts = {}) {
  const r = await fetchText(url, {
    ...opts,
    headers: { accept: 'application/json, text/javascript, */*; q=0.01', ...opts.headers },
  });
  return JSON.parse(r.text);
}
