// Cloudflare Worker 진입점 — 방문자용 읽기 전용 사이트 (규약: worker/CONTRACT.md, 구현: worker/app.js).
// 비밀(Worker secrets): PUBLISH_TOKEN, ADULT_PASSWORD, SESSION_SECRET. 바인딩: DB(D1), ASSETS(public/).
import { createWorker } from './app.js';

export default createWorker();
