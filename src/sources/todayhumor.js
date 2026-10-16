// 오늘의유머(todayhumor.co.kr) — "오늘의 베스트(humorbest)" 중 원게시판이 유머자료(humordata)인 글만.
//
// - 목록: /board/list.php?table=humorbest&kind=humorbest_sort&o_table=humordata&page=N
//   humorbest 는 모든 게시판의 베스트를 모으므로 시사(sisa)·소설(soda) 등이 섞인다. 사이트가 제공하는
//   "원게시판별 정렬"(kind=humorbest_sort&o_table=humordata) 로 유머자료 출신 베스트만 받는다.
//   그래도 혹시 섞여 들어오면 행 클래스(list_tr_<원게시판>) 로 한 번 더 거른다.
// - 목록 날짜는 "베스트 등록시간"(yy/mm/dd HH:MM, KST). 본문의 postedAt 은 "원글작성시간".
// - 사이트에는 후방/19 전용 표시(아이콘·옵션)가 없다. 작성자들이 제목 앞에 "ㅇㅎ)", "후방주의" 등을
//   붙이는 관례만 있어 제목 패턴으로 nsfwHint 를 잡는다.
// - 이미지·움짤(mp4)은 thimg.todayhumor.co.kr. 외부 Referer 면 302(핫링크 차단), Referer 없음/오유 Referer 면 200.
//   펌글 영상은 movie.bobaedream.co.kr 를 직접 거는 경우가 있다(Referer 검사 없음).
// - robots.txt: www 는 404(규칙 없음). thimg 는 "Disallow: /", m.todayhumor 는 *.jpg/gif/png Disallow.
// - 댓글: 글 HTML 에는 없고(<div id='memoContainerDiv'></div> 만 있음) 페이지 로드 후 common.js 의 loadMoreReply() 가
//   GET /board/ajax_memo_list.php?parent_table=<원게시판>&parent_id=<원글번호>&last_memo_no=0 (JSON, 토큰 없음,
//   jQuery 라 X-Requested-With: XMLHttpRequest) 로 받아 그린다. parent_table/parent_id 는 글 페이지의 인라인 스크립트
//   변수(var parent_table = "humordata"; var parent_id = "2061590";) — 베스트 복사본(humorbest/bestofbest)도 원글의 댓글을 쓴다.
//   www 의 robots.txt 는 404(규칙 없음)라 이 경로를 막지 않는다.
//   응답: {is_more_memo: "true"|"false", memos: [{no, parent_memo_no, is_system, is_del, is_nok, is_anonymous, date,
//   name, ok, nok, memo(HTML)}]} — 한 번에 최대 200개(memo_count_limit), 번호(작성) 순. 대댓글(parent_memo_no>0)은
//   사이트에서 부모 댓글 묶음 안에 붙는다(깊이 1). is_system 은 "베스트 게시판으로 복사되었습니다" 안내,
//   is_del 은 "[본인삭제]" 자리. 글 머리의 "댓글 : N개" 는 이 둘을 뺀 수와 같다.
//   오유에는 따로 모아 보여주는 베스트 댓글이 없다(추천 3 이상이면 배경색만 바뀜) → best 는 쓰지 않는다.
// - 본문 이미지는 원본 그대로(thimg upfile, 파일명에 __w<가로>__h<세로>__ 가 박혀 있고 실제 크기와 같음).
//   width/height 속성도 원본 크기와 같다. 축소판/지연로딩/접기 없음.
import { fetchHtml, fetchJson } from '../lib/http.js';
import { absUrl, cleanText, parseCount, parseKoDate, normalizeMedia } from '../lib/util.js';

const BASE = 'https://www.todayhumor.co.kr';
const LIST_TABLE = 'humorbest';
const ORIGIN_BOARD = 'humordata'; // 유머자료

// 작성자들이 제목에 붙이는 후방/성인 표시.
// "후방" 은 말머리 자리("후방)", "[후방]", "(후방)", 제목 끝)이거나 "후방주의/조심" 일 때만 잡는다 —
// 오유 베스트에 자주 오르는 한문철 블랙박스 글의 "후방추돌", "후방카메라", "전후방" 은 오탐하지 않도록.
// "약후" 는 앞에 한글이 붙으면("계약후", "예약후") 제외, "19금"/"[19]" 은 "2019" 같은 숫자 안이면 제외.
const NSFW_RE =
  /ㅇㅎ|ㅎㅂ|(?<![가-힣])약후|므흣|(?<!\d)19금|ㅗㅜㅑ|(?<!전)후방\s*(?:주의|조심|ㅈㅇ)|(?:^|[\s([【{<])후방(?=\s*(?:[)\]】}>:]|$))|[([【{<]\s*19\s*\+?\s*[)\]】}>]|^\s*19\s*\+?\s*[)\]】]/;
// 유머가 아닌 정기 홍보글 (예: "[10/15(목) 베스트모음] ..." — 외부 사이트 링크 모음, 일베·루리웹 링크 포함)
const SKIP_TITLE_RE = /^\s*\[[^\]]*베스트\s*모음\s*\]/;

function postUrl(no, table = LIST_TABLE) {
  return `${BASE}/board/view.php?table=${table}&no=${no}`;
}

function listUrl(page) {
  return `${BASE}/board/list.php?table=${LIST_TABLE}&page=${page}&kind=humorbest_sort&o_table=${ORIGIN_BOARD}`;
}

const MAX_COMMENTS = 100;
const GIF_MAX_BYTES = 5_000_000; // 댓글 움짤: 이보다 큰 GIF 원본은 첫 프레임(poster)으로

/** 글 페이지 인라인 스크립트의 `var name = "값";` */
function pageVar(text, name) {
  return new RegExp(`var\\s+${name}\\s*=\\s*"([^"]*)"`).exec(text || '')?.[1] ?? null;
}

/**
 * 본문 img/video 의 width·height 속성이 원본보다 작거나 비율이 다르면 지운다 (미리보기에서 작게/찌그러져 보이지 않게).
 * thimg upfile 은 파일명에 원본 크기(__w1012__h11713__)가 들어 있어 그것과 비교한다. 원본 크기를 모르면 건드리지 않는다.
 */
function fixMediaSize($, $root) {
  $root.find('img, video').each((_, el) => {
    const $el = $(el);
    const w = Number($el.attr('width')) || 0;
    const h = Number($el.attr('height')) || 0;
    if (!w && !h) return;
    const ref = el.tagName === 'video' ? $el.attr('poster') || $el.find('source[src]').attr('src') : $el.attr('src');
    const m = /__w(\d+)__h(\d+)__/.exec(ref || '');
    if (!m) return;
    const W = Number(m[1]);
    const H = Number(m[2]);
    if (!W || !H) return;
    const smaller = (w && w < W) || (h && h < H);
    const skewed = w && h && Math.abs(w / h - W / H) > 0.02 * (W / H);
    if (smaller || skewed) $el.removeAttr('width').removeAttr('height');
  });
}

/** 댓글 HTML → {text, images} (줄바꿈은 <br>·블록 기준, 원문 개행 문자는 HTML 공백으로 취급) */
function memoContent($, html) {
  const $d = $('<div></div>').html(String(html || '').replace(/\r?\n/g, ' '));
  const images = [];
  $d.find('img, video').each((_, el) => {
    const $el = $(el);
    let u = null;
    if (el.tagName === 'video') {
      // 움짤: <video poster=…jpg><source src=…mp4><a href=…gif>GIF 원본 보기</a></video>.
      // 댓글 짤은 화면에서 <img> 로 그리므로 움직이는 GIF 원본을 쓴다. 다만 GIF 원본은 수 MB~10MB 라
      // 파일명의 원본 크기(__f<바이트>__)가 GIF_MAX_BYTES 를 넘으면 poster(첫 프레임 jpg)로 대신한다.
      const gif = $el
        .find('a[href]')
        .map((__, a) => $(a).attr('href'))
        .get()
        .find((href) => /\.gif(?:$|\?)/i.test(href));
      const gifBytes = Number(/__f(\d+)__/.exec(gif || '')?.[1] || 0);
      u = (gif && gifBytes <= GIF_MAX_BYTES ? gif : null) || $el.attr('poster') || gif || null;
    } else {
      u = $el.attr('src') || $el.attr('data-original') || null;
    }
    const abs = u && !/^data:/.test(u) ? absUrl(u, BASE) : null;
    if (abs && !images.includes(abs)) images.push(abs);
  });
  $d.find('img, video, iframe, script, style').remove();
  $d.find('br').replaceWith('\n');
  $d.find('p, div, li, blockquote').each((_, el) => {
    $(el).append('\n');
  });
  const text = $d
    .text()
    .replace(/\u00a0/g, ' ')
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text, images };
}

/** ajax_memo_list.php 응답 → Comment[] (사이트 표시 순서: 댓글 다음에 그 대댓글들) */
function parseMemos($, memos) {
  if (!Array.isArray(memos)) return [];
  const byNo = new Map(memos.map((m) => [String(m.no), m]));
  const rootOf = (m) => {
    let cur = m;
    for (let i = 0; i < 10 && Number(cur.parent_memo_no) > 0; i++) {
      const p = byNo.get(String(cur.parent_memo_no));
      if (!p) break;
      cur = p;
    }
    return cur;
  };
  const threads = new Map(); // 루트 댓글 번호 -> [memo...]
  for (const m of memos) {
    if (!m || typeof m !== 'object') continue;
    const root = Number(m.parent_memo_no) > 0 ? rootOf(m) : m;
    const key = String(root.no);
    if (!threads.has(key)) threads.set(key, []);
    threads.get(key).push(m);
  }
  const out = [];
  for (const list of threads.values()) {
    for (const m of list) {
      if (m.is_system || m.is_del) continue; // 베스트 이동 안내 / 삭제된 댓글
      const likes = parseCount(m.ok) ?? 0;
      const dislikes = parseCount(m.nok) ?? 0;
      let { text, images } = memoContent($, m.memo);
      // 사이트는 비공감이 많은(비공감 3 이상, 추천/비공감 < 0.5) 댓글의 이미지를 가린다 → 이미지 빼기
      if (dislikes >= 3 && likes / dislikes < 0.5) images = [];
      if (!text && !images.length) continue;
      if (/^삭제된\s*댓글입니다\.?$/.test(text)) continue;
      // 사이트는 name 을 HTML 로 끼워 넣는다(common.js) → 엔티티(&amp; 등)를 풀어 화면과 같은 글자로
      const name = cleanText($('<i></i>').html(String(m.name ?? '')).text()) || null;
      out.push({
        author: m.is_nok ? '[비공감]' : m.is_anonymous ? `익명${name || ''}` : name,
        text,
        likes,
        dislikes,
        best: false,
        reply: Number(m.parent_memo_no) > 0,
        postedAt: parseKoDate(m.date || null),
        images,
      });
      if (out.length >= MAX_COMMENTS) return out;
    }
  }
  return out;
}

/** view.php URL / 짧은 주소(todayhumor.com/?humorbest_123) 에서 table·no 추출 */
function parsePostRef(u) {
  try {
    const url = new URL(u);
    const table = url.searchParams.get('table');
    const no = url.searchParams.get('no');
    if (table && /^\d+$/.test(no || '')) return { table, no };
    const m = /^\??([a-z0-9_]+)_(\d+)$/i.exec(url.search);
    if (m) return { table: m[1], no: m[2] };
  } catch {
    /* noop */
  }
  return null;
}

export default {
  id: 'todayhumor',
  name: '오늘의유머 유머자료 베스트',
  short: '오유',
  color: '#2c5161', // 오유 하단 바/브랜드 남청색
  homepage: `${BASE}/board/list.php?kind=humorbest_sort&o_table=${ORIGIN_BOARD}`,
  domains: ['todayhumor.co.kr'],
  // thimg.todayhumor.co.kr (이미지·움짤 mp4·poster). 펌글은 영상을 보배드림에서 그대로 걸어오는 경우가 있다
  // (<video><source src="https://movie.bobaedream.co.kr/bobae-movie/...mp4">, 예: humorbest 1798483).
  // movie.bobaedream.co.kr 은 Referer 없음/오유/외부 모두 206 video/mp4 로 응답(핫링크 차단 없음).
  imageHosts: ['todayhumor.co.kr', 'bobaedream.co.kr'],
  referer: `${BASE}/`,
  strictness: 'strict',
  disabled: false,
  disabledReason: null,

  async list(page = 1) {
    const { $, url } = await fetchHtml(listUrl(page), { referer: `${BASE}/` });
    const items = [];
    const seen = new Set();
    $('table.table_list tbody tr.view').each((_, tr) => {
      const $tr = $(tr);
      // 원게시판 확인 (list_tr_humordata). 다른 게시판 출신(시사 등)은 버린다.
      const cls = $tr.attr('class') || '';
      const origin = /list_tr_([a-z0-9_]+)/i.exec(cls)?.[1] || null;
      if (origin && origin !== ORIGIN_BOARD) return;

      const $a = $tr.find('td.subject > a').first();
      const href = absUrl($a.attr('href'), url);
      const ref = href ? parsePostRef(href) : null;
      const postId = ref?.no || cleanText($tr.find('td.no').text());
      if (!postId || !/^\d+$/.test(postId) || seen.has(postId)) return;

      const title = cleanText($a.text()).replace(/\s*\[\d+\]\s*$/, '');
      if (!title || SKIP_TITLE_RE.test(title)) return;
      seen.add(postId);

      const tag = $tr
        .find('td.subject img[alt]')
        .map((__, el) => $(el).attr('alt'))
        .get()
        .find((a) => /펌글|창작글/.test(a));
      const author =
        cleanText($tr.find('td.name a').first().text()) || cleanText($tr.find('td.name').text()) || null;
      // 추천 칸은 "33" 또는 "33/8"(추천/반대) 형태
      const likes = parseCount(cleanText($tr.find('td.oknok').text()).split('/')[0]);

      items.push({
        postId,
        title,
        url: postUrl(postId, ref?.table || LIST_TABLE),
        author,
        postedAt: parseKoDate($tr.find('td.date').text()),
        commentCount: parseCount($tr.find('.list_memo_count_span').text()) ?? 0,
        views: parseCount($tr.find('td.hits').text()),
        likes,
        category: tag || null,
        nsfwHint: NSFW_RE.test(title),
        thumbnail: null,
      });
    });
    return items;
  },

  async read(inputUrl) {
    const ref = parsePostRef(inputUrl);
    const target = ref ? postUrl(ref.no, ref.table) : inputUrl;
    const { $, url, text: rawHtml } = await fetchHtml(target, { referer: listUrl(1) });

    const $subj = $('.viewSubjectDiv').first().clone();
    $subj.find('img, span.board_icon_mini').remove();
    const title = cleanText($subj.text());

    const $body = $('.viewContent').first();
    $body.find('script, style, ins.adsbygoogle, .ad_adsense, iframe[src*="googlesyndication"], iframe[src*="doubleclick"]').remove();
    // 움짤은 <video class="anigif_html5_video" poster=…><source src=….mp4></video> — normalizeMedia 가 src·poster 정리
    normalizeMedia($, $body, url);
    fixMediaSize($, $body);

    const author =
      cleanText($('#viewPageWriterNameSpan').attr('name')) ||
      cleanText($('#viewPageWriterNameSpan b').first().text()) ||
      null;

    const info = cleanText($('.writerInfoContents').text());
    const written = /원글작성시간\s*:\s*([\d/:\s]+?\d{2}:\d{2}(?::\d{2})?)/.exec(info)?.[1];
    const bested = /등록시간\s*:\s*([\d/:\s]+?\d{2}:\d{2}(?::\d{2})?)/.exec(info)?.[1];

    // 댓글: 글 머리의 "댓글 : N개" 가 0 이면 요청하지 않는다. 전체 블라인드(is_blind_all_memo) 글은 사이트도 안 보여준다.
    const shownTotal = parseCount(/댓글\s*:\s*([\d,]+)\s*개/.exec(info)?.[1] ?? null);
    let comments = [];
    let commentTotal = shownTotal;
    const blindAll = /var\s+is_blind_all_memo\s*=\s*true/.test(rawHtml || '');
    const parentTable = pageVar(rawHtml, 'parent_table') || ref?.table || null;
    const parentId = pageVar(rawHtml, 'parent_id') || ref?.no || null;
    if (blindAll) {
      commentTotal = shownTotal ?? 0;
    } else if (shownTotal !== 0 && parentTable && /^[a-z0-9_]+$/i.test(parentTable) && /^\d+$/.test(parentId || '')) {
      try {
        const data = await fetchJson(
          `${BASE}/board/ajax_memo_list.php?parent_table=${parentTable}&parent_id=${parentId}&last_memo_no=0`,
          { referer: url, headers: { 'x-requested-with': 'XMLHttpRequest' }, retries: 1 },
        );
        const memos = Array.isArray(data?.memos) ? data.memos : [];
        comments = parseMemos($, memos);
        if (commentTotal == null && data?.is_more_memo !== 'true') {
          commentTotal = memos.filter((m) => m && !m.is_system && !m.is_del).length;
        }
      } catch {
        comments = []; // 댓글을 못 받아도 본문은 보여준다
      }
    }

    return {
      title,
      html: $body.html() || '',
      author,
      postedAt: parseKoDate(written || bested || null),
      nsfwHint: NSFW_RE.test(title),
      comments,
      commentTotal: commentTotal ?? null,
    };
  },
};
