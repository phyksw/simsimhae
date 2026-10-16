// 공용 HTTP 도우미: 브라우저 UA, 호스트별 요청 간격 제한, 간단한 쿠키 저장, 문자셋 자동 디코딩, 재시도.
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

// ---- 호스트별 요청 간격 제한 (같은 사이트에 연달아 요청하지 않도록) ----
const hostQueues = new Map(); // host -> Promise (직전 요청 슬롯)
const lastHitAt = new Map(); // host -> ms

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function throttle(host, interval) {
  const prev = hostQueues.get(host) || Promise.resolve();
  const slot = prev.then(async () => {
    const wait = (lastHitAt.get(host) || 0) + interval - Date.now();
    if (wait > 0) await sleep(wait);
    lastHitAt.set(host, Date.now());
  });
  hostQueues.set(host, slot.catch(() => {}));
  return slot;
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

/**
 * 원본 Response 를 반환한다 (스트리밍용: 이미지 프록시 등). 상태 코드 검사는 호출 측 책임.
 * @param {string} url
 * @param {{referer?: string, headers?: Record<string,string>, timeout?: number, throttle?: boolean,
 *          interval?: number, method?: string, body?: any, redirect?: RequestRedirect, signal?: AbortSignal}} [opts]
 */
export async function fetchRaw(url, opts = {}) {
  const u = new URL(url);
  if (opts.throttle !== false) await throttle(u.host, opts.interval ?? MIN_INTERVAL_MS);
  const headers = {
    'user-agent': USER_AGENT,
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'accept-language': 'ko-KR,ko;q=0.9,en-US;q=0.6,en;q=0.5',
    ...opts.headers,
  };
  if (opts.referer) headers.referer = opts.referer;
  const ck = cookieHeader(u.host);
  if (ck && !headers.cookie) headers.cookie = ck;

  // timeout: 0 이면 전체 시간 제한 없음 (큰 이미지·영상 스트리밍용 — 호출 측이 signal 로 직접 제한)
  const timeoutMs = opts.timeout ?? DEFAULT_TIMEOUT_MS;
  const timeoutSignal = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : null;
  const signal = opts.signal && timeoutSignal ? AbortSignal.any([opts.signal, timeoutSignal]) : opts.signal || timeoutSignal || undefined;
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
          await sleep(1500 * (attempt + 1));
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
