// 로컬(Node) 실행 환경: .env 읽기, data/ 폴더, 비밀 파일(data/secrets.json), 파일 저장소(data/posts.json·custom-rules.json).
// package.json 의 "imports"."#platform" 이 Node 에서는 이 파일을, Workers(wrangler 번들)에서는 ./cloud.js 를 고른다.
// 그래서 공용 모듈(config·store·filter …)은 파일 시스템을 직접 만지지 않고, 이 파일이 넘겨주는 것만 쓴다.
// 이 파일은 node 내장 모듈만 import 한다 (config·store 를 import 하면 순환이 생긴다).
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, copyFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const kind = 'node';
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const envFile = path.join(ROOT, '.env');
if (existsSync(envFile)) {
  try {
    process.loadEnvFile(envFile);
  } catch (e) {
    console.warn(`[config] .env 읽기 실패: ${e.message}`);
  }
}

/** 설정을 읽을 환경변수 (configure 가 읽는다) */
export const env = process.env;

export const DATA_DIR = path.resolve(ROOT, process.env.DATA_DIR || 'data');
mkdirSync(DATA_DIR, { recursive: true });

/** 비밀번호/세션 비밀키: 환경변수가 없을 때 쓰는 data/secrets.json (없으면 무작위로 만들어 둔다) */
function loadSecrets() {
  const file = path.join(DATA_DIR, 'secrets.json');
  let saved = {};
  if (existsSync(file)) {
    try {
      saved = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      saved = {};
    }
  }
  const gen = (n = 6) => randomBytes(n).toString('base64url');
  const next = {
    adultPassword: saved.adultPassword || gen(6),
    adminPassword: saved.adminPassword || gen(9),
    sessionSecret: saved.sessionSecret || randomBytes(32).toString('hex'),
  };
  // 이번 실행에서 새로 만든 값 — 서버는 이때만 비밀번호를 콘솔에 보여주고, 그 뒤로는 파일 위치만 알려준다
  const created = { adult: !saved.adultPassword, admin: !saved.adminPassword };
  if (JSON.stringify(next) !== JSON.stringify(saved)) {
    writeFileSync(file, JSON.stringify(next, null, 2));
  }
  return { ...next, file, created };
}
export const secrets = loadSecrets();

/** 원자적으로 쓰기 (임시 파일 → rename) */
function writeAtomic(file, text) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

/**
 * 글 저장소: data/posts.json 한 파일. 바뀐 부분과 상관없이 통째로 쓴다 (글 수천 개 규모).
 * @returns {{load(): any, save(db: any): void, autosave: boolean}}
 */
export function storeBackend() {
  const file = path.join(DATA_DIR, 'posts.json');
  return {
    autosave: true, // 바뀌면 잠시 뒤(scheduleSave) 저장
    load() {
      if (!existsSync(file)) return null;
      try {
        return JSON.parse(readFileSync(file, 'utf8'));
      } catch (e) {
        // 깨진 파일은 보존하고 새로 시작
        const bad = `${file}.broken-${Date.now()}`;
        try {
          copyFileSync(file, bad);
        } catch {}
        console.error(`[store] posts.json 읽기 실패 (${e.message}) → ${bad} 로 보관하고 새로 시작`);
        return null;
      }
    },
    save(db) {
      writeAtomic(file, JSON.stringify(db));
    },
  };
}

/** 관리자 금지어: data/custom-rules.json */
export function rulesBackend() {
  const file = path.join(DATA_DIR, 'custom-rules.json');
  return {
    load() {
      if (!existsSync(file)) return null;
      try {
        return JSON.parse(readFileSync(file, 'utf8'));
      } catch (e) {
        console.warn(`[filter] custom-rules.json 읽기 실패: ${e.message}`);
        return null;
      }
    },
    save(rules) {
      writeFileSync(file, JSON.stringify(rules, null, 2));
    },
  };
}

/**
 * 판정 규칙 지문에 넣을 코드: 판정 파일의 내용 그대로 (고치면 다음 시작 때 저장된 글을 다시 판정한다).
 * Workers 에는 파일이 없어 cloud.js 는 null 을 돌려주고, filter.js 가 규칙 데이터·판정 함수로 지문을 만든다.
 */
export function filterCodeParts() {
  const out = [];
  for (const f of ['filter.js', 'filter-rules.js']) {
    try {
      out.push(readFileSync(path.join(ROOT, 'src', f)));
    } catch {}
  }
  return out;
}

/**
 * 프로세스를 끝낼 때 밀린 저장을 마친다. 'exit' 이벤트는 처리기 없는 SIGINT(Ctrl+C)/SIGTERM 종료 때는 발생하지 않으므로,
 * 신호를 받으면 저장하고 끝낸다. (Windows 의 작업 관리자·TerminateProcess 같은 강제 종료는 어떤 처리기도 실행되지 않는다)
 * @param {() => void} flush 밀린 변경이 있으면 저장
 */
export function onExit(flush) {
  process.on('exit', () => {
    try {
      flush();
    } catch (e) {
      console.error(`[store] 종료 저장 실패: ${e.message}`);
    }
  });
  let shuttingDown = false;
  const onSignal = (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      flush();
    } catch (e) {
      console.error(`[store] 종료 저장 실패 (${sig}): ${e.message}`);
    }
    process.exit(0);
  };
  // SIGINT = Ctrl+C, SIGTERM = kill·서비스 관리자, SIGBREAK = Windows Ctrl+Break, SIGHUP = Windows 콘솔 창 닫기
  // (다른 OS 의 SIGHUP 은 nohup 실행을 깨지 않도록 건드리지 않는다)
  const sigs = ['SIGINT', 'SIGTERM', ...(process.platform === 'win32' ? ['SIGBREAK', 'SIGHUP'] : [])];
  for (const sig of sigs) {
    try {
      process.on(sig, () => onSignal(sig));
    } catch {}
  }
}
