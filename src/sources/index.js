// 소스 레지스트리: 쓸 어댑터를 아래에 정적으로 import 한다 (Cloudflare Workers 번들에는 폴더를 읽을 파일 시스템이 없다).
// 새 소스는 `src/sources/<id>.js` 를 만들고 여기에 두 줄(import, ADAPTERS)을 추가한다. `_` 로 시작하는 파일은 규약·예시용이라 넣지 않는다.
// (test/worker.test.js 가 폴더의 파일과 이 목록이 같은지 확인한다)
import blind from './blind.js';
import bobaedream from './bobaedream.js';
import dcinside from './dcinside.js';
import dogdrip from './dogdrip.js';
import etoland from './etoland.js';
import fmkorea from './fmkorea.js';
import humoruniv from './humoruniv.js';
import inven from './inven.js';
import ppomppu from './ppomppu.js';
import quasarzone from './quasarzone.js';
import todayhumor from './todayhumor.js';
import ygosu from './ygosu.js';

/** 파일 이름 순 (예전 폴더 읽기와 같은 순서) */
const ADAPTERS = [blind, bobaedream, dcinside, dogdrip, etoland, fmkorea, humoruniv, inven, ppomppu, quasarzone, todayhumor, ygosu];

/** 규약에 맞지 않아 뺀 어댑터: { <id 또는 순번>: 사유 } */
export const loadErrors = {};

const valid = ADAPTERS.filter((s, i) => {
  const ok = s && typeof s.id === 'string' && typeof s.list === 'function' && typeof s.read === 'function';
  if (!ok) {
    loadErrors[s?.id || `#${i}`] = 'list/read 가 없는 어댑터';
    console.error(`[sources] ${s?.id || `#${i}`} 어댑터가 규약에 맞지 않아 뺐어요`);
  }
  return ok;
});
const loaded = Promise.resolve(valid);

/** @returns {Promise<Array<any>>} 모든 어댑터 (비활성 포함), 파일 이름 순 */
export function loadSources() {
  return loaded;
}

export async function getSource(id) {
  return valid.find((s) => s.id === id) || null;
}
