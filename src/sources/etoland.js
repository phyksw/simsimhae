// 이토랜드 유머게시판(etohumor07) — 🔥인기글 탭(hit_yn=y, 인기 등극 시각 순).
//
// 2026년 개편 후 사이트는 Next.js(App Router) 이고, 예전 주소
// /bbs/board.php?bo_table=etohumor07 은 /b/etohumor07/list 로 리다이렉트된다.
// 목록·본문 모두 서버 렌더링 HTML 안의 RSC 페이로드(self.__next_f.push([1,"..."]))에
// 구조화된 JSON(articleList / article)이 들어 있어서 그것을 우선 파싱하고,
// 형식이 바뀌어 못 찾으면 DOM 을 파싱하는 대체 경로로 내려간다.
//
// - 공지는 RSC 에서 noticeList 로 따로 오고, 목록 DOM 의 "생활관"(다른 게시판 홍보 행)·
//   실시간 인기 사이드바도 articleList 에는 없다.
// - 후방 표시: 말머리(카테고리) "약후" → nsfwHint. 제목의 후방/ㅇㅎ/19금 등 표기도 잡는다.
// - 이미지 CDN(btcdn.etoland.co.kr)은 외부 Referer 면 403, Referer 없음/이토랜드 Referer 면 200.
//   본문 RSC content 의 <img>/<video> 는 원본(/static/media/...) 주소이고 width/height 도 실제 크기와 같다.
//   DOM 쪽 <img src> 는 리사이즈 프록시(/optimize/w_920,.../<원본>)라서 원본 주소로 되돌린다.
//   article.files(JSON 문자열)에 첨부 파일별 실제 크기·영상 포스터가 있어 <video poster> 를 채운다.
// - 댓글: 같은 RSC 페이로드에 commentList(1페이지 = 100개, 대댓글은 childrenComments 로 중첩)·
//   commentListPagination(totalCount)·bestCommentList(추천 6 이상 최대 8개)가 들어 있어 추가 요청이 필요 없다.
//   댓글 내용은 HTML 이스케이프된 텍스트(&#39; 등)라 엔티티를 풀어 준다. 형식이 바뀌면 DOM(#comment-section)에서 읽는다.
import { fetchHtml } from '../lib/http.js';
import { absUrl, cleanText, parseCount, parseKoDate, normalizeMedia } from '../lib/util.js';
import * as cheerio from 'cheerio';

const BASE = 'https://etoland.co.kr';
const BOARD = 'etohumor07';
const CDN_STATIC = 'https://btcdn.etoland.co.kr/static';

const NSFW_CATEGORIES = new Set(['약후', '후방', '성인', '19', '19금']);
const NSFW_TITLE_RE =
  /후방|ㅇㅎ|ㅎㅂ|약후|ㅇㅎㅂ|ㅗㅜㅑ|19금|[([]\s*19\s*[)\]]|18\+|19\+|수위\s*(주의|높)|야짤|노브라|거유|그라비아|비키니|섹시|av\s*배우|엉밑살/i;

const isNsfw = (category, title) =>
  NSFW_CATEGORIES.has(String(category || '').trim()) || NSFW_TITLE_RE.test(String(title || ''));

// ---------- RSC(Flight) 페이로드 도우미 ----------

/** HTML 안의 self.__next_f.push([1,"..."]) 문자열들을 이어 붙인 Flight 텍스트 */
function flightText(html) {
  const re = /<script[^>]*>\s*self\.__next_f\.push\((\[[\s\S]*?\])\)\s*;?\s*<\/script>/g;
  let out = '';
  let m;
  while ((m = re.exec(html))) {
    try {
      const arr = JSON.parse(m[1]);
      if (arr[0] === 1 && typeof arr[1] === 'string') out += arr[1];
    } catch {
      /* 다른 형식의 push 는 무시 */
    }
  }
  return out;
}

/** s[start] 가 '[' 또는 '{' 일 때 짝이 맞는 닫는 괄호의 위치 (문자열 안의 괄호는 무시). 못 찾으면 -1 */
function balancedEnd(s, start) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** s[start] 가 '[' 또는 '{' 일 때 짝이 맞는 끝까지 잘라 JSON.parse */
function parseBalanced(s, start) {
  const end = balancedEnd(s, start);
  if (end < 0) return null;
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** RSC 문자열 값 정리: "$undefined" 등 참조는 null, "$$..." 는 리터럴 "$..." */
function rscStr(v) {
  if (typeof v !== 'string') return v ?? null;
  if (v.startsWith('$$')) return v.slice(1);
  if (v.startsWith('$')) return null;
  return v;
}

/**
 * "$5a" 같은 참조가 가리키는 텍스트 청크를 꺼낸다.
 * Flight 행 형식: 보통 행은 "<hex id>:<payload>\n", 텍스트 행은 "<hex id>:T<hex 바이트길이>,<본문>"(줄바꿈 없음).
 * 길이는 UTF-8 바이트 기준이므로 Buffer 로 순차 파싱한다. 실패하면 정규식으로 한 번 더 찾는다.
 */
function resolveTextChunk(flight, ref) {
  const id = /^\$([0-9a-f]+)$/i.exec(ref || '')?.[1];
  if (!id) return null;
  const buf = Buffer.from(flight, 'utf8');
  let i = 0;
  while (i < buf.length) {
    const colon = buf.indexOf(0x3a, i);
    if (colon < 0) break;
    const rowId = buf.toString('latin1', i, colon);
    if (!/^[0-9a-f]+$/i.test(rowId)) {
      const nl = buf.indexOf(0x0a, i);
      if (nl < 0) break;
      i = nl + 1;
      continue;
    }
    if (buf[colon + 1] === 0x54 /* T */) {
      const comma = buf.indexOf(0x2c, colon);
      const len = parseInt(buf.toString('latin1', colon + 2, comma), 16);
      if (comma < 0 || !Number.isFinite(len)) break;
      if (rowId === id) return buf.toString('utf8', comma + 1, comma + 1 + len);
      i = comma + 1 + len;
    } else {
      const nl = buf.indexOf(0x0a, colon);
      if (nl < 0) break;
      i = nl + 1;
    }
  }
  const m = new RegExp(`(?:^|[^0-9a-f])${id}:T([0-9a-f]+),`, 'i').exec(flight);
  if (!m) return null;
  const start = m.index + m[0].length;
  const len = parseInt(m[1], 16);
  return Buffer.from(flight.slice(start, start + len + 16), 'utf8').subarray(0, len).toString('utf8');
}

/** "$6d" 처럼 다른 JSON 행 전체를 가리키는 참조면 그 행("6d:[...]" / "6d:{...}")을 파싱해 돌려준다 */
function resolveJsonRef(flight, v) {
  const id = typeof v === 'string' ? /^\$([0-9a-f]+)$/i.exec(v)?.[1] : null;
  if (!id) return v;
  const m = new RegExp(`(?:^|\\n)${id}:(?=[[{])`).exec(flight);
  return m ? parseBalanced(flight, m.index + m[0].length) : null;
}

function thumbUrl(p) {
  const v = rscStr(p);
  if (!v) return null;
  if (v.startsWith('/media/')) return `${CDN_STATIC}${v}`;
  return absUrl(v, `${BASE}/`);
}

/** 리사이즈 프록시 주소 https://btcdn.etoland.co.kr/optimize/w_920,format_webp,.../<원본 URL> → 원본 URL */
function unOptimize(u) {
  const m = /^https?:\/\/[^/]*etoland\.co\.kr\/optimize\/[^/]*\/(https?:\/\/.+)$/i.exec(u || '');
  return m ? m[1] : u;
}

/** CDN 경로("/media/...") 또는 URL → 원본 절대 URL */
const mediaUrl = (p) => unOptimize(thumbUrl(p));

/** article.files(JSON 문자열 또는 배열) → Map(원본 절대 URL → 파일 정보) */
function fileMap(a) {
  let list = a?.files;
  if (typeof list === 'string') {
    try {
      list = JSON.parse(list);
    } catch {
      list = null;
    }
  }
  const map = new Map();
  for (const f of Array.isArray(list) ? list : []) {
    if (!f || typeof f !== 'object') continue;
    for (const p of [f.bfFile, f.bfMp4File]) {
      const u = typeof p === 'string' ? mediaUrl(p) : null;
      if (u) map.set(u, f);
    }
  }
  return map;
}

/**
 * 본문 미디어 마무리 (normalizeMedia 뒤에):
 *  - 리사이즈 프록시 주소를 원본으로
 *  - 첨부 파일 정보가 있으면 <video poster> 를 채우고, 실제보다 작게 박힌 width/height 는 실제 크기로
 *  - 실제 크기를 모르는데 width/height 중 하나만 있으면(비율이 깨질 수 있음) 둘 다 지운다
 */
function finishMedia($, $body, files) {
  $body.find('img, video, source').each((_, el) => {
    const $el = $(el);
    for (const attr of ['src', 'poster']) {
      const v = $el.attr(attr);
      if (v && unOptimize(v) !== v) $el.attr(attr, unOptimize(v));
    }
  });
  $body.find('img, video').each((_, el) => {
    const $el = $(el);
    const src = $el.attr('src') || $el.find('source[src]').first().attr('src');
    const f = src ? files.get(src) : null;
    if (el.tagName === 'video' && f && !$el.attr('poster')) {
      const poster = rscStr(f.poster) ? mediaUrl(f.poster) : null;
      if (poster) $el.attr('poster', poster);
    }
    const w = Number($el.attr('width'));
    const h = Number($el.attr('height'));
    if (f && f.bfWidth > 0 && f.bfHeight > 0) {
      if ((w && w < f.bfWidth) || (h && h < f.bfHeight) || (w && h && Math.abs(w / h - f.bfWidth / f.bfHeight) > 0.02)) {
        $el.attr('width', String(f.bfWidth)).attr('height', String(f.bfHeight));
      }
    } else if (!w !== !h) {
      $el.removeAttr('width').removeAttr('height');
    }
  });
}

// ---------- 댓글 ----------

// 삭제·블라인드·비밀 댓글 자리표시 문구 (문구 전체가 이것일 때만)
const DELETED_RE =
  /^\s*[([]?\s*(?:삭제된|(?:관리자|작성자)에\s*의해\s*삭제된|블라인드\s*처리된|신고로\s*숨겨진|차단된\s*회원의|비밀)\s*댓글(?:\s*입니다)?\s*\.?\s*[)\]]?\s*$/;

/** 댓글 내용: HTML 이스케이프된 텍스트(가끔 <br>) → 순수 텍스트 (줄바꿈 유지) */
function commentText(raw) {
  let s = String(raw ?? '').replace(/\r\n?/g, '\n');
  if (/[<&]/.test(s)) {
    const $c = cheerio.load(`<div id="__c">${s}</div>`);
    const $r = $c('#__c');
    $r.find('br').replaceWith('\n');
    $r.find('p, div').each((_, el) => {
      $c(el).append('\n');
    });
    s = $r.text();
  }
  return s
    .replace(/[ \t ]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** RSC 댓글 객체 → Comment (삭제·비밀 댓글이거나 글자·이미지가 모두 없으면 null) */
function mapRscComment(flight, c, { best = false, reply = false } = {}) {
  if (!c || typeof c !== 'object') return null;
  if (c.isSecret === true || c.deleted === true || c.isDeleted === true) return null;
  if (typeof c.status === 'string' && /del|삭제|blind|block|hidden/i.test(c.status)) return null;
  let raw = c.content;
  if (typeof raw === 'string' && /^\$[0-9a-f]+$/i.test(raw)) raw = resolveTextChunk(flight, raw);
  else raw = rscStr(raw);
  const text = commentText(raw);
  if (DELETED_RE.test(text)) return null;
  const images = [];
  const emo = c.emojiItem && typeof c.emojiItem === 'object' ? mediaUrl(c.emojiItem.path) : null;
  if (emo) images.push(emo);
  const f = c.file && typeof c.file === 'object' ? c.file : null;
  if (f) {
    // 영상(움짤→mp4 포함)은 화면이 <img> 만 그리므로 포스터(첫 프레임) 이미지를 넣는다
    const u = f.bfType === 'video' || /^video\//.test(f.bfMime || '') ? mediaUrl(f.poster) : mediaUrl(f.bfFile);
    if (u && !images.includes(u)) images.push(u);
  }
  if (!text && !images.length) return null;
  const member = c.member && typeof c.member === 'object' ? c.member : null;
  return {
    id: c.commentId != null ? String(c.commentId) : null,
    author: c.isAnonymous ? '익명' : cleanText(rscStr(member?.nickname) || '') || null,
    text,
    likes: parseCount(c.recommendCount),
    dislikes: parseCount(c.nogoodCount),
    best,
    reply,
    postedAt: typeof c.writeDateTimestamp === 'number' ? parseKoDate(c.writeDateTimestamp) : null,
    images,
  };
}

/** RSC 에서 이 글의 commentList / commentListPagination / bestCommentList 를 찾는다 */
function commentsDataFromRsc(flight, wrId, a) {
  const KEY = '"commentList":';
  let idx = 0;
  while ((idx = flight.indexOf(KEY, idx)) >= 0) {
    const vStart = idx + KEY.length;
    idx = vStart;
    let list;
    let end;
    if (flight[vStart] === '[') {
      end = balancedEnd(flight, vStart);
      if (end < 0) continue;
      try {
        list = JSON.parse(flight.slice(vStart, end + 1));
      } catch {
        continue;
      }
    } else {
      const ref = /^"(\$[0-9a-f]+)"/i.exec(flight.slice(vStart, vStart + 20));
      if (!ref) continue;
      list = resolveJsonRef(flight, ref[1]);
      end = vStart + ref[0].length - 1;
    }
    if (!Array.isArray(list)) continue;
    if (wrId && list.length && !list.some((c) => String(c?.wrId) === String(wrId))) continue;
    // 같은 props 객체 안에서 바로 뒤따르는 키들: commentListPagination, bestCommentList
    let cur = end + 1;
    const pick = (key, from, maxGap) => {
      const i = flight.indexOf(`"${key}":`, from);
      if (i < 0 || i - from > maxGap) return undefined;
      const j = i + key.length + 3;
      if (flight[j] === '[' || flight[j] === '{') {
        const e = balancedEnd(flight, j);
        if (e < 0) return undefined;
        cur = e + 1;
        try {
          return JSON.parse(flight.slice(j, e + 1));
        } catch {
          return undefined;
        }
      }
      const m = /^"([^"]*)"/.exec(flight.slice(j, j + 40));
      if (m) cur = j + m[0].length;
      return m ? resolveJsonRef(flight, m[1]) : undefined;
    };
    const pagination = pick('commentListPagination', cur, 3000);
    let best = pick('bestCommentList', cur, 3000);
    if (!Array.isArray(best)) {
      // 키 순서가 바뀐 경우: 페이로드 어디든 이 글의 bestCommentList
      best = pick('bestCommentList', 0, Infinity);
      if (Array.isArray(best) && wrId && best.length && !best.some((c) => String(c?.wrId) === String(wrId))) best = [];
    }
    return {
      list,
      best: Array.isArray(best) ? best : [],
      total: parseCount(pagination?.totalCount) ?? parseCount(a?.commentCount),
    };
  }
  return null;
}

const MAX_COMMENTS = 100;

/**
 * 베스트 댓글(앞) + 일반 댓글(사이트 순서, 대댓글은 부모 바로 뒤) — 같은 댓글은 베스트 쪽만 남긴다.
 * 베스트로 올라간 댓글에 달린 대댓글은 베스트 바로 뒤로 옮긴다 (일반 목록에서 부모가 빠지면 엉뚱한 댓글 밑에 붙어 보이므로).
 * flatList 항목은 id·ancestors(조상 댓글 id 목록)를 가진다.
 */
function buildComments(bestList, flatList) {
  const out = [];
  const seen = new Set();
  const bestIds = new Set(bestList.map((c) => c?.id).filter(Boolean));
  const push = (c) => {
    if (!c || out.length >= MAX_COMMENTS || (c.id && seen.has(c.id))) return;
    if (c.id) seen.add(c.id);
    out.push(c);
  };
  for (const b of bestList) {
    push(b);
    if (!b?.id) continue;
    for (const c of flatList) if (c?.ancestors?.includes(b.id) && !bestIds.has(c.id)) push(c);
  }
  for (const c of flatList) push(c);
  return out.map(({ id, ancestors, ...rest }) => rest);
}

function commentsFromRsc(flight, wrId, a) {
  const data = commentsDataFromRsc(flight, wrId, a);
  if (!data) return null;
  const flat = [];
  const walk = (arr, ancestors) => {
    for (const c of Array.isArray(arr) ? arr : []) {
      if (flat.length >= MAX_COMMENTS + 20) return;
      const reply = ancestors.length > 0 || (c?.depth ?? 0) > 0 || c?.parentId != null;
      const m = mapRscComment(flight, c, { reply });
      if (m) flat.push({ ...m, ancestors });
      const id = c?.commentId != null ? String(c.commentId) : null;
      walk(resolveJsonRef(flight, c?.childrenComments), id ? [...ancestors, id] : ancestors);
    }
  };
  walk(data.list, []);
  const best = data.best.map((c) => mapRscComment(flight, c, { best: true })).filter(Boolean);
  return { comments: buildComments(best, flat), total: data.total };
}

/** 대체 경로: 서버 렌더링된 댓글 DOM (#comment-section 안의 #best-comment-<id> / #comment-<id>) */
function commentsFromDom($, baseUrl) {
  const $sec = $('#comment-section').first();
  if (!$sec.length) return null;
  const read = ($w, best) => {
    const idm = /(\d+)$/.exec($w.attr('id') || '');
    const $item = $w.find('.comment-item').first();
    const $text = $w.find('.body-m-reading').first();
    const $content = $text.parent();
    const $t = $text.clone();
    // 대댓글 앞에 붙는 "@부모닉네임" 표시는 화면 장식이라 뺀다
    $t.children('span')
      .filter((__, s) => /^@/.test(cleanText($(s).text())))
      .first()
      .remove();
    // 일반 목록에 다시 나오는 베스트 댓글 앞의 "베플로 선정된 댓글입니다." 표시도 화면 장식
    $t.children('span')
      .filter((__, s) => /^베플로\s*선정된\s*댓글/.test(cleanText($(s).text())))
      .remove();
    $t.find('img').remove();
    $t.find('br').replaceWith('\n');
    // RSC 경로(commentText)와 같은 공백 정리: 줄 끝 공백 제거, 빈 줄은 최대 1줄
    const text = $t
      .text()
      .replace(/\r/g, '')
      .replace(/^\s*\n/, '')
      .replace(/[ \t ]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (DELETED_RE.test(text)) return null;
    const images = [];
    $content.find('img, video').each((__, el) => {
      const $el = $(el);
      if (/프로필|rank|베댓/.test($el.attr('alt') || '')) return;
      const raw = el.tagName === 'video' ? $el.attr('poster') : $el.attr('data-src') || $el.attr('src');
      const u = unOptimize(absUrl(raw, baseUrl));
      if (u && !images.includes(u)) images.push(u);
    });
    if (!text && !images.length) return null;
    const timeText = cleanText($w.find('time').first().text() || $w.find('.text-etoText-2, .text-etoText-3').first().text());
    return {
      id: idm ? idm[1] : null,
      author: cleanText($w.find('.nickname').first().text()) || null,
      text,
      likes: parseCount($w.find('.good-count').first().text()) ?? 0,
      // 화면에는 "반대" 글자만 나오고 숫자가 없을 때가 많다 (RSC 에는 nogoodCount 가 있음) → 모르면 null
      dislikes: parseCount($w.find('.nogood-count').first().text()),
      best,
      reply: !best && /\bml-(?!0\b)\d/.test($item.attr('class') || ''),
      postedAt: parseKoDate(timeText.replace(/\([^)]*\)/g, ' ')),
      images,
    };
  };
  const best = $sec
    .find('[id^="best-comment-"]')
    .map((_, el) => read($(el), true))
    .get()
    .filter(Boolean);
  // 들여쓰기(ml-4 = 1단, ml-8 = 2단 …)로 조상 댓글을 추적한다 (삭제돼 빠진 댓글도 조상으로는 남김)
  const stack = [];
  const flat = [];
  $sec
    .find('[id^="comment-"]')
    .filter((_, el) => /^comment-\d+$/.test($(el).attr('id') || ''))
    .each((_, el) => {
      const $w = $(el);
      const id = /(\d+)$/.exec($w.attr('id'))[1];
      const ml = /\bml-(\d+)\b/.exec($w.find('.comment-item').first().attr('class') || '');
      const depth = ml ? Math.round(Number(ml[1]) / 4) : 0;
      stack.length = Math.min(stack.length, depth);
      const ancestors = stack.filter(Boolean);
      stack[depth] = id;
      const c = read($w, false);
      if (c) flat.push({ ...c, ancestors });
    });
  const total = parseCount($sec.find('#comment-header b').first().text());
  return { comments: buildComments(best, flat), total };
}

const postUrl = (slug, wrId) =>
  slug ? `${BASE}/b/${BOARD}/view/${encodeURIComponent(slug)}` : `${BASE}/b/${BOARD}/article/${wrId}`;

// ---------- 목록 ----------

function listFromRsc(flight, page) {
  const KEY = '"articleList":[';
  let idx = 0;
  let fallback = null;
  while ((idx = flight.indexOf(KEY, idx)) >= 0) {
    const pre = flight.slice(Math.max(0, idx - 800), idx);
    const arr = parseBalanced(flight, idx + KEY.length - 1);
    idx += KEY.length;
    if (!Array.isArray(arr)) continue;
    if (pre.includes(`"bo_table_list":"${BOARD}"`)) {
      const pm = /"page":(\d+)/.exec(pre);
      if (!pm || Number(pm[1]) === page) return arr;
    }
    if (!fallback && arr.some((a) => a && a.boTable === BOARD)) fallback = arr;
  }
  return fallback;
}

function mapRscItem(a) {
  if (!a || typeof a !== 'object') return null;
  if (a.boTable && a.boTable !== BOARD) return null;
  if (a.isNotice === true || a.isSecret === true) return null;
  const wrId = a.wrId != null ? String(a.wrId) : null;
  const title = cleanText(rscStr(a.subject) || '');
  const category = rscStr(a.category);
  if (!wrId || !title || category === '공지') return null;
  const member = a.member && typeof a.member === 'object' ? a.member : null;
  return {
    postId: wrId,
    title,
    url: postUrl(rscStr(a.slug), wrId),
    author: a.isAnonymous ? '익명' : cleanText(rscStr(member?.nickname) || '') || null,
    postedAt: typeof a.writeDateTimestamp === 'number' ? parseKoDate(a.writeDateTimestamp) : null,
    commentCount: parseCount(a.commentCount),
    views: parseCount(a.viewCount),
    likes: parseCount(a.recommendCount),
    category: category || null,
    nsfwHint: isNsfw(category, title),
    thumbnail: thumbUrl(a.thumbnail),
  };
}

/** 목록 DOM 의 날짜 칸: "00:17"(오늘) / "10-15"(올해) / "2025-12-31" */
const DATE_CELL_RE = /^(?:\d{1,2}:\d{2}|\d{1,2}[-./]\d{1,2}|\d{2,4}[-./]\d{1,2}[-./]\d{1,2})$/;

/**
 * 대체 경로: 목록 DOM. (인기글 탭에서 날짜 칸은 인기 등극 시각이라 postedAt 이 조금 늦게 잡힌다)
 * 행 = <li> 의 직계 div 칸: [글번호][말머리 링크][제목+댓글수][작성자][날짜][추천][조회].
 * Tailwind 폭 클래스(w-11 등)는 디자인 수정에 쉽게 바뀌므로 말머리 링크·.text-good·날짜 모양으로 먼저 찾고
 * 폭 클래스는 마지막 대체로만 쓴다.
 */
function listFromDom($, baseUrl) {
  const items = [];
  $('li').each((_, li) => {
    const $li = $(li);
    const $cells = $li.children('div');
    if (!/^\d+$/.test(cleanText($cells.first().text()))) return; // 공지(아이콘)·생활관·순위 사이드바 제외
    const $a = $li
      .find(`a[href*="/b/${BOARD}/view/"]`)
      .filter((__, el) => !/#comment/.test($(el).attr('href') || ''))
      .first();
    const href = absUrl($a.attr('href'), baseUrl);
    const postId = /-(\d+)(?:[?#]|$)/.exec(href || '')?.[1];
    if (!href || !postId) return;
    const category =
      cleanText($li.find('a[href*="category="]').first().text()) || cleanText($cells.eq(1).text()) || null;
    if (category === '공지') return;
    const title = cleanText($a.text()).replace(/\s*\[\d+\]\s*$/, '');
    const u = new URL(href);
    const texts = $cells.map((__, d) => cleanText($(d).text())).get();
    const di = texts.findIndex((t, i) => i > 0 && DATE_CELL_RE.test(t)); // 날짜 칸 위치 (다음 칸 추천, 그다음 조회)
    const cell = (k) => (di > 0 ? texts[di + k] || '' : '');
    items.push({
      postId,
      title,
      url: `${BASE}${u.pathname}`,
      author: cleanText($li.find('.nickname').first().text()) || null,
      postedAt: parseKoDate(cell(0) || cleanText($li.find('div.w-11').first().text())),
      commentCount: parseCount($li.find('a[href*="#comment"]').first().text()) ?? 0,
      views: parseCount(cell(2) || $li.find('div.w-12').first().text()),
      likes: parseCount(cleanText($li.find('.text-good').first().text()) || cell(1) || $li.find('div.w-8').first().text()),
      category,
      nsfwHint: isNsfw(category, title),
      thumbnail: null,
    });
  });
  return items;
}

// ---------- 본문 ----------

function articleFromRsc(flight, wrId) {
  const KEY = '"article":{"wrId":';
  let idx = wrId ? flight.indexOf(`"article":{"wrId":${wrId},`) : -1;
  if (idx < 0) idx = flight.indexOf(KEY);
  if (idx < 0) return null;
  return parseBalanced(flight, idx + '"article":'.length);
}

/** 대체 경로에서 쓰는: 사이트 자체 비디오 플레이어 UI 를 단순 <video> 로 바꾼다 */
function simplifyDomVideos($, $body) {
  $body.find('.content-video-wrapper').each((_, w) => {
    const $w = $(w);
    const $v = $w.find('video').first();
    const src = $v.attr('src') || $v.attr('data-src') || $v.find('source').attr('src');
    if (!src) return;
    $w.replaceWith($('<video controls playsinline preload="metadata"></video>').attr('src', src));
  });
  $body.find('button, svg').remove();
}

export default {
  id: 'etoland',
  name: '이토랜드 유머게시판 인기글',
  short: '이토',
  color: '#2e7d32',
  homepage: `${BASE}/b/${BOARD}/list?hit_yn=y`,
  domains: ['etoland.co.kr'],
  imageHosts: ['etoland.co.kr', 'img.youtube.com', 'ytimg.com'],
  referer: `${BASE}/`,
  strictness: 'strict',
  disabled: false,
  disabledReason: null,

  async list(page = 1) {
    const { $, text, url } = await fetchHtml(`${BASE}/b/${BOARD}/list?hit_yn=y&page=${page}`, {
      referer: `${BASE}/b/${BOARD}/list`,
    });
    const flight = flightText(text);
    const raw = listFromRsc(flight, page);
    let items = raw ? raw.map(mapRscItem).filter(Boolean) : [];
    if (!items.length) items = listFromDom($, url);
    const seen = new Set();
    return items.filter((it) => (seen.has(it.postId) ? false : seen.add(it.postId)));
  },

  async read(postUrlIn) {
    const wrId = /-(\d+)(?:[/?#]|$)/.exec(postUrlIn)?.[1] || /\/(\d+)(?:[/?#]|$)/.exec(postUrlIn)?.[1] || null;
    const { $, text, url } = await fetchHtml(postUrlIn, { referer: `${BASE}/b/${BOARD}/list?hit_yn=y` });
    const flight = flightText(text);
    const a = articleFromRsc(flight, wrId);

    let contentHtml = null;
    if (a) {
      const c = a.content;
      if (typeof c === 'string') contentHtml = /^\$[0-9a-f]+$/i.test(c) ? resolveTextChunk(flight, c) : rscStr(c);
    }

    const files = fileMap(a);
    let html = '';
    if (contentHtml != null) {
      const $c = cheerio.load(`<div id="__eto_body">${contentHtml}</div>`);
      const $body = $c('#__eto_body');
      $body.find('script, style, noscript').remove();
      normalizeMedia($c, $body, url);
      finishMedia($c, $body, files);
      html = ($body.html() || '').trim();
    } else {
      const $body = $('.view-content').first();
      $body.find('script, style, noscript').remove();
      simplifyDomVideos($, $body);
      normalizeMedia($, $body, url);
      finishMedia($, $body, files);
      html = ($body.html() || '').trim();
      // 클라우드에서 가끔 본문·댓글이 없는 페이지를 받는다 (PC 에서는 멀쩡함) — 원인을 알 수 있게 받은 페이지의 모양을 남긴다
      if (!html) console.warn(`[etoland] 본문 없음 ${wrId || ''}: ${text.length}자, RSC ${flight.length}자, article ${a ? '있음' : '없음'}, <title> ${cleanText($('title').first().text()).slice(0, 60)}`);
    }

    // 댓글: RSC 우선, 못 찾으면 DOM. 실패해도 본문은 돌려준다.
    let cm = null;
    try {
      cm = (a?.hideComment !== true && commentsFromRsc(flight, wrId, a)) || null;
    } catch {
      cm = null;
    }
    if (!cm || (!cm.comments.length && (cm.total ?? 0) > 0)) {
      try {
        const d = commentsFromDom($, url);
        if (d && (d.comments.length || !cm)) cm = d;
      } catch {
        /* 댓글 DOM 형식이 바뀐 경우 — 댓글 없이 진행 */
      }
    }

    const $art = $('article')
      .filter((_, e) => $(e).find('.view-content, #view-header').length > 0)
      .first();
    const title = cleanText(rscStr(a?.subject) || $art.find('h1').first().text() || $('h1').first().text());
    // 대체 경로: 제목 앞의 "[약후]" 같은 말머리
    const category =
      rscStr(a?.category) || cleanText($art.find('h1').first().prev('span').text()).replace(/^\[|\]$/g, '') || null;
    const member = a?.member && typeof a.member === 'object' ? a.member : null;
    const author = a?.isAnonymous
      ? '익명'
      : cleanText(rscStr(member?.nickname) || $art.find('.nickname').first().text()) || null;
    let postedAt = typeof a?.writeDateTimestamp === 'number' ? parseKoDate(a.writeDateTimestamp) : null;
    if (!postedAt) {
      // "2026-10-16 (금) 18:08" → 요일 제거 후 해석
      const d = /(\d{4}-\d{2}-\d{2})\s*(?:\([^)]*\))?\s*(\d{1,2}:\d{2})?/.exec($art.text());
      if (d) postedAt = parseKoDate(`${d[1]} ${d[2] || ''}`.trim());
    }

    return {
      title,
      html,
      author,
      postedAt,
      nsfwHint: isNsfw(category, title),
      comments: cm?.comments || [],
      commentTotal: cm?.total ?? parseCount(a?.commentCount) ?? null,
    };
  },
};
