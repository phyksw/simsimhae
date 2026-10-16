// 인증 도우미 (WebCrypto 만 사용): 상수 시간 비교, 므흣 잠금 쿠키 서명·확인, 쿠키 해석, 접속자별 시도·요청 수 제한.

const enc = new TextEncoder();

export const ADULT_COOKIE = 'hg_adult';
export const ADULT_HOURS = 12;

// ---------- 상수 시간 비교 ----------

// 비교용 HMAC 키는 isolate 마다 무작위로 (Workers 는 전역 범위에서 난수를 만들 수 없어 첫 사용 때 만든다)
let cmpKey = null;
function compareKey() {
  cmpKey ??= crypto.subtle.importKey('raw', crypto.getRandomValues(new Uint8Array(32)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return cmpKey;
}

function bytesEqual(x, y) {
  if (x.byteLength !== y.byteLength) return false;
  if (typeof crypto.subtle.timingSafeEqual === 'function') return crypto.subtle.timingSafeEqual(x, y); // Workers 전용
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/**
 * 두 문자열이 같은지 상수 시간으로 비교한다. 길이도 새지 않게 같은 길이의 HMAC 값끼리 비교한다.
 * @returns {Promise<boolean>}
 */
export async function safeEqual(a, b) {
  const key = await compareKey();
  const [x, y] = await Promise.all([
    crypto.subtle.sign('HMAC', key, enc.encode(String(a))),
    crypto.subtle.sign('HMAC', key, enc.encode(String(b))),
  ]);
  return bytesEqual(new Uint8Array(x), new Uint8Array(y));
}

// ---------- base64url ----------

export function toB64url(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** @returns {Uint8Array|null} */
export function fromB64url(s) {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) return null;
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

// ---------- 므흣 잠금 쿠키: adult:<만료ms>.<base64url HMAC-SHA256(SESSION_SECRET, "adult:<만료ms>")> ----------

const hmacKeys = new Map(); // SESSION_SECRET -> Promise<CryptoKey>
function hmacKey(secret) {
  let key = hmacKeys.get(secret);
  if (!key) {
    key = crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
    hmacKeys.clear(); // 비밀은 하나뿐이다 (바뀌면 예전 키는 버린다)
    hmacKeys.set(secret, key);
  }
  return key;
}

/** 쿠키 값 (이름 없이) */
export async function signAdult(secret, now) {
  const value = `adult:${now + ADULT_HOURS * 3600e3}`;
  const mac = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(value));
  return `${value}.${toB64url(mac)}`;
}

export const adultCookieHeader = (token) => `${ADULT_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=${ADULT_HOURS * 3600}`;
export const clearAdultCookieHeader = () => `${ADULT_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=0`;

/** 쿠키 값이 유효한 잠금 해제 표시인지 (서명·만료 확인). 서명 확인은 crypto.subtle.verify 가 상수 시간으로 한다. */
export async function verifyAdult(secret, token, now) {
  if (!secret || typeof token !== 'string' || token.length > 256) return false;
  const i = token.lastIndexOf('.');
  if (i <= 0) return false;
  const value = token.slice(0, i);
  const m = /^adult:(\d{1,16})$/.exec(value);
  if (!m) return false;
  const exp = Number(m[1]);
  // 만료가 지났거나, 발급 기간(12시간)보다 훨씬 먼 만료는 받지 않는다
  if (!(exp > now) || exp > now + (ADULT_HOURS + 1) * 3600e3) return false;
  const sig = fromB64url(token.slice(i + 1));
  if (!sig || sig.length !== 32) return false;
  return crypto.subtle.verify('HMAC', await hmacKey(secret), sig, enc.encode(value));
}

/** Cookie 헤더 해석. 잘못된 %-인코딩이 있어도 예외를 내지 않는다(그 값은 원문 그대로). 같은 이름은 처음 것만. */
export function parseCookies(header) {
  const out = new Map();
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    if (!k || out.has(k)) continue;
    const raw = part.slice(i + 1).trim();
    let v;
    try {
      v = decodeURIComponent(raw);
    } catch {
      v = raw;
    }
    out.set(k, v);
  }
  return out;
}

// ---------- 접속자별 제한 (isolate 메모리 — 전 세계 공용이 아니라 최선 노력) ----------

/** 요청 수 제한용 접속자 키: IPv4 는 그대로, IPv6 는 /64 대역으로 묶는다 */
export function clientKey(request) {
  const ip = String(request.headers.get('cf-connecting-ip') || '').trim();
  if (!ip) return 'unknown';
  if (ip.startsWith('::ffff:') && ip.includes('.')) return ip.slice(7);
  if (!ip.includes(':')) return ip;
  let groups;
  if (ip.includes('::')) {
    const [h, t] = ip.split('::');
    const hs = h ? h.split(':') : [];
    const ts = t ? t.split(':') : [];
    groups = [...hs, ...Array(Math.max(0, 8 - hs.length - ts.length)).fill('0'), ...ts];
  } else groups = ip.split(':');
  return `${groups.slice(0, 4).map((x) => x.toLowerCase().padStart(4, '0')).join(':')}::/64`;
}

/** 틀린 시도만 센다: windowMs 안에 max 번 틀리면 막는다 */
export class FailLimiter {
  constructor(max, windowMs) {
    this.max = max;
    this.windowMs = windowMs;
    this.map = new Map();
  }
  limited(key, now) {
    const a = this.map.get(key);
    return !!a && a.resetAt > now && a.n >= this.max;
  }
  fail(key, now) {
    sweep(this.map, now);
    const a = this.map.get(key);
    if (!a || a.resetAt <= now) this.map.set(key, { n: 1, resetAt: now + this.windowMs });
    else a.n++;
  }
  clear(key) {
    this.map.delete(key);
  }
}

/** 고정 창 요청 수 제한. 넘으면 다시 시도할 수 있을 때까지의 초를, 아니면 0 을 돌려준다. */
export class RateWindow {
  constructor(max, windowMs) {
    this.max = max;
    this.windowMs = windowMs;
    this.map = new Map();
  }
  hit(key, now) {
    sweep(this.map, now);
    let r = this.map.get(key);
    if (!r || r.resetAt <= now) this.map.set(key, (r = { n: 0, resetAt: now + this.windowMs }));
    if (++r.n > this.max) return Math.max(1, Math.ceil((r.resetAt - now) / 1000));
    return 0;
  }
}

function sweep(map, now) {
  if (map.size < 2000) return;
  for (const [k, v] of map) if (v.resetAt <= now) map.delete(k);
}
