// Claude 검수를 이 컴퓨터에서 (API 키 없이 Claude Code 등으로): 검수 대기 글을 받아 오고, 판정을 올린다.
// 클라우드에는 x-admin-key 가 없어서 관리자 비밀번호로 로그인해서 부른다 (로컬 서버 http://127.0.0.1:3000 에도 그대로 된다).
// 클라우드에 Worker 비밀 ANTHROPIC_API_KEY 를 넣었다면 수집할 때 자동으로 판정하므로 이 스크립트는 필요 없다.
//
// 이미지·안내 파일까지 만들고 막힌 출처 수집도 하는 PC 판정 루틴은 scripts/pc-routine.js (이 파일의 applyVerdicts 를 쓴다).
//
// 사용법:
//   node scripts/cloud-review.js <사이트 주소> queue [--limit 300] [--vibe] [--with-read [--read-top 20]] [--out queue.json]
//       판정이 아직 없는 최근 7일 글, 선별 점수(점수 모델 또는 키워드 점수) 높은 순 (--vibe: 판정은 정상인데 "썰·대화" 점수가 없는 글).
//       --with-read: 상위 글의 본문 앞부분·베스트 댓글·이미지 주소도. --out 이 없으면 화면(stdout)에 JSON.
//   node scripts/cloud-review.js <사이트 주소> apply <판정.json>
//       판정 파일: {"model": "claude-code 검수", "items": [{"id": "...", "verdict": "ok|politics|hate|dark|adult|not_humor",
//                  "shortsScore": 0~100, "reason": "짧은 사유", "vibe": 0~100(선택)}]}
//                  (판정 없이 {"id", "vibe"} 만 넣으면 썰·대화 점수만 바꾼다). 올리기 전에 checkVerdicts 로 검사해 틀린 항목만 뺀다.
//       판정 기준: src/model/STYLE.md §7 (src/ai.js 의 CRITERIA·VIBE_TABLE 과 같은 문장)
//   비밀번호: 환경변수 CLOUD_ADMIN_PASSWORD 가 있으면 그것을, 없으면 물어본다 (화면에 보이지 않게).
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { adminSession, askHidden, chunkPosts, siteOrigin } from './push-to-cloud.js';
import { TOPIC_IDS, cleanTopics } from '../src/topics.js';

/** 관리자 요청 본문 상한(64KB)보다 작게 나눠 보낸다 */
const VERDICT_CHUNK_BYTES = 48 * 1024;

/** 판정 값 (src/ai.js·src/api.js 와 같다) */
export const VERDICTS = ['ok', 'politics', 'hate', 'dark', 'adult', 'not_humor'];
/** reason 은 15자 안팎을 바라지만, 사이트가 60자에서 자르므로 여기서도 60자까지만 */
export const REASON_MAX = 60;

/** 점수 칸 검사: 없으면 undefined, 0~100 숫자면 반올림한 정수, 그 밖(문자열·범위 밖)은 null */
function scoreOf(v) {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100) return null;
  return Math.round(v);
}

/**
 * 판정 파일 검사: 올릴 것과 뺄 것(사유). 잘못된 항목은 그 항목만 빼고 나머지는 올린다.
 *   - id: 빈 문자열이 아닌 문자열. 같은 id 가 또 나오면 처음 것만.
 *   - verdict: VERDICTS 중 하나. 없으면 분위기 점수(vibe)만 바꾸는 항목.
 *   - shortsScore·vibe: 0~100 숫자 (문자열·범위 밖은 뺀다). ok 면 shortsScore 가 있어야 하고, requireVibe 면 vibe 도.
 *     ok 가 아니면 둘 다 0 으로 올린다 (Claude 검수 기준: verdict 가 ok 가 아니면 0).
 *   - reason: 문자열 (없으면 빈 문자열), REASON_MAX 자에서 자른다.
 * @param {any} data 판정 파일 내용 ({model, items} 또는 배열)
 * @param {{requireVibe?: boolean}} [o] requireVibe: ok 판정에 vibe 가 없으면 뺀다 (PC 판정 루틴)
 * @returns {{items: any[], rejected: Array<{id: string|null, why: string}>, model: string}}
 */
export function checkVerdicts(data, { requireVibe = false } = {}) {
  const list = Array.isArray(data?.items) ? data.items : Array.isArray(data) ? data : null;
  if (!list) throw new Error('판정 파일에 items 목록이 없어요');
  const items = [];
  const rejected = [];
  const seen = new Set();
  for (const it of list) {
    const id = typeof it?.id === 'string' ? it.id.trim() : '';
    if (!id) {
      rejected.push({ id: null, why: 'id 없음' });
      continue;
    }
    if (seen.has(id)) {
      rejected.push({ id, why: '같은 id 가 또 나옴 (처음 것만 올림)' });
      continue;
    }
    const vibe = scoreOf(it.vibe);
    if (vibe === null) {
      rejected.push({ id, why: `vibe 는 0~100 숫자여야 함 (${String(it.vibe).slice(0, 20)})` });
      continue;
    }
    // 주제 탭(topics): 알려진 주제 id 목록 (src/topics.js). 모르는 값은 버리고, 목록이 아니면 뺀다
    const topics = it.topics === undefined || it.topics === null ? undefined : cleanTopics(it.topics);
    if (topics === null) {
      rejected.push({ id, why: `topics 는 목록이어야 함 (${TOPIC_IDS.join('|')} 중에서)` });
      continue;
    }
    if (it.verdict === undefined || it.verdict === null) {
      // 판정은 그대로 두고 분위기 점수나 주제만
      if (vibe === undefined && topics === undefined) rejected.push({ id, why: 'verdict·vibe·topics 모두 없음' });
      else {
        seen.add(id);
        items.push({ id, ...(vibe !== undefined ? { vibe } : {}), ...(topics !== undefined ? { topics } : {}) });
      }
      continue;
    }
    if (!VERDICTS.includes(it.verdict)) {
      rejected.push({ id, why: `verdict 값 오류 (${String(it.verdict).slice(0, 20)}) — ${VERDICTS.join('|')} 중 하나` });
      continue;
    }
    const shortsScore = scoreOf(it.shortsScore);
    if (shortsScore === null) {
      rejected.push({ id, why: `shortsScore 는 0~100 숫자여야 함 (${String(it.shortsScore).slice(0, 20)})` });
      continue;
    }
    if (it.reason !== undefined && it.reason !== null && typeof it.reason !== 'string') {
      rejected.push({ id, why: 'reason 은 문자열이어야 함' });
      continue;
    }
    const ok = it.verdict === 'ok';
    if (ok && shortsScore === undefined) {
      rejected.push({ id, why: 'ok 인데 shortsScore 없음' });
      continue;
    }
    if (ok && requireVibe && vibe === undefined) {
      rejected.push({ id, why: 'ok 인데 vibe 없음' });
      continue;
    }
    seen.add(id);
    const o = { id, verdict: it.verdict, shortsScore: ok ? shortsScore : 0, reason: String(it.reason ?? '').trim().slice(0, REASON_MAX) };
    if (vibe !== undefined) o.vibe = ok ? vibe : 0;
    // 주제는 정상·유머 아님 판정에만 의미가 있다 (정보 글은 not_humor 여도 주제 탭에 보인다)
    if (topics?.length && (ok || it.verdict === 'not_humor')) o.topics = topics;
    items.push(o);
  }
  return { items, rejected, model: String(data?.model || 'claude-code 검수').slice(0, 60) };
}

/**
 * 검수 대기 글 받기
 * @param {{origin: string, password: string, limit?: number, vibe?: boolean, withRead?: boolean, readTop?: number, fetch?: typeof fetch}} o
 * @returns {Promise<{total: number, waiting?: number, items: any[]}>}
 */
export async function fetchQueue({ origin, password, limit = 300, vibe = false, withRead = false, readTop = 20, fetch: f }) {
  const s = await adminSession({ origin, password, fetch: f });
  try {
    const q = new URLSearchParams({ limit: String(Math.max(1, Math.min(1000, Number(limit) || 300))) });
    if (vibe) q.set('vibe', '1');
    if (withRead) {
      q.set('withRead', '1');
      q.set('readTop', String(Math.max(1, Math.min(40, Number(readTop) || 20))));
    }
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
  const plain = args.filter((a, i) => !a.startsWith('--') && !['--limit', '--out', '--read-top'].includes(args[i - 1]));
  const [url, cmd, file] = plain;
  if (!url || !['queue', 'apply'].includes(cmd) || (cmd === 'apply' && !file)) {
    console.error('사용법: node scripts/cloud-review.js <사이트 주소> queue [--limit 300] [--vibe] [--with-read [--read-top 20]] [--out queue.json]');
    console.error('        node scripts/cloud-review.js <사이트 주소> apply <판정.json>');
    return 2;
  }
  const origin = siteOrigin(url);
  // PowerShell 로 쓴 파일은 앞에 BOM 이 붙을 수 있다
  const data = cmd === 'apply' ? JSON.parse(readFileSync(path.resolve(file), 'utf8').replace(/^﻿/, '')) : null;
  const password = process.env.CLOUD_ADMIN_PASSWORD || (await askHidden('관리자 비밀번호: '));
  if (cmd === 'queue') {
    const out = await fetchQueue({ origin, password, limit: opt('limit'), vibe: args.includes('--vibe'), withRead: args.includes('--with-read'), readTop: opt('read-top') });
    const text = JSON.stringify(out, null, 2);
    if (opt('out')) {
      writeFileSync(path.resolve(opt('out')), text);
      console.error(`검수 대기 ${out.waiting ?? out.total}개 중 ${out.total}개 → ${path.resolve(opt('out'))}`);
    } else process.stdout.write(`${text}\n`);
    return 0;
  }
  const { items, rejected, model } = checkVerdicts(data);
  for (const x of rejected) console.error(`  뺌: ${x.id ?? '(id 없음)'} — ${x.why}`);
  const r = items.length ? await applyVerdicts({ origin, password, data: { model, items }, log: (s) => console.error(s) }) : { applied: 0, skipped: [] };
  console.error(`판정 반영 ${r.applied}개${r.skipped.length ? `, 사이트가 건너뜀 ${r.skipped.length}개 (없는 글)` : ''}${rejected.length ? `, 형식이 틀려 뺌 ${rejected.length}개` : ''}`);
  return items.length || !rejected.length ? 0 : 1;
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
