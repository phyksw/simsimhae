// 소스 어댑터 실사이트 검증기.
// 사용법: node scripts/test-source.js <id> [--pages 2] [--read 2] [--json] [--show 10]
// list()/read() 를 실제로 호출하고 규약 위반을 FAIL, 의심스러운 점을 WARN 으로 보고한다. FAIL 이 있으면 종료 코드 1.
import { getSource } from '../src/sources/index.js';
import { fetchRaw } from '../src/lib/http.js';
import { hostMatches } from '../src/lib/util.js';
import * as cheerio from 'cheerio';

const args = process.argv.slice(2);
const id = args.find((a) => !a.startsWith('--'));
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? Number(args[i + 1]) : def;
};
const PAGES = opt('pages', 2);
const READS = opt('read', 2);
const SHOW = opt('show', 10);
const JSON_OUT = args.includes('--json');

const fails = [];
const warns = [];
const fail = (m) => fails.push(m);
const warn = (m) => warns.push(m);
const log = (...a) => {
  if (!JSON_OUT) console.log(...a);
};

if (!id) {
  console.error('usage: node scripts/test-source.js <id> [--pages N] [--read N] [--json]');
  process.exit(2);
}

const src = await getSource(id);
if (!src) {
  console.error(`source "${id}" not found in src/sources/`);
  process.exit(2);
}

// ---- 1. 형태 검사 ----
for (const k of ['id', 'name', 'short', 'color', 'homepage', 'referer', 'strictness']) {
  if (typeof src[k] !== 'string' || !src[k]) fail(`필드 ${k} 가 비어있거나 문자열이 아님`);
}
if (src.id !== id) fail(`id(${src.id}) 와 파일 이름(${id}) 불일치`);
for (const k of ['domains', 'imageHosts']) {
  if (!Array.isArray(src[k]) || src[k].length === 0) fail(`${k} 는 비어있지 않은 배열이어야 함`);
}
if (typeof src.list !== 'function' || typeof src.read !== 'function') fail('list()/read() 함수 필요');
if (!['normal', 'strict'].includes(src.strictness)) fail(`strictness 는 normal|strict`);
if (src.short && [...src.short].length > 5) warn(`short "${src.short}" 이 김 (배지용 2~4자 권장)`);
if (src.disabled) {
  if (!args.includes('--force')) {
    console.log(`SKIP ${id}: disabled (${src.disabledReason || '사유 없음'}) — 그래도 시험하려면 --force`);
    process.exit(0);
  }
  warn(`disabled=true (${src.disabledReason || '사유 없음'})`);
}

// ---- 2. list() ----
const pages = [];
const t0 = Date.now();
for (let p = 1; p <= PAGES; p++) {
  try {
    const items = await src.list(p);
    if (!Array.isArray(items)) {
      fail(`list(${p}) 가 배열을 반환하지 않음`);
      pages.push([]);
      continue;
    }
    pages.push(items);
  } catch (e) {
    fail(`list(${p}) 예외: ${e.message}`);
    pages.push([]);
  }
}
const listMs = Date.now() - t0;

const NOTICE_RE = /^\s*[[(]?\s*(공지|안내|광고|AD|이벤트)\s*[\])]?/i;
pages.forEach((items, i) => {
  const p = i + 1;
  if (items.length < 8) fail(`list(${p}) 결과 ${items.length}개 (최소 8개 기대)`);
  const ids = new Set();
  let noDate = 0;
  let noComment = 0;
  for (const it of items) {
    const tag = `list(${p}) #${it?.postId}`;
    if (!it || typeof it !== 'object') {
      fail(`list(${p}) 에 객체가 아닌 항목`);
      continue;
    }
    if (typeof it.postId !== 'string' || !it.postId) fail(`${tag}: postId 는 비어있지 않은 문자열이어야 함`);
    if (ids.has(it.postId)) fail(`${tag}: 같은 페이지에 postId 중복`);
    ids.add(it.postId);
    if (typeof it.title !== 'string' || !it.title.trim()) fail(`${tag}: 제목 없음`);
    else {
      if (it.title !== it.title.trim() || /\s{2,}|\n/.test(it.title)) warn(`${tag}: 제목 공백 정리 안 됨 "${it.title}"`);
      if (/\[\d+\]\s*$/.test(it.title)) warn(`${tag}: 제목 끝에 댓글수 꼬리표가 남음 "${it.title}"`);
      if (NOTICE_RE.test(it.title)) warn(`${tag}: 공지/광고로 보이는 글 "${it.title}"`);
    }
    let u;
    try {
      u = new URL(it.url);
    } catch {
      fail(`${tag}: url 이 절대 URL 이 아님 (${it.url})`);
    }
    if (u) {
      if (u.protocol !== 'https:') warn(`${tag}: https 아님 ${it.url}`);
      if (!hostMatches(u.hostname, src.domains)) fail(`${tag}: url 호스트 ${u.hostname} 가 domains 에 없음`);
      if (!it.url.includes(it.postId)) warn(`${tag}: url 에 postId 가 안 보임 ${it.url}`);
    }
    if (it.postedAt != null) {
      const d = new Date(it.postedAt);
      if (Number.isNaN(d.getTime())) fail(`${tag}: postedAt 이 ISO 가 아님 (${it.postedAt})`);
      else if (d.getTime() > Date.now() + 10 * 60e3) fail(`${tag}: postedAt 이 미래 (${it.postedAt})`);
      else if (d.getTime() < Date.now() - 400 * 864e5) warn(`${tag}: postedAt 이 1년 이상 과거 (${it.postedAt})`);
    } else noDate++;
    if (it.commentCount == null) noComment++;
    for (const k of ['commentCount', 'views', 'likes']) {
      if (it[k] != null && (typeof it[k] !== 'number' || !Number.isFinite(it[k]) || it[k] < 0)) fail(`${tag}: ${k} 가 숫자 아님 (${it[k]})`);
    }
    if (it.nsfwHint != null && typeof it.nsfwHint !== 'boolean') fail(`${tag}: nsfwHint 는 boolean`);
    if (it.thumbnail) {
      try {
        new URL(it.thumbnail);
      } catch {
        fail(`${tag}: thumbnail 이 절대 URL 이 아님`);
      }
    }
  }
  if (items.length && noDate === items.length) warn(`list(${p}): 모든 글에 postedAt 없음`);
  if (items.length && noComment === items.length) warn(`list(${p}): 모든 글에 commentCount 없음`);
});
if (pages.length >= 2 && pages[0].length && pages[1].length) {
  const a = new Set(pages[0].map((x) => x.postId));
  const overlap = pages[1].filter((x) => a.has(x.postId)).length;
  if (overlap > pages[1].length * 0.5) fail(`page 1 과 page 2 가 ${overlap}개 겹침 — 페이지 이동이 안 되는 듯`);
}

// ---- 3. read() ----
const reads = [];
const all = pages.flat();
for (const it of all.slice(0, READS)) {
  const r = { postId: it.postId, url: it.url };
  try {
    const t = Date.now();
    const a = await src.read(it.url);
    r.ms = Date.now() - t;
    if (!a || typeof a !== 'object') {
      fail(`read(${it.postId}) 가 객체를 반환하지 않음`);
      continue;
    }
    if (typeof a.title !== 'string' || !a.title.trim()) warn(`read(${it.postId}): 제목 없음`);
    if (typeof a.html !== 'string') {
      fail(`read(${it.postId}): html 이 문자열이 아님`);
      continue;
    }
    const $ = cheerio.load(a.html);
    const text = $.root().text().replace(/\s+/g, ' ').trim();
    const media = $('img[src], video[src], video source[src], iframe[src]')
      .map((_, el) => $(el).attr('src'))
      .get();
    r.title = a.title;
    r.textLen = text.length;
    r.textSample = text.slice(0, 120);
    r.mediaCount = media.length;

    // 댓글 검사
    if (a.comments !== undefined && !Array.isArray(a.comments)) fail(`read(${it.postId}): comments 는 배열이어야 함`);
    const cms = Array.isArray(a.comments) ? a.comments : [];
    r.comments = cms.length;
    r.bestComments = cms.filter((c) => c?.best).length;
    r.commentSample = cms.slice(0, 3).map((c) => `${c?.best ? '[BEST]' : ''}${c?.reply ? '↳' : ''}${c?.author ?? '?'}: ${String(c?.text ?? '').replace(/\n+/g, ' ⏎ ').slice(0, 40)}${c?.likes ? ` 👍${c.likes}` : ''}`);
    cms.forEach((c, i) => {
      const tag = `read(${it.postId}) 댓글#${i}`;
      if (!c || typeof c !== 'object') return fail(`${tag}: 객체 아님`);
      if (typeof c.text !== 'string') fail(`${tag}: text 는 문자열`);
      else if (!c.text.trim() && !(c.images || []).length) fail(`${tag}: 글자도 이미지도 없음`);
      else if (/<[a-z][^>]*>/i.test(c.text)) warn(`${tag}: text 에 HTML 태그가 남음`);
      for (const k of ['likes', 'dislikes']) if (c[k] != null && (typeof c[k] !== 'number' || c[k] < 0)) fail(`${tag}: ${k} 숫자 아님`);
      if (c.postedAt != null && Number.isNaN(Date.parse(c.postedAt))) fail(`${tag}: postedAt ISO 아님`);
      for (const im of c.images || []) {
        try {
          const u = new URL(im);
          if (!hostMatches(u.hostname, src.imageHosts)) warn(`${tag}: 댓글 이미지 호스트 ${u.hostname} 가 imageHosts 에 없음`);
        } catch {
          fail(`${tag}: 댓글 이미지가 절대 URL 아님 (${im})`);
        }
      }
    });
    if (!cms.length && (it.commentCount ?? 0) > 0) warn(`read(${it.postId}): 목록엔 댓글 ${it.commentCount}개인데 comments 가 비어 있음`);
    if (cms.length && it.commentCount && cms.length < Math.min(it.commentCount, 20) * 0.5) warn(`read(${it.postId}): 댓글 ${it.commentCount}개 중 ${cms.length}개만 가져옴`);
    if (!text && !media.length) fail(`read(${it.postId}): 본문이 비어 있음 (텍스트·미디어 모두 없음)`);
    if (/댓글\s*(쓰기|작성)|로그인\s*후\s*댓글|신고하기/.test(text)) warn(`read(${it.postId}): 본문에 댓글/버튼 영역이 섞인 듯`);
    if (/<script/i.test(a.html)) warn(`read(${it.postId}): html 에 <script> 포함 (서버에서 제거되지만 본문 범위 확인)`);
    const lazy = $('img').filter((_, el) => !$(el).attr('src') || /^data:/.test($(el).attr('src') || '')).length;
    if (lazy) warn(`read(${it.postId}): src 가 없거나 data: 인 img ${lazy}개 (지연로딩 속성 정리 필요?)`);
    const badHosts = new Set();
    for (const m of media) {
      try {
        const u = new URL(m);
        if (!/youtube|youtu\.be|vimeo|twitch|streamable|tiktok|instagram|twitter|x\.com/.test(u.hostname) && !hostMatches(u.hostname, src.imageHosts)) badHosts.add(u.hostname);
      } catch {
        fail(`read(${it.postId}): 미디어 src 가 절대 URL 이 아님 (${m})`);
      }
    }
    if (badHosts.size) warn(`read(${it.postId}): imageHosts 에 없는 미디어 호스트 ${[...badHosts].join(', ')}`);
    // 첫 이미지를 Referer 붙여 실제로 받아본다 (프록시 동작 확인)
    const firstImg = $('img[src]').map((_, el) => $(el).attr('src')).get().find((s) => /^https?:/.test(s));
    if (firstImg) {
      try {
        const res = await fetchRaw(firstImg, { referer: src.referer, headers: { accept: 'image/avif,image/webp,image/*,*/*;q=0.8' } });
        const ct = res.headers.get('content-type') || '';
        await res.arrayBuffer().catch(() => {});
        r.imgCheck = `${res.status} ${ct}`;
        // octet-stream 은 서버 프록시가 앞부분 바이트로 형식을 판별하므로 정상으로 본다 (디시 등)
        if (!res.ok || !/^(image|video)\/|^application\/octet-stream/.test(ct)) warn(`read(${it.postId}): 이미지 프록시 시험 실패 ${res.status} ${ct} ${firstImg}`);
      } catch (e) {
        warn(`read(${it.postId}): 이미지 받기 예외 ${e.message}`);
      }
    }
  } catch (e) {
    fail(`read(${it.postId}) 예외: ${e.message}`);
  }
  reads.push(r);
}

// ---- 보고 ----
const summary = {
  id,
  ok: fails.length === 0,
  disabled: !!src.disabled,
  pages: pages.map((p) => p.length),
  listMs,
  fails,
  warns,
  sample: all.slice(0, SHOW),
  reads,
};
if (JSON_OUT) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  log(`\n== ${src.name} (${id}) — 페이지별 ${summary.pages.join('/')}개, ${listMs}ms`);
  for (const it of summary.sample) {
    const meta = [
      it.postedAt ? new Date(it.postedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) : '날짜?',
      it.commentCount != null ? `댓${it.commentCount}` : null,
      it.views != null ? `조${it.views}` : null,
      it.likes != null ? `추${it.likes}` : null,
      it.category ? `[${it.category}]` : null,
      it.nsfwHint ? '🔞' : null,
    ]
      .filter(Boolean)
      .join(' ');
    log(`  ${it.postId.padEnd(12)} ${it.title}  (${meta})`);
  }
  for (const r of reads) {
    log(`  read ${r.postId}: 글자 ${r.textLen ?? '?'}, 미디어 ${r.mediaCount ?? '?'}, 이미지 ${r.imgCheck ?? '-'}, 댓글 ${r.comments ?? 0}(베댓 ${r.bestComments ?? 0}) | ${r.textSample ?? ''}`);
    for (const c of r.commentSample || []) log(`      💬 ${c}`);
  }
  for (const w of warns) log(`  WARN ${w}`);
  for (const f of fails) log(`  FAIL ${f}`);
  log(fails.length ? `\n결과: FAIL (${fails.length})` : `\n결과: PASS${warns.length ? ` (경고 ${warns.length})` : ''}`);
}
process.exit(fails.length ? 1 : 0);
