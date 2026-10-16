// 한 번만 수집하고 결과를 출력한다 (서버 없이). 사용법: node scripts/crawl-once.js
import * as store from '../src/store.js';
import { crawlAll } from '../src/crawler.js';

store.load();
const s = await crawlAll();
for (const [id, st] of Object.entries(s.sources)) {
  console.log(`${id.padEnd(12)} ${st.ok ? 'OK ' : 'ERR'} 목록 ${String(st.fetched ?? 0).padStart(3)} 새 글 ${String(st.added ?? 0).padStart(3)} ${st.ms ?? '-'}ms ${st.error || ''}`);
}
const posts = store.allPosts();
const by = (s) => posts.filter((p) => p.status === s).length;
console.log(`\n전체 ${posts.length}개 — 공개 ${by('ok')}, 므흣 ${by('adult')}, 걸러짐 ${by('blocked')}, 중복 ${posts.filter((p) => p.dupOf).length}`);
process.exit(0);
