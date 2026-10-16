// 응답 도우미: JSON 응답, 보안 헤더, 크기 제한이 있는 요청 본문 읽기 (Worker 진입점·SiteDO·이미지 프록시가 같이 쓴다).

/** 로컬 서버(src/server.js)와 같은 페이지 CSP */
export const PAGE_CSP = [
  "default-src 'self'",
  "img-src 'self' data: https:",
  "media-src 'self' https:",
  'frame-src https://www.youtube.com https://www.youtube-nocookie.com https://player.vimeo.com https://streamable.com https://clips.twitch.tv',
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/** 처리 중에 던지면 그 상태 코드와 문구로 JSON 응답이 나간다 */
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** JSON 응답. data 가 문자열이면 이미 직렬화된 JSON 으로 본다. */
export function json(data, status = 200, headers = {}) {
  return new Response(typeof data === 'string' ? data : JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

export const empty = (status, headers = {}) => new Response(null, { status, headers });

function applySecurity(h) {
  // 이미지 프록시처럼 자기 CSP 를 정한 응답은 그대로 둔다
  if (!h.has('content-security-policy')) h.set('content-security-policy', PAGE_CSP);
  h.set('referrer-policy', 'no-referrer');
  h.set('x-content-type-options', 'nosniff');
}

/** 모든 응답에 보안 헤더. fetch·캐시·ASSETS 응답은 헤더를 못 바꾸므로 감싸서 새로 만든다. */
export function withSecurityHeaders(res) {
  try {
    applySecurity(res.headers);
    return res;
  } catch {
    const copy = new Response(res.body, res);
    applySecurity(copy.headers);
    return copy;
  }
}

/**
 * 요청 본문을 글자로 읽는다. limit 바이트를 넘으면 그 자리에서 끊고 413.
 * @param {Request} request
 * @param {number} limit
 */
export async function readBody(request, limit) {
  const declared = request.headers.get('content-length');
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > limit) throw new HttpError(413, '요청이 너무 커요');
  if (!request.body) return '';
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      throw new HttpError(413, '요청이 너무 커요');
    }
    out += decoder.decode(value, { stream: true });
  }
  return out + decoder.decode();
}
