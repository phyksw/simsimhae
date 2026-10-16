// Cloudflare Worker 진입점 (wrangler.jsonc 의 main). 설계: worker/CLOUD.md
//   - 화면 파일(public/)은 ASSETS 가 Worker 를 거치지 않고 바로 낸다 (run_worker_first: /api/*)
//   - /api/img: 이미지 프록시. 상태가 없어 Worker 에서 바로 (출처별 허용 호스트·Referer 는 src/sources 어댑터에서)
//   - 그 밖의 /api/*: Durable Object SiteDO('main') — 수집·판정·관리자·목록 (src/server.js 와 같은 API)
//   - cron(*/5): SiteDO 의 알람이 살아 있는지 확인하고 없으면 다시 건다
// 비밀(Worker secrets): ADMIN_PASSWORD, ADULT_PASSWORD, SESSION_SECRET, (선택) ANTHROPIC_API_KEY. 바인딩: SITE(DO), ASSETS.
// 예전 공개 사이트의 D1 바인딩(DB)이 남아 있어도 쓰지 않는다.
import { SiteDO } from './site.js';
import { getSource } from '../src/sources/index.js';
import { config } from '../src/config.js';
import { COOKIE_ADMIN } from '../src/api.js';
import { proxyImage, RateWindow } from './img.js';
import { json, withSecurityHeaders } from './http.js';

export { SiteDO };

const IMPORT_PATH = '/api/admin/import';
/** Cookie 헤더에 관리자 쿠키가 있는지만 본다 (서명 확인은 SiteDO 가) */
const ADMIN_COOKIE_RE = new RegExp(`(?:^|;)\\s*${COOKIE_ADMIN}=[^;\\s]`);

/** 사이트 상태를 가진 Durable Object 하나 (이름 'main') */
export const siteStub = (env) => env.SITE.get(env.SITE.idFromName('main'));

/**
 * Worker 만들기. 시험에서는 원본 요청(fetch)·시계·이미지 크기 한도를 바꿔 끼운다.
 * @param {{fetch?: typeof fetch, now?: () => number, imgMaxBytes?: number}} [opts]
 */
export function createWorker(opts = {}) {
  const now = opts.now ?? (() => Date.now());
  const upstream = opts.fetch ?? ((input, init) => fetch(input, init));
  // 이미지 프록시 요청 수 제한: 접속자당 분당 IMG_RATE_PER_MIN(기본 600) — isolate 마다 따로 센다
  const imgRate = new RateWindow(config.imgProxy.perMin, 60e3);

  async function route(request, env, ctx) {
    const url = new URL(request.url);
    // run_worker_first 가 /api/* 만이라 보통은 오지 않지만, 혹시 오면 정적 파일로 넘긴다
    if (!url.pathname.startsWith('/api/')) return env.ASSETS ? env.ASSETS.fetch(request) : json({ error: 'not found' }, 404);
    if (url.pathname === '/api/img' && (request.method === 'GET' || request.method === 'HEAD')) {
      const src = await getSource(url.searchParams.get('s') || '');
      // 응답 크기 한도는 로컬 서버와 같은 설정(IMG_MAX_BYTES)
      return proxyImage({ request, url, src, ctx, upstream, limiter: imgRate, now: now(), maxBytes: opts.imgMaxBytes ?? config.imgProxy.maxBytes });
    }
    // 옮기기(큰 본문)는 관리자 쿠키가 아예 없으면 DO 로 넘기지 않고 여기서 끊는다 (본문은 읽지 않고 버림).
    // 쿠키가 진짜인지는 SiteDO 가 본문을 읽기 전에 다시 확인한다 (worker/site.js handle).
    if (request.method === 'POST' && url.pathname === IMPORT_PATH && !ADMIN_COOKIE_RE.test(request.headers.get('cookie') || '')) {
      await request.body?.cancel().catch(() => {});
      return json({ error: '관리자 로그인이 필요해요' }, 401);
    }
    if (!env.SITE) return json({ error: '지금은 사용할 수 없어요' }, 503);
    return siteStub(env).fetch(request);
  }

  return {
    async fetch(request, env, ctx) {
      let res;
      try {
        res = await route(request, env || {}, ctx);
      } catch (e) {
        console.error('[worker]', e?.stack || e);
        res = json({ error: '서버 오류가 났어요' }, 500);
      }
      return withSecurityHeaders(res);
    },
    /** cron: SiteDO 알람 확인 (DO 가 메모리에서 내려가 있어도 깨워서 알람을 다시 건다) */
    async scheduled(controller, env, ctx) {
      if (!env?.SITE) return;
      const job = siteStub(env)
        .ensureAlarm()
        .catch((e) => console.error(`[cron] 알람 확인 실패: ${e?.message || e}`));
      if (ctx?.waitUntil) ctx.waitUntil(job);
      else await job;
    },
  };
}

export default createWorker();
