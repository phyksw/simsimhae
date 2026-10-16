// Claude 검수를 이 컴퓨터에서 (API 키 없이 Claude Code 등으로): 검수 대기 글을 받아 오고, 판정을 올린다.
// 클라우드에는 x-admin-key 가 없어서 관리자 비밀번호로 로그인해서 부른다 (로컬 서버 http://127.0.0.1:3000 에도 그대로 된다).
// 클라우드에 Worker 비밀 ANTHROPIC_API_KEY 를 넣었다면 수집할 때 자동으로 판정하므로 이 스크립트는 필요 없다.
//
// 사용법:
//   node scripts/cloud-review.js <사이트 주소> queue [--limit 300] [--vibe] [--out queue.json]
//       판정이 아직 없는 최근 7일 글 (--vibe: 판정은 정상인데 "썰·대화" 점수가 없는 글). --out 이 없으면 화면(stdout)에 JSON.
//   node scripts/cloud-review.js <사이트 주소> apply <판정.json>
//       판정 파일: {"model": "claude-code 검수", "items": [{"id": "...", "verdict": "ok|politics|hate|dark|adult|not_humor",
//                  "shortsScore": 0~100, "reason": "짧은 사유", "vibe": 0~100(선택)}]}
//                  (판정 없이 {"id", "vibe"} 만 넣으면 썰·대화 점수만 바꾼다)
//   비밀번호: 환경변수 CLOUD_ADMIN_PASSWORD 가 있으면 그것을, 없으면 물어본다 (화면에 보이지 않게).
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { adminSession, askHidden, chunkPosts, siteOrigin } from './push-to-cloud.js';

/** 관리자 요청 본문 상한(64KB)보다 작게 나눠 보낸다 */
const VERDICT_CHUNK_BYTES = 48 * 1024;

/**
 * 검수 대기 글 받기
 * @param {{origin: string, password: string, limit?: number, vibe?: boolean, fetch?: typeof fetch}} o
 * @returns {Promise<{total: number, items: any[]}>}
 */
export async function fetchQueue({ origin, password, limit = 300, vibe = false, fetch: f }) {
  const s = await adminSession({ origin, password, fetch: f });
  try {
    const q = new URLSearchParams({ limit: String(Math.max(1, Math.min(1000, Number(limit) || 300))) });
    if (vibe) q.set('vibe', '1');
    return await s.get(`/api/admin/review-queue?${q}`);
  } finally {
    await s.logout();
  }
}

/**
 * 판정 올리기 (크면 나눠서)
 * @param {{origin: string, password: string, data: {model?: string, items: any[]}, fetch?: typeof fetch, log?: (s: string) => void}} o
 * @returns {Promise<{applied: number, skipped: string[]}>}
 */
export async function applyVerdicts({ origin, password, data, fetch: f, log = () => {} }) {
  const items = Array.isArray(data?.items) ? data.items : Array.isArray(data) ? data : null;
  if (!items) throw new Error('판정 파일에 items 목록이 없어요');
  const model = String(data?.model || 'claude-code 검수').slice(0, 60);
  const s = await adminSession({ origin, password, fetch: f });
  try {
    let applied = 0;
    const skipped = [];
    const parts = chunkPosts(items, VERDICT_CHUNK_BYTES);
    for (const [i, part] of parts.entries()) {
      const r = await s.post('/api/admin/verdicts', { model, items: part });
      applied += Number(r?.applied) || 0;
      skipped.push(...(r?.skipped || []));
      log(`  판정 올리는 중 ${i + 1}/${parts.length}`);
    }
    return { applied, skipped };
  } finally {
    await s.logout();
  }
}

async function main(argv) {
  const args = argv.slice(2);
  const opt = (name) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const plain = args.filter((a, i) => !a.startsWith('--') && !['--limit', '--out'].includes(args[i - 1]));
  const [url, cmd, file] = plain;
  if (!url || !['queue', 'apply'].includes(cmd) || (cmd === 'apply' && !file)) {
    console.error('사용법: node scripts/cloud-review.js <사이트 주소> queue [--limit 300] [--vibe] [--out queue.json]');
    console.error('        node scripts/cloud-review.js <사이트 주소> apply <판정.json>');
    return 2;
  }
  const origin = siteOrigin(url);
  const data = cmd === 'apply' ? JSON.parse(readFileSync(path.resolve(file), 'utf8')) : null;
  const password = process.env.CLOUD_ADMIN_PASSWORD || (await askHidden('관리자 비밀번호: '));
  if (cmd === 'queue') {
    const out = await fetchQueue({ origin, password, limit: opt('limit'), vibe: args.includes('--vibe') });
    const text = JSON.stringify(out, null, 2);
    if (opt('out')) {
      writeFileSync(path.resolve(opt('out')), text);
      console.error(`검수 대기 ${out.total}개 → ${path.resolve(opt('out'))}`);
    } else process.stdout.write(`${text}\n`);
    return 0;
  }
  const r = await applyVerdicts({ origin, password, data, log: (s) => console.error(s) });
  console.error(`판정 반영 ${r.applied}개${r.skipped.length ? `, 건너뜀 ${r.skipped.length}개 (없는 글이거나 판정 값이 틀림)` : ''}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  // process.exit() 대신 exitCode (fetch 연결이 닫히는 중에 끝내면 Windows 의 Node 가 단언 실패로 죽는다)
  main(process.argv).then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      console.error(`실패: ${e.message}`);
      process.exitCode = 1;
    },
  );
}
