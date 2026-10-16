// 소스(커뮤니티 게시판) 어댑터 규약 + 예시 뼈대.
// 파일 이름이 `_` 로 시작하면 레지스트리(index.js)가 무시한다. 새 소스는 `src/sources/<id>.js` 로 만든다.
//
// export default {
//   id: 'example',                       // 고유 ID. [a-z0-9]+, 파일 이름과 같아야 함
//   name: '예시커뮤니티 유머게시판',        // 전체 표시 이름
//   short: '예시',                        // 게시물 옆 배지에 쓰는 2~4글자
//   color: '#3b82f6',                    // 배지 배경색 (흰 글씨가 잘 보일 것)
//   homepage: 'https://example.com/humor', // 사람이 보는 게시판 목록 URL
//   domains: ['example.com'],            // 게시물 URL 호스트 (접미사 일치)
//   imageHosts: ['example.com', 'img.example.net'], // 이미지 프록시 허용 호스트 (접미사 일치)
//   referer: 'https://example.com/',     // 이미지를 프록시로 가져올 때 보낼 Referer (핫링크 차단 우회)
//   strictness: 'normal',                // 'normal' | 'strict' — 정치/혐오글이 많이 섞이는 소스는 'strict'
//   disabled: false,                     // 안정적으로 수집할 수 없으면 true + disabledReason
//   disabledReason: null,
//   async list(page = 1) { ... },        // → ListItem[]  (게시판 목록 page 번째 페이지, 공지/광고 제외)
//   async read(url) { ... },             // → Article     (본문만)
// }
//
// ListItem = {
//   postId: string,              // 사이트 내 글 번호 (문자열)
//   title: string,               // 제목 (댓글 수 "[12]" 같은 꼬리표 제거, cleanText 적용)
//   url: string,                 // 절대 URL, 정규화된(불필요한 page/검색 파라미터 없는) 글 주소
//   author?: string|null,
//   postedAt?: string|null,      // ISO 문자열 — parseKoDate() 사용
//   commentCount?: number|null,
//   views?: number|null,
//   likes?: number|null,         // 추천 수
//   category?: string|null,      // 사이트 말머리/카테고리 텍스트 그대로
//   nsfwHint?: boolean,          // 사이트가 후방/19/ㅇㅎ/약후 등으로 표시한 경우 true
//   thumbnail?: string|null,     // 목록 썸네일 절대 URL (있으면)
// }
//
// Article = {
//   title: string,
//   html: string,                // 본문 영역의 inner HTML 만 (댓글/광고/서명/추천 버튼 제외).
//                                // normalizeMedia() 로 지연로딩 이미지·영상의 실제 주소를 src 에 넣고 절대 URL 로.
//   author?: string|null,
//   postedAt?: string|null,
//   nsfwHint?: boolean,
//   comments?: Comment[],        // 댓글 (선택이지만 가능하면 채울 것 — 쇼츠에서 "댓글 반응"이 핵심 소재).
//                                // 베스트 댓글이 있으면 앞에(best:true), 그다음 일반 댓글을 사이트 순서대로. 최대 100개.
//                                // 댓글이 AJAX 로 따로 오면 그 요청까지 해서 가져온다 (요청 1~2회 추가까지 허용).
//   commentTotal?: number|null,  // 사이트에 표시된 전체 댓글 수
// }
//
// Comment = {
//   author: string|null,
//   text: string,                // 순수 텍스트. 줄바꿈은 \n. 삭제된 댓글은 넣지 않는다.
//   likes?: number|null,         // 추천/공감
//   dislikes?: number|null,
//   best?: boolean,              // 베스트/인기 댓글
//   reply?: boolean,             // 대댓글(답글)
//   postedAt?: string|null,      // ISO
//   images?: string[],           // 댓글에 붙은 짤·디시콘 등 절대 URL (imageHosts 에 호스트 포함)
// }
//
// 공용 도우미:
//   import { fetchHtml, fetchText, fetchJson, fetchRaw, setCookie } from '../lib/http.js';
//   import { absUrl, cleanText, parseCount, parseKoDate, normalizeMedia } from '../lib/util.js';
// fetchHtml 은 호스트별 요청 간격(기본 1.2초)·쿠키·문자셋(EUC-KR 등)·재시도를 처리한다.
// 검증: node scripts/test-source.js <id>

import { fetchHtml } from '../lib/http.js';
import { absUrl, cleanText, parseCount, parseKoDate, normalizeMedia } from '../lib/util.js';

const BASE = 'https://example.com';

export default {
  id: 'example',
  name: '예시커뮤니티 유머게시판',
  short: '예시',
  color: '#64748b',
  homepage: `${BASE}/humor`,
  domains: ['example.com'],
  imageHosts: ['example.com'],
  referer: `${BASE}/`,
  strictness: 'normal',
  disabled: true,
  disabledReason: '템플릿',

  async list(page = 1) {
    const { $, url } = await fetchHtml(`${BASE}/humor?page=${page}`);
    const items = [];
    $('table.board tbody tr').each((_, tr) => {
      const $tr = $(tr);
      if ($tr.hasClass('notice')) return;
      const $a = $tr.find('td.title a').first();
      const href = absUrl($a.attr('href'), url);
      const postId = /\/(\d+)/.exec(href || '')?.[1];
      if (!href || !postId) return;
      items.push({
        postId,
        title: cleanText($a.text()),
        url: `${BASE}/humor/${postId}`,
        author: cleanText($tr.find('td.author').text()) || null,
        postedAt: parseKoDate($tr.find('td.date').text()),
        commentCount: parseCount($tr.find('.comment-count').text()),
        views: parseCount($tr.find('td.views').text()),
        likes: parseCount($tr.find('td.likes').text()),
        category: null,
        nsfwHint: false,
        thumbnail: null,
      });
    });
    return items;
  },

  async read(postUrl) {
    const { $, url } = await fetchHtml(postUrl);
    const $body = $('.post-content').first();
    normalizeMedia($, $body, url);
    return {
      title: cleanText($('h1.title').text()),
      html: $body.html() || '',
      author: null,
      postedAt: null,
    };
  },
};
