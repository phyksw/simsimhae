// Cloudflare Workers 실행 환경 (wrangler 번들에서 "#platform" 이 이 파일로 풀린다 — package.json "imports").
// 파일 시스템이 없다: 저장소·금지어·비밀은 worker/site.js(SiteDO)가 configure(env)·setBackend 로 넣어 준다.
export const kind = 'cloud';
export const ROOT = null;
export const DATA_DIR = null;
export const secrets = null;
/** nodejs_compat 에서는 Worker 변수·비밀이 process.env 에도 들어온다. 실제 값은 SiteDO 가 configure(env) 로 다시 넣는다. */
export const env = globalThis.process?.env ?? {};
export const storeBackend = () => null;
export const rulesBackend = () => null;
export const filterCodeParts = () => null;
export const onExit = () => {};
