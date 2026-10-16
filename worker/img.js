// 이미지/영상 프록시 (핫링크를 막는 사이트용). 로컬 서버(src/server.js /api/img)와 같은 규칙:
// 스냅샷 sources 의 imageHosts 에 있는 호스트만, 리다이렉트는 직접 따라가며 매번 확인(최대 3번),
// 앞부분 바이트로 이미지/영상 형식 판별(SVG·HTML 거부), Range 통과.
// CPU 를 아끼려고 앞부분만 읽어 판별하고 나머지는 런타임 스트림으로 그대로 흘린다(바이트마다 JS 를 돌지 않음).

import { empty } from './http.js';
import { clientKey } from './auth.js';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
/** 원본이 알려 준 크기가 이보다 크면 413 */
export const IMG_MAX_BYTES = 80 * 1024 * 1024;
/** Cache API 에 넣는 응답의 최대 크기 */
const CACHE_MAX_BYTES = 25 * 1024 * 1024;
/** 원본이 응답을 시작할 때까지 기다리는 시간 */
const START_TIMEOUT_MS = 20000;
const MAX_REDIRECTS = 3;
const SNIFF_BYTES = 32;

/** 호스트가 허용 목록(접미사) 중 하나에 속하는지 (src/lib/util.js 와 같음) */
export function hostMatches(host, suffixes) {
  const h = String(host || '').toLowerCase();
  return (suffixes || []).some((s) => {
    const x = String(s).toLowerCase().replace(/^\./, '');
    return h === x || h.endsWith(`.${x}`);
  });
}

const ascii = (b, i, j) => String.fromCharCode(...b.subarray(i, j));

/** 파일 앞부분으로 이미지/영상 형식 판별 (src/server.js sniffMedia 와 같음). SVG·HTML 등은 null. */
export function sniffMedia(b) {
  if (!b || b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && ascii(b, 1, 4) === 'PNG') return 'image/png';
  if (ascii(b, 0, 4) === 'GIF8') return 'image/gif';
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP') return 'image/webp';
  if (ascii(b, 0, 2) === 'BM') return 'image/bmp';
  if (ascii(b, 4, 8) === 'ftyp') {
    const brand = ascii(b, 8, 12);
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
    if (brand === 'heic' || brand === 'heix' || brand === 'mif1') return 'image/heic';
    if (brand.startsWith('qt')) return 'video/quicktime';
    return 'video/mp4';
  }
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'video/webm';
  if (ascii(b, 0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return 'audio/mpeg';
  return null;
}

/** 허용된 주소인지: http(s), 사용자 정보 없음, 출처의 이미지 호스트 */
function allowedUrl(u, src) {
  return (u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password && hostMatches(u.hostname, src.imageHosts);
}

function concat(a, b) {
  if (!a.length) return b;
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

/**
 * 이미 읽은 앞부분 + 나머지 원본 스트림을 하나의 응답 본문으로. 나머지는 pipeTo 로 런타임이 흘린다.
 * 길이를 알면 FixedLengthStream(Workers)로 Content-Length 를 유지한다.
 */
function passThrough(reader, stream, first, length, ctx) {
  const ts =
    Number.isFinite(length) && length > 0 && typeof FixedLengthStream === 'function'
      ? new FixedLengthStream(length) // eslint-disable-line no-undef
      : typeof IdentityTransformStream === 'function'
        ? new IdentityTransformStream() // eslint-disable-line no-undef
        : new TransformStream();
  const pump = (async () => {
    const w = ts.writable.getWriter();
    await w.write(first);
    w.releaseLock();
    reader.releaseLock();
    await stream.pipeTo(ts.writable);
  })().catch(() => {
    stream.cancel?.().catch?.(() => {});
  });
  ctx?.waitUntil?.(pump);
  return ts.readable;
}

/**
 * GET /api/img?s=<출처 id>&u=<원본 주소>
 * @param {{request: Request, url: URL, head: object|null, ctx?: any, upstream: typeof fetch, limiter: import('./auth.js').RateWindow, now: number}} o
 */
export async function proxyImage({ request, url, head, ctx, upstream, limiter, now }) {
  const wait = limiter.hit(clientKey(request), now);
  if (wait) return empty(429, { 'retry-after': String(wait) });

  const src = head?.sourceMap?.get(url.searchParams.get('s') || '');
  let u;
  try {
    u = new URL(url.searchParams.get('u') || '');
  } catch {
    return empty(400);
  }
  if (!src || !allowedUrl(u, src)) return empty(403);

  const range = request.headers.get('range');
  const okRange = range && range.length <= 200 && /^bytes=[\d\s,-]+$/i.test(range) ? range : null;

  // Cache API: 범위 요청이 아닌 전체 응답만 (workers.dev 주소에서는 Cloudflare 가 캐시를 쓰지 않아 아무 일도 하지 않는다)
  const cache = !okRange && typeof caches !== 'undefined' && caches?.default ? caches.default : null;
  const cacheKey = cache ? new Request(url.toString(), { method: 'GET' }) : null;
  if (cache) {
    try {
      const hit = await cache.match(cacheKey);
      if (hit) return hit;
    } catch {}
  }

  const headers = {
    'user-agent': USER_AGENT,
    accept: 'image/avif,image/webp,image/apng,image/*,video/*,*/*;q=0.8',
    'accept-language': 'ko-KR,ko;q=0.9,en-US;q=0.6,en;q=0.5',
  };
  if (src.referer) headers.referer = src.referer;
  if (okRange) headers.range = okRange;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), START_TIMEOUT_MS);
  try {
    // 리다이렉트는 직접 따라가며 매번 허용 호스트인지 확인 (허용 호스트가 다른 곳으로 돌려보내는 SSRF 방지)
    let up;
    for (let hop = 0; ; hop++) {
      up = await upstream(u.toString(), { method: 'GET', headers, redirect: 'manual', signal: ac.signal });
      const loc = up.status >= 300 && up.status < 400 ? up.headers.get('location') : null;
      if (!loc) break;
      await up.body?.cancel().catch(() => {});
      if (hop >= MAX_REDIRECTS) return empty(508);
      try {
        u = new URL(loc, u);
      } catch {
        return empty(502);
      }
      if (!allowedUrl(u, src)) return empty(403);
    }

    const ct = up.headers.get('content-type') || '';
    if (!(up.ok || up.status === 206) || !/^(image|video|audio)\/|^application\/octet-stream/i.test(ct)) {
      await up.body?.cancel().catch(() => {});
      return empty(up.ok ? 415 : up.status === 404 ? 404 : 502);
    }
    // 압축해서 보낸 응답은 런타임이 풀어 주므로 원본 Content-Length 가 실제 길이와 다르다
    const encoding = (up.headers.get('content-encoding') || '').trim().toLowerCase();
    const encoded = !!encoding && encoding !== 'identity';
    const cl = up.headers.get('content-length');
    const length = !encoded && cl !== null && /^\d+$/.test(cl.trim()) ? Number(cl) : NaN;
    if (length > IMG_MAX_BYTES) {
      await up.body?.cancel().catch(() => {});
      return empty(413);
    }

    // 앞부분 바이트로 실제 형식 확인 (octet-stream 으로 주는 곳, 이미지인 척하는 SVG/HTML 차단)
    const reader = up.body ? up.body.getReader() : null;
    let first = new Uint8Array(0);
    let done = !reader;
    while (!done && first.length < SNIFF_BYTES) {
      const r = await reader.read();
      if (r.done) done = true;
      else if (r.value?.byteLength) first = concat(first, r.value instanceof Uint8Array ? r.value : new Uint8Array(r.value));
    }
    clearTimeout(timer);

    let type = sniffMedia(first);
    // 영상의 중간 구간(Range) 요청은 앞부분이 없어 판별할 수 없으니 원래 형식(또는 octet-stream)으로 넘긴다
    if (!type && up.status === 206 && !/^bytes 0-/.test(up.headers.get('content-range') || '')) {
      type = /^(video|audio)\//i.test(ct) ? ct.split(';')[0].trim().toLowerCase() : 'application/octet-stream';
    }
    if (!type) {
      await reader?.cancel().catch(() => {});
      return empty(415);
    }

    const h = new Headers({
      'content-type': type,
      'cache-control': 'public, max-age=86400',
      'content-security-policy': "default-src 'none'; sandbox",
    });
    for (const name of ['content-range', 'accept-ranges', 'last-modified', 'etag']) {
      const v = up.headers.get(name);
      if (v) h.set(name, v);
    }
    let body;
    if (done) {
      body = first;
      h.set('content-length', String(first.length));
    } else {
      if (Number.isFinite(length)) h.set('content-length', String(length));
      body = passThrough(reader, up.body, first, length, ctx);
    }
    const res = new Response(body, { status: up.status, headers: h });
    if (cache && up.status === 200 && (done ? first.length : length) <= CACHE_MAX_BYTES) {
      try {
        ctx?.waitUntil?.(cache.put(cacheKey, res.clone()).catch(() => {}));
      } catch {}
    }
    return res;
  } catch {
    return empty(504);
  } finally {
    clearTimeout(timer);
  }
}
