// 웹 서버(로컬): 사이트 API(src/api.js — 클라우드 SiteDO 와 같은 핸들러), 이미지 프록시, 실시간 알림(SSE), 공개 사이트 업로드, 정적 파일.
import express from 'express';
import path from 'node:path';
import { Readable } from 'node:stream';
import { config, ROOT } from './config.js';
import * as store from './store.js';
import { isPublic } from './store.js';
import { getSource } from './sources/index.js';
import { crawlNow, events, isRunning, startScheduler } from './crawler.js';
import { fetchRaw } from './lib/http.js';
import { hostMatches } from './lib/util.js';
import { boardPosts } from './boards.js';
import { createApi, clientKeyOf } from './api.js';
import { rejudgeIfRulesChanged } from './rejudge.js';
import { publishNow, publishStatus, schedulePublish, startPublisher, publishEvents } from './publish.js';

store.load();
const app = express();
app.disable('x-powered-by');

/** TRUST_PROXY 값 → express 'trust proxy' 값 (숫자 = 앞단 프록시 개수, true/false, 또는 주소·대역 목록) */
function trustProxyValue(v) {
  const s = String(v ?? '').trim();
  if (/^\d+$/.test(s)) return Number(s);
  if (s === 'true' || s === 'false') return s === 'true';
  return s.split(',').map((x) => x.trim()).filter(Boolean);
}
app.set('trust proxy', trustProxyValue(config.trustProxy));

/** async 핸들러의 예외를 express 오류 처리로 넘긴다 (express 4 는 async 핸들러의 promise 를 보지 않아 프로세스가 죽는다) */
const wrap = (fn) => (req, res, next) => Promise.resolve().then(() => fn(req, res, next)).catch(next);

// ---------- 보안 헤더 ----------
app.use((req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    [
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
    ].join('; '),
  );
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});
app.use(express.json({ limit: '64kb' }));

function isLocal(req) {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.ip);
}
/** 요청 수 제한용 접속자 키: IPv4 는 그대로, IPv6 는 /64 대역으로 묶는다 */
const clientKey = (req) => clientKeyOf(req.ip);

// 외부에 열어 둔 서버인데 모든 접속이 루프백(프록시)에서 온 것으로 보이면, 시도 제한이 모든 방문자에게 공유된다
let proxyWarned = false;
function warnProxyOnce(req) {
  if (proxyWarned || ['127.0.0.1', '::1', 'localhost'].includes(config.host)) return;
  if (req.isLocal && !req.header('x-forwarded-for')) {
    proxyWarned = true;
    console.warn(
      '[보안] 루프백에서 X-Forwarded-For 없이 들어온 로그인 시도가 있어요. 리버스 프록시 뒤라면 X-Forwarded-For 를 넘기도록 설정하세요 ' +
        '(프록시가 다른 주소에 있으면 TRUST_PROXY 에 그 주소를). 그렇지 않으면 모든 방문자가 같은 IP 로 보여 시도 제한을 함께 씁니다.',
    );
  }
}

// ---------- 사이트 API (src/api.js) ----------
const api = createApi({
  crawlNow() {
    const already = isRunning();
    crawlNow().catch((e) => console.error(`[crawl] 수동 수집 실패: ${e.message}`));
    return { started: !already, running: true };
  },
  onChange: () => schedulePublish(), // 공개 사이트에서도 곧 빠지거나 옮겨지게
  publish: { status: publishStatus, now: publishNow },
  warnProxy: warnProxyOnce,
});

/** express 요청 → API 요청 */
function apiRequest(req) {
  const one = (v) => (Array.isArray(v) ? one(v[0]) : typeof v === 'string' ? v : undefined);
  return {
    method: req.method,
    path: req.path,
    query: (k) => one(req.query[k]),
    header: (k) => one(req.headers[k]),
    body: req.body,
    isJson: !!req.is('application/json'),
    ip: req.ip,
    secure: req.secure,
    isLocal: isLocal(req),
  };
}
const isAdmin = (req) => api.isAdmin(apiRequest(req));

// 게시판 소속·정렬 기준은 boards.js (예전 이름 호환)
export { PICK_MIN, STORY_VIBE_MIN } from './boards.js';

// ---------- 실시간 알림 (Server-Sent Events) ----------
const clients = new Set();
app.get('/api/events', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write('retry: 5000\n\n');
  // 관리자 여부는 연결할 때의 쿠키로 정해진다 — 로그인·로그아웃 뒤에는 화면이 EventSource 를 다시 연결해야 한다
  const c = { res, admin: isAdmin(req) };
  clients.add(c);
  req.on('close', () => clients.delete(c));
});
function broadcast(event, data, adminOnly = false) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) if (!adminOnly || c.admin) c.res.write(msg);
}
events.on('crawl', ({ freshIds = [], ...d }) => {
  // 공개 게시판별로 이번에 새로 보이게 된 글 수 (목록 API 와 같은 기준). 므흣·관리자 게시판 수는 모두에게 가는 이벤트라 넣지 않는다.
  const fresh = new Set(freshIds);
  const posts = store.allPosts();
  const freshIn = (board) => boardPosts(board, {}, posts).filter((p) => fresh.has(p.id)).length;
  const bySource = {};
  for (const p of posts) bySource[p.source] ??= 0;
  for (const p of posts) if (fresh.has(p.id) && isPublic(p)) bySource[p.source]++;
  broadcast('crawl', { ...d, counts: { all: freshIn('all'), pick: freshIn('pick'), story: freshIn('story'), bySource } });
});
events.on('state', (s) => {
  broadcast('live', { live: s.live, lastCrawlAt: s.lastCrawlAt });
  broadcast('state', s, true);
});
// 공개 사이트 업로드 시작·끝 (관리자 바의 반영 상태)
publishEvents.on('state', (s) => broadcast('publish', s, true));
setInterval(() => {
  for (const c of clients) c.res.write(': ping\n\n');
}, 25e3).unref();

// ---------- 이미지/영상 프록시 (핫링크 차단 사이트용, 소스별 허용 호스트만) ----------

/** 파일 앞부분으로 이미지/영상 형식 판별. SVG·HTML 등 스크립트를 품을 수 있는 형식은 null. */
function sniffMedia(b) {
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG') return 'image/png';
  if (b.toString('latin1', 0, 4) === 'GIF8') return 'image/gif';
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (b.toString('latin1', 0, 2) === 'BM') return 'image/bmp';
  if (b.toString('latin1', 4, 8) === 'ftyp') {
    const brand = b.toString('latin1', 8, 12);
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
    if (brand === 'heic' || brand === 'heix' || brand === 'mif1') return 'image/heic';
    if (brand.startsWith('qt')) return 'video/quicktime';
    return 'video/mp4';
  }
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'video/webm';
  if (b.toString('latin1', 0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return 'audio/mpeg';
  return null;
}

// 남용 방지: 접속자당 분당 요청 수, 동시 연결 수(전체·접속자당), 응답 크기 상한
const imgRate = new Map(); // clientKey -> {n, resetAt}
const imgActive = new Map(); // clientKey -> 지금 열려 있는 연결 수
let imgActiveTotal = 0;
setInterval(() => {
  const now = Date.now();
  for (const [k, r] of imgRate) if (r.resetAt <= now) imgRate.delete(k);
}, 60e3).unref();

app.get(
  '/api/img',
  wrap(async (req, res) => {
    const lim = config.imgProxy;
    const key = clientKey(req);
    const now = Date.now();
    let rate = imgRate.get(key);
    if (!rate || rate.resetAt <= now) imgRate.set(key, (rate = { n: 0, resetAt: now + 60e3 }));
    if (++rate.n > lim.perMin) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((rate.resetAt - now) / 1000))));
      return res.status(429).end();
    }
    if (imgActiveTotal >= lim.maxConcurrent || (imgActive.get(key) || 0) >= lim.maxConcurrentPerIp) {
      res.setHeader('Retry-After', '1');
      return res.status(429).end();
    }
    imgActiveTotal++;
    imgActive.set(key, (imgActive.get(key) || 0) + 1);
    let released = false;
    const ac = new AbortController();
    let stream = null;
    // 응답이 끝나거나 클라이언트가 끊으면 자리를 돌려주고, 끊긴 경우엔 원본 다운로드도 바로 멈춘다 (fetch 전에 건다)
    res.on('close', () => {
      if (!released) {
        released = true;
        imgActiveTotal--;
        const n = (imgActive.get(key) || 1) - 1;
        if (n > 0) imgActive.set(key, n);
        else imgActive.delete(key);
      }
      if (!res.writableFinished) {
        ac.abort();
        stream?.destroy();
      }
    });

    const src = await getSource(String(req.query.s || ''));
    let u;
    try {
      u = new URL(String(req.query.u || ''));
    } catch {
      return res.status(400).end();
    }
    if (!src || !/^https?:$/.test(u.protocol) || !hostMatches(u.hostname, src.imageHosts)) return res.status(403).end();
    try {
      const headers = { accept: 'image/avif,image/webp,image/apng,image/*,video/*,*/*;q=0.8' };
      if (req.headers.range) headers.range = req.headers.range;
      // 리다이렉트는 직접 따라가며 매번 허용 호스트인지 확인 (허용 호스트가 내부 주소로 돌려보내는 SSRF 방지)
      // 시간 제한: 전체 시간이 아니라 "응답이 시작될 때까지 20초" + "데이터가 30초 동안 안 오면" 만 끊는다.
      // (전체 시간으로 끊으면 큰 움짤·영상이 받는 도중 잘려서 이미지 위쪽만 보이는 문제가 생긴다)
      let idleTimer = setTimeout(() => ac.abort(), 20000);
      const bumpIdle = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => ac.abort(), 30000);
      };
      res.on('close', () => clearTimeout(idleTimer));
      let up;
      for (let hop = 0; ; hop++) {
        up = await fetchRaw(u.toString(), { referer: src.referer, headers, throttle: false, timeout: 0, redirect: 'manual', signal: ac.signal });
        const loc = up.status >= 300 && up.status < 400 ? up.headers.get('location') : null;
        if (!loc) break;
        await up.body?.cancel().catch(() => {});
        if (hop >= 3) return res.status(508).end();
        u = new URL(loc, u);
        if (!/^https?:$/.test(u.protocol) || !hostMatches(u.hostname, src.imageHosts)) return res.status(403).end();
      }
      const ct = up.headers.get('content-type') || '';
      if (!(up.ok || up.status === 206) || !/^(image|video|audio)\/|^application\/octet-stream/.test(ct)) {
        await up.body?.cancel().catch(() => {});
        return res.status(up.ok ? 415 : up.status === 404 ? 404 : 502).end();
      }
      const declared = Number(up.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > lim.maxBytes) {
        await up.body?.cancel().catch(() => {});
        return res.status(413).end();
      }
      // 앞부분 바이트로 실제 형식을 확인한다 (디시처럼 octet-stream 으로 주는 곳, 이미지인 척하는 SVG/HTML 차단)
      bumpIdle();
      const reader = up.body?.getReader();
      const first = reader ? await reader.read() : { done: true };
      const head = first.value ? Buffer.from(first.value) : Buffer.alloc(0);
      let type = sniffMedia(head);
      // 영상의 중간 구간(Range) 요청은 앞부분이 없어 판별할 수 없으니 원래 형식(또는 octet-stream)으로 넘긴다
      if (!type && up.status === 206 && !/^bytes 0-/.test(up.headers.get('content-range') || '')) {
        type = /^(video|audio)\//.test(ct) ? ct.split(';')[0] : 'application/octet-stream';
      }
      if (!type) {
        await reader?.cancel().catch(() => {});
        return res.status(415).end();
      }
      res.status(up.status);
      res.setHeader('Content-Type', type);
      for (const h of ['content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag']) {
        const v = up.headers.get(h);
        if (v) res.setHeader(h, v);
      }
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
      let sent = 0;
      stream = Readable.from(
        (async function* () {
          if (head.length) {
            sent += head.length;
            yield head;
          }
          if (first.done) return;
          for (;;) {
            bumpIdle();
            const { done, value } = await reader.read();
            if (done) {
              clearTimeout(idleTimer);
              return;
            }
            sent += value.byteLength;
            // content-length 가 없거나 거짓인 응답도 상한에서 끊는다
            if (sent > lim.maxBytes) throw new Error('응답이 너무 큼');
            yield Buffer.from(value);
          }
        })(),
      );
      stream.on('error', () => {
        ac.abort();
        reader?.cancel().catch(() => {});
        res.destroy();
      });
      stream.pipe(res);
    } catch {
      if (!res.headersSent && !res.destroyed) res.status(504).end();
    }
  }),
);

// 나머지 /api/* 는 공용 핸들러로 (없는 경로면 아래 404)
app.use(
  wrap(async (req, res, next) => {
    if (!req.path.startsWith('/api/')) return next();
    const out = await api.handle(apiRequest(req));
    if (!out) return next();
    for (const [k, v] of Object.entries(out.headers || {})) res.setHeader(k, v);
    for (const c of out.cookies || []) res.append('Set-Cookie', c);
    res.status(out.status);
    if (out.body === null || out.body === undefined) res.end();
    else res.json(out.body);
  }),
);

// ---------- 정적 파일 ----------
// public/_headers 는 Cloudflare(공개 사이트) 설정 파일이라 화면 파일이 아니다 (공개 사이트에서도 내려가지 않음)
app.use('/_headers', (req, res) => res.status(404).end());
app.use(express.static(path.join(ROOT, 'public'), { extensions: ['html'], maxAge: '5m' }));
app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));

// ---------- 오류 처리: 스택·경로를 응답에 노출하지 않는다 (잘못된 JSON 400, 너무 큰 본문 413 등은 상태 코드 유지) ----------
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const raw = Number(err?.status || err?.statusCode);
  const status = raw >= 400 && raw < 600 ? raw : 500;
  if (status >= 500) console.error('[server]', err);
  if (res.headersSent) return res.destroy();
  res.status(status).json({ error: status < 500 ? '잘못된 요청이에요' : '서버 오류가 났어요' });
});

// 마지막 안전망: 어디선가 놓친 promise 오류로 서버 전체가 죽지 않게 기록만 한다
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));

// ---------- 시작 ----------
try {
  const changed = await rejudgeIfRulesChanged();
  if (changed !== null && store.allPosts().length) console.log(`[filter] 판정 규칙이 바뀌어 저장된 글을 다시 판정했어요 (상태가 바뀐 글 ${changed}개)`);
} catch (e) {
  console.error(`[filter] 시작 재판정 실패: ${e.message}`);
}

/** 콘솔에 보여줄 비밀번호 줄: 처음 만든 실행에만 값을 보여주고, 그 뒤로는 파일 위치만 */
function passwordLine(fromEnv, envName, created, value) {
  if (fromEnv) return `(${envName} 환경변수)`;
  if (created) return `${value}   ← 방금 새로 만들었어요. 지금 적어 두세요 (다음 실행부터는 화면에 보여주지 않아요)`;
  return `(${config.secretsFile} 에 있어요)`;
}

const server = app.listen(config.port, config.host, () => {
  const port = server.address()?.port ?? config.port;
  console.log(`\n  ${config.siteName} — http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${port}`);
  console.log(`  잠금 게시판 비밀번호: ${passwordLine(config.passwordsFromEnv.adult, 'ADULT_PASSWORD', config.secretsCreated?.adult, config.adultPassword)}`);
  console.log(`  관리자 비밀번호:     ${passwordLine(config.passwordsFromEnv.admin, 'ADMIN_PASSWORD', config.secretsCreated?.admin, config.adminPassword)}`);
  console.log(`  (비밀번호는 ${config.secretsFile} 또는 .env 에서 바꿀 수 있어요. 바꾸고 다시 시작하면 기존 로그인은 풀려요)`);
  console.log(`  Claude 검수: ${config.ai.enabled ? `켜짐 (${config.ai.model})` : '꺼짐 — .env 에 ANTHROPIC_API_KEY 를 넣으면 켜져요'}\n`);
  startScheduler();
  startPublisher(); // 공개 사이트 업로드: 지금 한 번, 그 뒤로는 수집이 끝날 때마다
});
