// 소스 레지스트리: 이 폴더의 `<id>.js` 파일을 자동으로 불러온다 (`_` 로 시작하는 파일과 index.js 제외).
// 한 파일이 깨져 있어도 나머지 소스는 계속 동작하도록 파일별로 오류를 잡는다.
import { readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));

let cache = null;
export const loadErrors = {};

/** @returns {Promise<Array<any>>} 모든 어댑터 (비활성 포함), 파일 이름 순 */
export function loadSources() {
  if (cache) return cache;
  cache = (async () => {
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.js') && f !== 'index.js' && !f.startsWith('_'))
      .sort();
    const mods = await Promise.all(
      files.map((f) =>
        import(pathToFileURL(path.join(dir, f)).href).catch((e) => {
          loadErrors[f] = e.message;
          console.error(`[sources] ${f} 불러오기 실패: ${e.message}`);
          return null;
        }),
      ),
    );
    return mods.map((m) => m?.default).filter((s) => s && typeof s.list === 'function' && typeof s.read === 'function');
  })();
  return cache;
}

export async function getSource(id) {
  return (await loadSources()).find((s) => s.id === id) || null;
}
