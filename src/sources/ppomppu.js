// 뽐뿌 유머/감동 게시판 — 핫/인기 목록(hotlist_flag=999).
// 데스크톱 zboard(DQ_Revolution 스킨, EUC-KR). 단순 curl(Windows Schannel)은 403 이지만
// Node fetch(공용 fetchHtml)는 일반 브라우저 헤더만으로 200 을 받는다.
//
// 목록 메모
//  - 핫/인기 목록의 등록일 칸(<time title="26.10.16 14:07:01">)은 글 작성 시각이 아니라
//    "핫/인기 진입 시각"이다 (예: 786789 는 02:32 작성, 목록엔 14:07:01). 작성 시각은 목록에 없으므로
//    postedAt 에는 이 시각을 넣고, read() 에서 정확한 작성 시각(G_BBS_REG_DATE)을 돌려준다.
//  - 추천 칸은 "66 - 0"(추천 - 비추천), 표가 없으면 빈 칸 → 0.
//  - 댓글수는 제목 옆 span.baseList-c (없으면 댓글 0).
//  - 사이트 자체의 19금 표시는 없고, 글쓴이들이 제목 앞에 ㅇㅎ/ㅎㅂ/[약후] 등을 붙인다 → 제목으로 nsfwHint.
//
// 댓글 메모 (view.php 원문 HTML 기준, 2026-10 확인)
//  - 1쪽 댓글은 본문 HTML 의 <script> 안에 JSON 으로 들어 있다:
//      var initialCommentData = {"total_comment":173,"total_page":10,"comment_mode":"sort_asc","comments":[...]};
//    한 쪽 = 최상위 댓글 10개 + 그 대댓글 전부(sub_cmt 트리, depth 0/1/2). 사이트 순서 = 배열 순서.
//    댓글 하나: no, depth, name(HTML 닉네임), memo(본문 HTML), vote_btn.vote_count(추천),
//    anti_vote_btn.anti_vote_count(비추천), meta.time_detail("2026-10-11 23:59:03", KST), block_status.is_spam/is_blocked.
//  - 2쪽부터는 사이트 스크립트(bbs_view_comment.js 의 go_page / BbsCommentLoadMore)가 AJAX GET 으로 받는다:
//      GET /zboard/comment.php?id=humor&no=<글>&c_page=<쪽>&comment_mode=sort_asc&cmd=get_comment_json
//      (X-Requested-With: XMLHttpRequest, Referer: 글 주소, 토큰·쿠키 불필요, 응답은 같은 형식의 UTF-8 JSON)
//    robots.txt 는 /zboard/ 를 Allow 하고 view.php?id=my, view_info2.php 만 막는다 → comment.php 사용 가능.
//  - 핫코멘트(베스트)는 본문 HTML 의 div.hot_comment_list 에 링크로만 있다 (글자는 잘린 미리보기):
//      <a onclick="search_cmt('humor', 785825, <쪽>, <댓글번호>)"><b>닉</b> / 앞부분... <img thumbsup> 9 <img thumbsdown> 4</a>
//    → 댓글번호로 해당 쪽 JSON 에서 전체 내용을 찾고, 그 댓글은 일반 목록에서 뺀다(중복 방지).
//  - 댓글 짤: 움짤은 mp4(<video><source src=cdn4s…mp4>)로 바뀌고 옆의 "원본보기" 버튼 data-org-src 에 원본 GIF 가 있다.
//    사진·짤방은 <img class="lazy" src=".../images/lazyloading.jpg" data-original="실제 주소">.
import * as cheerio from 'cheerio';
import { fetchHtml, fetchJson } from '../lib/http.js';
import { absUrl, cleanText, parseCount, parseKoDate, normalizeMedia } from '../lib/util.js';

const BASE = 'https://www.ppomppu.co.kr';
const BOARD = 'humor';
const LIST_URL = `${BASE}/zboard/zboard.php?id=${BOARD}&hotlist_flag=999`;

const postUrl = (no) => `${BASE}/zboard/view.php?id=${BOARD}&no=${no}`;

// 제목에 붙는 후방/므흣 표기. "19" 는 괄호로 감싸거나 19금/19+ 일 때만 (코로나19·19살·2019 금메달 등 오탐 방지),
// "후방카메라/후방추돌" 같은 자동차 용어와 "약후기"는 제외.
const NSFW_RE =
  /ㅇㅎ|ㅎㅂ|ㅗㅜㅑ|약후(?!기)|후방(?!\s*(?:카메라|캠|센서|감지|추돌|주차|블랙박스|경보))|므흣|은꼴|수위\s*(?:주의|有|있)|성인\s*(?:물|인증|주의)|(?<!\d)19금|(?<!\d)19\+|[[(【<]\s*19\s*[\])】>]|nsfw/i;

// 핫/인기 목록에는 ㅇㅎ 표기 없이 올라오는 화보·몸매 글(특정 업로더)이 많아, 제목의 명백한 신체·성적 단어도 함께 잡는다.
// (사이트 표기가 아닌 보조 휴리스틱 — 중앙 필터에서 처리하기로 하면 이 줄만 지우면 된다)
const SUGGESTIVE_RE = /비키니|수영복|레깅스|몸매|란제리|속옷|그라비아|섹스|(?:^|[^A-Za-z])[A-H]컵/;

function isNsfwTitle(title) {
  const t = title || '';
  return NSFW_RE.test(t) || SUGGESTIVE_RE.test(t);
}

/** "66 - 0" → 66, "" → 0 */
function parseRec(s) {
  const t = cleanText(s);
  if (!t) return 0;
  const m = /^(\d[\d,]*)/.exec(t);
  return m ? parseCount(m[1]) : null;
}

/**
 * s.ppomppu.co.kr 리다이렉트 링크(?target=<base64>&encode=on)의 실제 목적지. 리다이렉트 링크가 아니면 null.
 */
function redirectTarget(href) {
  try {
    const u = new URL(href);
    if (u.hostname !== 's.ppomppu.co.kr') return null;
    let t = u.searchParams.get('target');
    if (!t) return null;
    if (u.searchParams.get('encode') === 'on') {
      t = Buffer.from(t.replace(/ /g, '+'), 'base64').toString('utf8');
    }
    return new URL(t).toString();
  } catch {
    return null;
  }
}

const isPpomppuHost = (h) => h === 'ppomppu.co.kr' || h.endsWith('.ppomppu.co.kr');

/** 목록/본문 글쓴이: 텍스트 닉네임 또는 이미지 닉네임(alt/title) */
function authorOf($, $el) {
  const txt = cleanText($el.text());
  if (txt) return txt;
  const $img = $el.find('img').first();
  return cleanText($img.attr('alt') || $img.attr('title') || '') || null;
}

// ---------------- 댓글 ----------------

const COMMENT_MAX = 100;
const COMMENT_EXTRA_REQUESTS = 2; // read() 한 번에 댓글용 추가 요청 상한

/** 스크립트 안의 `var <name> = {...};` JSON 을 꺼낸다 (문자열 속 괄호를 건너뛰며 짝 맞추기). 없거나 깨지면 null. */
function extractJsonVar(text, name) {
  const m = new RegExp(`var\\s+${name}\\s*=\\s*\\{`).exec(text || '');
  if (!m) return null;
  const start = m.index + m[0].length - 1;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) {
      try {
        return JSON.parse(text.slice(start, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** 댓글 2쪽 이후: 사이트 스크립트와 같은 AJAX 요청 (재시도 없음 — 요청 수 상한을 지키기 위해) */
async function fetchCommentPage(no, page, mode, referer) {
  const url =
    `${BASE}/zboard/comment.php?id=${BOARD}&no=${encodeURIComponent(no)}&c_page=${page}` +
    `&comment_mode=${encodeURIComponent(mode)}&cmd=get_comment_json`;
  const d = await fetchJson(url, { referer, retries: 0, headers: { 'x-requested-with': 'XMLHttpRequest' } });
  return d && Array.isArray(d.comments) ? d : null;
}

// 사이트 UI 아이콘(지연로딩 자리표시·원본보기 버튼·추천 아이콘 등)은 댓글 짤이 아니다
const UI_IMG_RE = /\/images\/(?:lazyloading|gif_load|thumbs(?:up|down)|icon_|no_face|menu\/)/i;
// "삭제된 코멘트입니다." / "관리자에 의해 삭제된 댓글입니다" / "블라인드 처리된 코멘트입니다" 등 (짧은 안내문 전체가 일치할 때만)
const DELETED_RE =
  /^[[(]?\s*(?:[가-힣\s]{0,12}의해\s*)?(?:삭제|블라인드(?:\s*처리)?)\s*(?:된|한|됨|되었습니다)\s*(?:코멘트|댓글)?\s*(?:입니다)?\s*[.\])]?$/;

/** 댓글 memo(HTML) → { text(줄바꿈 유지), images(절대 URL) } */
function memoToContent(memo, baseUrl) {
  const $ = cheerio.load(`<div id="__m">${memo || ''}</div>`, null, false);
  const $m = $('#__m');
  const images = [];
  const add = (u) => {
    const abs = absUrl(u, baseUrl);
    if (abs && !UI_IMG_RE.test(abs) && !images.includes(abs)) images.push(abs);
  };
  // 움짤(mp4): 같은 묶음(span.wrapper_video)의 "원본보기" data-org-src(원본 GIF)를 우선, 없으면 mp4 주소
  $m.find('video').each((_, v) => {
    const $v = $(v);
    const $wrap = $v.closest('.wrapper_video');
    const org = ($wrap.length ? $wrap : $v.parent()).find('[data-org-src]').first().attr('data-org-src');
    add(org || $v.attr('src') || $v.find('source[src]').first().attr('src'));
  });
  $m.find('img').each((_, im) => {
    const $im = $(im);
    if ($im.closest('.btn_show_org, .btn_show_org_all, .scrap_bx').length) return;
    add($im.attr('data-original') || $im.attr('data-src') || $im.attr('src'));
  });
  // 링크 카드(scrap_bx: 제목·썸네일 미리보기)는 버리고 바로 뒤의 주소 링크 글자만 남긴다
  $m.find('script, style, textarea, video, .btn_show_org, .btn_show_org_all, a.scrap_bx_href, .scrap_bx, img').remove();
  const mention = cleanText($m.find('.cheditor_tonick').first().text());
  // 브라우저처럼: 소스의 줄바꿈·연속 공백은 공백 하나 (&nbsp; 는 남김), 줄바꿈은 <br> 과 문단(<p>/<div>) 경계에서만.
  // 이 편집기는 한 줄 = <p> 하나, 빈 줄 = <p>&nbsp;</p> 이다.
  $m.find('*')
    .addBack()
    .contents()
    .each((_, n) => {
      if (n.type === 'text') n.data = n.data.replace(/[ \t\r\n\f]+/g, ' ');
    });
  const BLOCK = 'p, div, li, tr, h1, h2, h3, h4, h5, h6, blockquote, pre, ul, ol, table';
  // 문단 끝에서 글자 뒤에 붙은 <br> 하나(<p>글<br></p>)는 브라우저에서 빈 줄을 만들지 않는다 → 지운다
  $m.find('br').each((_, br) => {
    const blank = (n) => n && n.type === 'text' && !n.data.trim();
    let nx = br.next;
    while (blank(nx)) nx = nx.next;
    if (nx || !br.parent || !$(br.parent).is(BLOCK)) return;
    let pv = br.prev;
    while (blank(pv)) pv = pv.prev;
    if (pv && !(pv.type === 'tag' && pv.name === 'br')) $(br).remove();
  });
  $m.find('br').replaceWith('\n');
  const isBlock = (n) => n && n.type === 'tag' && $(n).is(BLOCK);
  $m.find(BLOCK).each((_, el) => {
    // 앞에 글자(인라인)가 붙어 있으면 줄을 바꿔 시작
    let p = el.prev;
    while (p && !(p.type === 'tag' || (p.type === 'text' && (p.data.includes('\n') || p.data.trim())))) p = p.prev;
    if (p && !isBlock(p) && !(p.type === 'text' && /\n\s*$/.test(p.data))) $(el).before('\n');
    // 끝에서 줄바꿈 (마지막 자식이 문단이면 그쪽이 이미 줄을 바꿈)
    let last = el.lastChild;
    while (last && last.type !== 'tag' && !(last.type === 'text' && last.data.trim())) last = last.prev;
    if (!isBlock(last)) $(el).append('\n');
  });
  let lines = $m
    .text()
    .replace(/[ ​\t\f\v\r ]+/g, ' ')
    .split('\n')
    .map((s) => s.trim());
  // 빈 줄 여러 개는 하나로, 앞뒤 빈 줄 제거
  lines = lines.filter((l, i) => l || (i > 0 && lines[i - 1]));
  while (lines.length && !lines[0]) lines.shift();
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  // 대댓글의 "@닉네임" 만 있는 첫 줄은 다음 줄과 합친다 ("@닉 내용")
  if (mention && lines[0] === mention && lines.length > 1) {
    const k = lines.findIndex((l, i) => i > 0 && l);
    if (k > 0) lines = [`${mention} ${lines[k]}`, ...lines.slice(k + 1)];
  }
  return { text: lines.join('\n'), images };
}

/** initialCommentData / comment.php 의 댓글 하나 → Comment (보여줄 수 없는 댓글이면 null) */
function toComment(c, baseUrl, best) {
  if (!c || typeof c !== 'object') return null;
  const bs = c.block_status || {};
  if (bs.is_spam || bs.is_blocked) return null; // 스팸 처리·차단으로 접혀 보이는 댓글
  const { text, images } = memoToContent(c.memo, baseUrl);
  if (!text && !images.length) return null;
  if (!images.length && DELETED_RE.test(text)) return null;
  let author = null;
  if (c.name) {
    const $ = cheerio.load(`<div id="__n">${c.name}</div>`, null, false);
    author = authorOf($, $('#__n'));
  }
  const depth = Number(c.depth) || 0;
  return {
    no: String(c.no),
    author,
    text,
    likes: parseCount(c.vote_btn?.vote_count ?? null),
    dislikes: parseCount(c.anti_vote_btn?.anti_vote_count ?? null),
    best: !!best,
    reply: !best && depth > 0,
    postedAt: parseKoDate(c.meta?.time_detail || c.meta?.time_display || null),
    images,
  };
}

/** 댓글 트리(sub_cmt)를 사이트 순서대로 펼친다 */
function flattenTree(list, out = []) {
  for (const c of Array.isArray(list) ? list : []) {
    if (!c || typeof c !== 'object') continue;
    out.push(c);
    flattenTree(c.sub_cmt, out);
  }
  return out;
}

/** div.hot_comment_list 의 핫코멘트 링크: [{cno, page, author, text(잘린 미리보기), likes, dislikes}] */
function parseHotList($) {
  const out = [];
  $('.hot_comment_list a[onclick*="search_cmt"]').each((_, a) => {
    const $a = $(a);
    const m = /search_cmt\(\s*['"][^'"]*['"]\s*,\s*\d+\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/.exec($a.attr('onclick') || '');
    if (!m || out.some((h) => h.cno === m[2])) return;
    // 자식 노드: <b>닉</b> " / 미리보기 " <img thumbsup> " 9 " <img thumbsdown> " 4"
    let author = null;
    let preview = '';
    let likes = null;
    let dislikes = null;
    let slot = 'text';
    for (const n of a.children || []) {
      if (n.type === 'tag' && n.name === 'b' && author === null) author = cleanText($(n).text()) || null;
      else if (n.type === 'tag' && n.name === 'img') {
        const src = $(n).attr('src') || '';
        slot = /thumbsdown/.test(src) ? 'down' : /thumbsup/.test(src) ? 'up' : slot;
      } else if (n.type === 'text') {
        if (slot === 'text') preview += n.data;
        else if (slot === 'up' && likes === null) likes = parseCount(n.data);
        else if (slot === 'down' && dislikes === null) dislikes = parseCount(n.data);
      }
    }
    preview = preview
      .replace(/^\s*\/\s*/, '')
      .split('\n')
      .map((s) => cleanText(s))
      .filter(Boolean)
      .join('\n');
    out.push({ page: Number(m[1]) || 1, cno: m[2], author, text: preview, likes, dislikes });
  });
  return out;
}

/**
 * 댓글 모으기: 핫코멘트(best) 먼저(최상위 베스트는 그 답글 묶음과 함께, 묶음 안의 베스트는 제자리에서 best+reply),
 * 그다음 1쪽부터 사이트 순서대로. 추가 요청은 최대 2회
 * (핫코멘트가 2쪽 이후에 있으면 그 쪽 → 남은 요청으로 2쪽, 3쪽…), 최대 100개.
 * 댓글 쪽 요청이 실패해도 본문 결과는 그대로 돌려주도록 예외를 삼킨다.
 */
async function readComments($, text, no, postUrl) {
  const shown = parseCount($('h1 #comment').first().text());
  const data = extractJsonVar(text, 'initialCommentData');
  if (!data || !Array.isArray(data.comments)) {
    return { comments: [], commentTotal: shown ?? null };
  }
  const commentTotal = parseCount(data.total_comment ?? null) ?? shown ?? null;
  const totalPage = Math.max(1, Number(data.total_page) || 1);
  const mode = typeof data.comment_mode === 'string' && /^[a-z_]+$/.test(data.comment_mode) ? data.comment_mode : 'sort_asc';
  const pages = new Map([[1, flattenTree(data.comments)]]);
  let budget = no ? COMMENT_EXTRA_REQUESTS : 0;
  let failed = false;
  const load = async (p) => {
    budget--;
    try {
      const d = await fetchCommentPage(no, p, mode, postUrl);
      if (d) pages.set(p, flattenTree(d.comments));
      else failed = true;
    } catch {
      failed = true;
    }
  };

  const hot = parseHotList($);
  // 1) 1쪽 밖의 핫코멘트가 있는 쪽
  const hotPages = [...new Set(hot.map((h) => h.page))].filter((p) => p > 1 && p <= totalPage).sort((a, b) => a - b);
  for (const p of hotPages) {
    if (budget <= 0 || failed) break;
    await load(p);
  }
  // 2) 남은 요청으로 이어지는 쪽 (2쪽, 3쪽…) — 중간이 빠지지 않게 연속된 쪽만 일반 목록에 쓴다
  const seq = [1];
  let count = pages.get(1).length;
  for (let p = 2; p <= totalPage && count < COMMENT_MAX + hot.length; p++) {
    if (!pages.has(p)) {
      if (budget <= 0 || failed) break;
      await load(p);
      if (!pages.has(p)) break;
    }
    seq.push(p);
    count += pages.get(p).length;
  }

  const byNo = new Map();
  for (const list of pages.values()) for (const c of list) if (!byNo.has(String(c.no))) byNo.set(String(c.no), c);

  // 화면(public/app.js)은 평평한 목록이라 reply:true 댓글은 "바로 위의 최상위 댓글"에 달린 답글로 보인다.
  // 그래서 최상위 댓글이 빠진 자리(베스트로 올림·삭제·스팸)의 답글이 앞 댓글의 답글처럼 보이지 않게 한다.
  const bestNos = new Set(hot.map((h) => h.cno));
  // 최상위 베스트(보여줄 수 있는 것)는 답글 묶음째 위로 옮긴다. 그 묶음 안의 다른 베스트는 묶음 안 제자리에 둔다.
  const bestTop = new Map(); // cno -> { raw, c }
  for (const h of hot) {
    const raw = byNo.get(h.cno);
    if (!raw || Number(raw.depth) > 0) continue;
    const c = toComment(raw, postUrl, true);
    if (c) bestTop.set(h.cno, { raw, c });
  }
  const nested = new Set();
  for (const { raw } of bestTop.values()) {
    for (const r of flattenTree(raw.sub_cmt)) if (bestNos.has(String(r.no))) nested.add(String(r.no));
  }
  const done = new Set(); // 베스트 구역에 이미 넣은 댓글
  const best = [];
  for (const h of hot) {
    if (done.has(h.cno) || nested.has(h.cno)) continue;
    done.add(h.cno);
    const top = bestTop.get(h.cno);
    if (top) {
      best.push(top.c);
      for (const r of flattenTree(top.raw.sub_cmt)) {
        const k = String(r.no);
        if (done.has(k)) continue;
        done.add(k);
        const rc = toComment(r, postUrl, bestNos.has(k));
        if (rc) best.push({ ...rc, reply: true });
      }
      continue;
    }
    const raw = byNo.get(h.cno);
    const c = raw
      ? toComment(raw, postUrl, true)
      : h.text
        ? { no: h.cno, author: h.author, text: h.text, likes: h.likes, dislikes: h.dislikes, best: true, reply: false, postedAt: null, images: [] }
        : null; // 해당 쪽을 못 받았으면 핫코멘트 목록의 미리보기(앞부분)로 대신
    if (c) best.push(c);
  }
  const normal = [];
  for (const p of seq) {
    let topShown = false;
    for (const raw of pages.get(p)) {
      const k = String(raw.no);
      const top = !(Number(raw.depth) > 0);
      if (top) topShown = false;
      if (bestNos.has(k) || done.has(k)) continue;
      const c = toComment(raw, postUrl, false);
      if (!c) continue;
      if (top) topShown = true;
      else if (!topShown) c.reply = false; // 최상위 댓글이 빠진 답글은 일반 댓글로 (엉뚱한 댓글의 답글처럼 보이지 않게)
      normal.push(c);
    }
  }
  const comments = [...best, ...normal].slice(0, COMMENT_MAX).map(({ no: _no, ...c }) => c);
  return { comments, commentTotal };
}

export default {
  id: 'ppomppu',
  name: '뽐뿌 유머/감동 (핫/인기)',
  short: '뽐뿌',
  color: '#c2410c',
  homepage: LIST_URL,
  domains: ['ppomppu.co.kr'],
  // 본문 이미지는 cdn4.ppomppu.co.kr, mp4 는 cdn4s.ppomppu.co.kr (접미사 일치로 cdn*.ppomppu.co.kr 전부 허용)
  imageHosts: ['ppomppu.co.kr'],
  // CDN 은 Referer 없음/뽐뿌 Referer 는 허용, 외부 Referer 는 403
  referer: `${BASE}/`,
  strictness: 'normal',
  disabled: false,
  disabledReason: null,

  async list(page = 1) {
    const p = Math.max(1, Number(page) || 1);
    const { $, url } = await fetchHtml(`${LIST_URL}&page=${p}`, {
      referer: p > 1 ? `${LIST_URL}&page=${p - 1}` : `${BASE}/zboard/zboard.php?id=${BOARD}`,
    });
    const $table = $('#revolution_main_table');
    if (!$table.length) {
      // 차단·점검 페이지이거나 스킨이 바뀐 경우 — 빈 배열 대신 원인이 보이도록 예외
      const msg = cleanText($('.error2, .error').first().text() || $('title').first().text()).slice(0, 80);
      throw new Error(`뽐뿌 목록 표(#revolution_main_table)를 찾지 못함${msg ? ` (${msg})` : ''} — 차단 페이지이거나 구조가 바뀜: ${url}`);
    }
    const items = [];
    const seen = new Set();
    $table.find('tr.baseList').each((_, tr) => {
      const $tr = $(tr);
      if ($tr.hasClass('baseNotice') || $tr.attr('id') === 'topNotice') return;
      const numb = cleanText($tr.find('td.baseList-numb').first().text());
      if (!/^\d+$/.test(numb)) return; // 공지·광고·이벤트 행 (번호 대신 글자)
      const $a = $tr.find('a.baseList-title').first();
      const href = absUrl($a.attr('href'), url);
      if (!href) return;
      let u;
      try {
        u = new URL(href);
      } catch {
        return;
      }
      if (u.searchParams.get('id') !== BOARD) return; // 다른 게시판(이용규칙 등) 링크
      const postId = u.searchParams.get('no');
      if (!postId || !/^\d+$/.test(postId) || seen.has(postId)) return;
      seen.add(postId);

      const title = cleanText($a.text()).replace(/\s*\[\d+\]\s*$/, '');
      if (!title) return;

      const $time = $tr.find('time.baseList-time').first();
      const postedAt = parseKoDate($time.attr('title') || $time.closest('td').attr('title') || $time.text());

      const $c = $tr.find('span.baseList-c').first();
      const commentCount = $c.length ? parseCount($c.text()) : 0;

      const $tdTitle = $a.closest('td');
      const hot = $tdTitle.find('img[src*="hot_icon"]').length > 0;
      const pop = $tdTitle.find('img[src*="pop_icon"]').length > 0;

      items.push({
        postId,
        title,
        url: postUrl(postId),
        // a.baseList-name > span.baseList-name 구조. span 이 없는 변형(이미지 닉네임 등)도 a 로 받는다.
        author: authorOf($, $tr.find('.baseList-name').first()),
        postedAt,
        commentCount,
        views: parseCount($tr.find('td.baseList-views').first().text()),
        likes: parseRec($tr.find('td.baseList-rec').first().text()),
        category: hot ? 'HOT' : pop ? '인기' : null,
        nsfwHint: isNsfwTitle(title),
        thumbnail: null,
      });
    });
    return items;
  },

  async read(postUrlIn) {
    const { $, url, text } = await fetchHtml(postUrlIn, { referer: LIST_URL });

    // 제목: <h1><img hot_icon> 제목<span id="comment">68</span></h1>
    const $h1 = $('h1').filter((_, el) => $(el).find('#comment').length > 0).first();
    let title = '';
    if ($h1.length) {
      const $t = $h1.clone();
      $t.find('#comment, img').remove();
      title = cleanText($t.text());
    }
    if (!title) {
      title = cleanText($('meta[property="og:title"]').attr('content') || '');
    }

    const author = authorOf($, $('.topTitle-name .baseList-name').first()) || null;

    // 작성 시각: G_BBS_REG_DATE (유닉스 초) → 없으면 "등록일 2026-10-16 02:32"
    let postedAt = null;
    const epoch = /G_BBS_REG_DATE\s*=\s*[`'"](\d{9,11})[`'"]/.exec(text)?.[1];
    if (epoch) postedAt = parseKoDate(Number(epoch));
    if (!postedAt) {
      const reg = $('.topTitle-mainbox li')
        .map((_, li) => cleanText($(li).text()))
        .get()
        .find((s) => s.startsWith('등록일'));
      if (reg) postedAt = parseKoDate(reg.replace(/^등록일\s*/, ''));
    }

    const $body = $('td.board-contents').first();
    if (!$body.length) {
      // 삭제·이동된 글은 200 OK 에 "선택하신 게시물이 존재하지 않습니다" 안내(div.error2)만 온다 → 빈 본문 대신 예외
      const msg = cleanText($('.error2').first().text()).slice(0, 80);
      throw new Error(`뽐뿌 본문(td.board-contents)을 찾지 못함${msg ? ` (${msg})` : ''} — 삭제·블라인드되었거나 구조가 바뀜: ${postUrlIn}`);
    }
    // 본문 안 스크립트·스타일·광고·주석 제거
    $body.find('script, style, noscript, iframe[src*="ads"], .ad_container, [class*="w2g"]').remove();
    $body
      .contents()
      .add($body.find('*').contents())
      .filter((_, n) => n.type === 'comment')
      .remove();
    // 링크 카드(scrap_bx)·리다이렉트 링크: 뽐뿌 내부 글로 가는 것은 업로더의 "내 다른 글" 홍보(관련글)라 제거,
    // 외부로 가는 것은 리다이렉트를 풀어 실제 주소로 바꾼다.
    $body.find('a[href]').each((_, a) => {
      const $a = $(a);
      const target = redirectTarget(absUrl($a.attr('href'), url) || '');
      if (!target) return;
      if (isPpomppuHost(new URL(target).hostname)) {
        const $parent = $a.parent();
        $a.remove();
        if ($parent.is('div, p') && !cleanText($parent.text()) && !$parent.find('img, video, iframe').length) {
          $parent.remove();
        }
      } else {
        $a.attr('href', target);
      }
    });
    // <video> 안의 대체 문구("Your browser does not support the video tag.") 제거, 자동재생 끄기
    $body.find('video').each((_, v) => {
      const $v = $(v);
      $v.contents()
        .filter((__, n) => n.type === 'text')
        .remove();
      $v.removeAttr('autoplay').attr('preload', 'metadata');
    });
    normalizeMedia($, $body, url);
    $body.find('img').each((_, im) => {
      const $im = $(im);
      // 가로 900px 를 넘는 사진은 편집기가 "900w_<원본 파일명>" 축소판을 본문에 넣는다 (alt = 원본 파일명).
      // 원본은 같은 폴더에 그대로 있다 (예: 900w_…uRzAiYT4yW.jpg 900x506 → …uRzAiYT4yW.jpg 1280x720, 비율 같음).
      const src = $im.attr('src') || '';
      const m = /^(https:\/\/[^/]*ppomppu\.co\.kr\/.*\/)\d{3,4}w_([^/?#]+)$/.exec(src);
      const alt = cleanText($im.attr('alt') || '');
      if (m && (!alt || alt === m[2])) $im.attr('src', m[1] + m[2]);
      // 크기는 원본 그대로 보이게 (이 편집기는 style 로만 크기를 주고, 서버가 style 을 지운다 — 남은 width/height 속성이 있으면 같이 정리)
      $im.removeAttr('width').removeAttr('height');
    });
    // 앞뒤의 빈 문단(<p><br></p>) 정리
    const isBlank = (el) => $(el).is('p, div') && !cleanText($(el).text()) && !$(el).find('img, video, iframe, source').length;
    for (let first = $body.children().first(); first.length && isBlank(first[0]); first = $body.children().first()) first.remove();
    for (let last = $body.children().last(); last.length && isBlank(last[0]); last = $body.children().last()) last.remove();

    // 댓글 (실패해도 본문은 돌려준다)
    let comments = [];
    let commentTotal = null;
    try {
      let no = null;
      try {
        no = new URL(url).searchParams.get('no') || new URL(postUrlIn).searchParams.get('no');
      } catch {}
      ({ comments, commentTotal } = await readComments($, text, /^\d+$/.test(no || '') ? no : null, url));
    } catch {
      comments = [];
      commentTotal = parseCount($('h1 #comment').first().text());
    }

    return {
      title,
      html: ($body.html() || '').trim(),
      author,
      postedAt,
      nsfwHint: isNsfwTitle(title),
      comments,
      commentTotal,
    };
  },
};
