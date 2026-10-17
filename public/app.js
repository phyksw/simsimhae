// 브루잉 프런트엔드 (의존성 없는 바닐라 JS). 본문 HTML 외에는 innerHTML 을 쓰지 않는다.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** 작은 DOM 도우미: h('div', {class: 'x', onclick}, '텍스트', childEl) */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
/** replaceChildren/append 는 null·false 를 "null"·"false" 글자로 넣는다. 조건부 자식(cond ? el : null, admin && el)은 이걸로 거른다 */
const kids = (...xs) => xs.flat().filter((c) => c !== null && c !== undefined && c !== false);

const store = {
  get(k, d) {
    try {
      const v = localStorage.getItem(k);
      return v === null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {}
  },
};

/** 미리보기 보기 크기 단계(%). 저장된 값이 이 목록에 없으면(옛 값·잘못된 값) 100 */
const READER_ZOOMS = [50, 60, 70, 80, 90, 100, 115, 130, 150];
const readerZoomOf = (v) => (READER_ZOOMS.includes(v) ? v : 100);

const state = {
  meta: null,
  sources: {},
  board: 'story',
  sort: 'new',
  q: '',
  stage: '',
  hasMore: false,
  loading: false,
  total: 0,
  pendingNew: 0,
  pendingExact: true, // 새 글 배너의 개수가 이 게시판 기준으로 정확한지
  readIds: new Set(store.get('hg.read', [])),
  clickMode: store.get('hg.click', 'preview'),
  theme: store.get('hg.theme', 'auto'),
  showSource: store.get('hg.showSource', true),
  adminOpen: store.get('hg.adminOpen', true),
  readerZoom: readerZoomOf(store.get('hg.readerZoom', 100)), // 미리보기 보기 크기(%)
  readerFit: store.get('hg.readerFit', false) === true, // 미리보기 그림·영상을 화면 높이에 맞춤
};

const STAGES = { candidate: '후보', script: '대본 작성', done: '촬영 완료' };
const VERDICT_LABEL = { ok: '정상', politics: '정치', hate: '혐오', dark: '사건사고', adult: '그라운즈', not_humor: '유머 아님' };

/**
 * 어디서 열렸는지 (/api/meta 의 mode).
 * - "public": 공개 사이트(읽기 전용 Worker). 관리자 기능·실시간 연결(SSE)이 없고, 2분마다 메타를 다시 받아 새 글을 알린다.
 * - "cloud": 수집·관리자까지 Cloudflare 에서 도는 사이트(worker/CLOUD.md). 관리자 기능은 그대로, SSE 대신
 *   관리자면 30초·방문자면 2분마다 메타를 다시 받는다. 공개 사이트 업로드 표시는 없다.
 * - 그 밖(없음·"local"): 내 컴퓨터 서버. SSE 로 실시간 알림.
 */
const isPublic = () => state.meta?.mode === 'public';
const isCloud = () => state.meta?.mode === 'cloud';
/** SSE 대신 /api/meta 를 주기적으로 다시 받는 모드 */
const usesPolling = () => isPublic() || isCloud();
const PUBLIC_POLL_MS = 2 * 60e3;
const CLOUD_ADMIN_POLL_MS = 30e3;
const CRAWL_POLL_MS = 3e3; // 클라우드에서 '지금 수집'을 누른 뒤 끝날 때까지
const CRAWL_FOLLOW_MAX = 200; // 3초 × 200 = 10분. 넘으면 평소 간격으로 (끝나면 그때 보인다)
/** 클라우드: '지금 수집'을 누른 뒤 끝날 때까지 따라가는 중 { checks, sawRunning, fromAt } */
let crawlFollow = null;
const httpUrl = (u) => (typeof u === 'string' && /^https?:\/\//i.test(u) ? u : null);

// ---------- 공용 ----------
async function api(path, opts = {}) {
  const init = { credentials: 'same-origin', ...opts };
  if (opts.body !== undefined) {
    init.method = opts.method || 'POST';
    init.headers = { 'content-type': 'application/json', ...(opts.headers || {}) };
    init.body = JSON.stringify(opts.body);
  }
  const res = await fetch(path, init);
  let data = null;
  try {
    data = await res.json();
  } catch {}
  if (!res.ok) {
    const err = new Error(data?.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}

function timeAgo(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const s = (Date.now() - d.getTime()) / 1000;
  if (s < 60) return '방금';
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  if (s < 172800) return '어제';
  if (s < 604800) return `${Math.floor(s / 86400)}일 전`;
  return `${d.getMonth() + 1}.${d.getDate()}`;
}
function fullTime(iso) {
  return iso ? new Date(iso).toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: 'short' }) : '';
}
function num(n) {
  if (n === null || n === undefined) return null;
  if (n >= 10000) return `${(n / 10000).toFixed(n >= 100000 ? 0 : 1)}만`;
  if (n >= 1000) return n.toLocaleString('ko-KR');
  return String(n);
}

function badge(sourceId, mini = false) {
  const s = state.sources[sourceId] || { short: sourceId, color: '#64748b', name: sourceId };
  return h('span', { class: `badge${mini ? ' mini' : ''}`, style: { background: s.color }, title: s.name }, s.short);
}

/** 보기 설정 "출처 표시" 를 끄면 글 옆 사이트 배지·같은 글 배지·미리보기의 사이트 이름을 숨긴다 */
function applySourceVisibility() {
  document.documentElement.classList.toggle('hide-source', !state.showSource);
}

function applyTheme() {
  if (state.theme === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.dataset.theme = state.theme;
}

// ---------- 라우팅 (#/b/<board>?sort=&q=&stage=) ----------
function parseHash() {
  const m = /^#\/b\/([^?]+)(?:\?(.*))?$/.exec(location.hash);
  const params = new URLSearchParams(m?.[2] || '');
  return {
    board: m ? decodeURIComponent(m[1]) : 'story',
    sort: params.get('sort') || 'new',
    q: params.get('q') || '',
    stage: params.get('stage') || '',
  };
}
function hashOf(n) {
  const p = new URLSearchParams();
  if (n.sort && n.sort !== 'new') p.set('sort', n.sort);
  if (n.q) p.set('q', n.q);
  if (n.stage) p.set('stage', n.stage);
  return `#/b/${encodeURIComponent(n.board)}${p.toString() ? `?${p}` : ''}`;
}
function go(patch) {
  const hash = hashOf({ board: state.board, sort: state.sort, q: state.q, stage: state.stage, ...patch });
  if (location.hash === hash) route();
  else location.hash = hash;
}

let routeSeq = 0;
let searchEcho = null; // 검색창에서 친 값으로 시작된 이동이면 그 q (입력 중인 검색창을 덮어쓰지 않으려고)
async function route() {
  const seq = ++routeSeq;
  const hash = location.hash;
  const r = parseHash();
  const typedQ = searchEcho;
  searchEcho = null;
  // 잠금 비밀번호 창이 열린 채 뒤로가기 등으로 다른 게시판이 되면 창을 닫는다 (기다리던 route 는 아래에서 버려진다)
  if (r.board !== 'adult' && pwPending?.endpoint === UNLOCK_ENDPOINT) closeOverlay($('#pw-modal'));
  if (r.board === 'adult' && !state.meta?.adult) {
    const ok = await unlockAdult();
    if (seq !== routeSeq || location.hash !== hash) return; // 기다리는 사이 다른 이동이 있었다
    if (!ok) {
      const back = state.board && state.board !== 'adult' ? state.board : 'story';
      // 정렬·검색은 그대로 두고 원래 게시판으로
      history.replaceState(null, '', hashOf({ board: back, sort: state.sort, q: state.q, stage: back === 'shorts' ? state.stage : '' }));
      return route();
    }
  }
  if ((r.board === 'shorts' || r.board === 'filtered') && !state.meta?.admin) {
    history.replaceState(null, '', hashOf({ board: 'story', sort: r.sort, q: r.q }));
    return route();
  }
  Object.assign(state, r);
  // 값이 실제로 다를 때만 맞춘다 (끝 공백·커서 유지). 방금 검색창에서 친 값이면 사용자가 계속 치는 중일 수 있어 두지 않는다.
  const input = $('#search');
  if (input.value.trim() !== state.q && typedQ !== state.q) input.value = state.q;
  renderBoards();
  renderAdminBar();
  renderSorts();
  await loadPosts(true);
}

// ---------- 메타 / 게시판 칩 ----------
async function loadMeta() {
  state.meta = await api('/api/meta');
  state.sources = Object.fromEntries(state.meta.sources.map((s) => [s.id, s]));
  document.title = state.meta.siteName;
  $('#site-name').textContent = state.meta.siteName;
  renderLive(state.meta.live);
  renderBoards();
  renderAdminBar();
  renderSorts(); // 로그인/로그아웃하면 관리자 전용 정렬이 보이거나 숨는다
  followPublish();
}

function boardName(board) {
  if (board === 'story') return '☕ 핸드드립';
  if (board === 'pick') return '😄 푸어오버';
  if (board === 'all') return '전체';
  if (board === 'adult') return '🔒 그라운즈';
  if (board === 'shorts') return '🎬 쇼츠 후보함';
  if (board === 'filtered') return '🚫 걸러진 글';
  return state.sources[board]?.name || board;
}

function renderBoards() {
  const nav = $('#boards');
  const m = state.meta;
  if (!m) return;
  // 칩 숫자는 목록과 같은 조건으로 서버가 센 값(boardCounts)을 쓴다. 없으면(옛 서버) 예전 방식으로 어림한다.
  const bc = m.boardCounts || {};
  const total = bc.all ?? m.allCount ?? m.sources.reduce((a, s) => a + (s.count || 0), 0);
  const filteredCount = bc.filtered ?? m.stats?.filtered ?? (m.stats?.blocked || 0) + (m.stats?.pending || 0);
  const chip = (board, label, extra = {}) =>
    h(
      'a',
      { class: `board-chip${state.board === board ? ' active' : ''}${extra.cls ? ` ${extra.cls}` : ''}`, href: `#/b/${board}`, title: extra.title || null },
      extra.swatch ? h('span', { class: 'swatch', style: { background: extra.swatch } }) : null,
      label,
      extra.count != null ? h('span', { class: 'count' }, extra.count) : null,
    );
  nav.replaceChildren(...kids(
    chip('story', '☕ 핸드드립', { count: bc.story }),
    chip('pick', '😄 푸어오버', { count: bc.pick ?? m.pickCount }),
    chip('all', '전체', { count: total }),
    ...m.sources.map((s) => chip(s.id, s.short, { swatch: s.color, count: s.count, title: s.name + (s.active ? '' : ' (수집 꺼짐)'), cls: s.active ? '' : 'inactive' })),
    chip('adult', m.adult ? '🔓 그라운즈' : '🔒 그라운즈', { cls: 'special', title: '비밀번호로 잠긴 게시판', count: m.adult ? bc.adult : null }),
    m.admin ? chip('shorts', '🎬 후보함', { cls: 'special', count: bc.shorts ?? m.stats?.shorts }) : null,
    m.admin ? chip('filtered', '🚫 걸러진 글', { cls: 'special', count: filteredCount }) : null,
  ));
  $('#board-title').textContent = boardName(state.board);
  $('#stage-filter').hidden = state.board !== 'shorts';
  $$('#stage-filter button').forEach((b) => b.classList.toggle('active', b.dataset.stage === state.stage));
  // 공개 사이트에는 관리자 기능이 없다 (관리는 내 컴퓨터에서만). 처음엔 숨겨 두고 메타를 받은 뒤 정한다.
  $('#btn-admin').hidden = isPublic();
  $('#btn-admin').classList.toggle('on', !!m.admin);
  $('#btn-admin').title = m.admin ? '관리자 바 열기/닫기' : '관리자 로그인';
}

function renderSorts() {
  $$('#sorts button').forEach((b) => {
    // 쇼츠추천순은 운영자용 정렬이라 관리자에게만 보인다
    if (b.dataset.sort === 'shorts') b.hidden = !state.meta?.admin;
    b.classList.toggle('active', b.dataset.sort === state.sort);
    b.setAttribute('aria-selected', b.dataset.sort === state.sort);
  });
}

function renderLive(live) {
  const pill = $('#live-pill');
  if (isPublic() || (isCloud() && !state.meta?.admin)) {
    // 방문자(공개 사이트, 클라우드의 방문자): 수집 상태 대신 마지막 갱신 시각만 중립적으로 ("5분 전 갱신")
    const at = live?.lastCrawlAt;
    pill.hidden = !at;
    pill.classList.add('public');
    pill.classList.remove('on', 'busy');
    pill.querySelector('.txt').textContent = at ? `${timeAgo(at)} 갱신` : '';
    pill.title = at ? `마지막 갱신 ${fullTime(at)}` : '';
    return;
  }
  pill.hidden = false;
  pill.classList.remove('public'); // 클라우드에서 방문자 → 관리자로 로그인한 경우
  const running = !!live?.running || !!crawlFollow;
  pill.classList.toggle('on', !!live?.live);
  pill.classList.toggle('busy', running);
  pill.querySelector('.txt').textContent = running ? '수집 중' : live?.live ? '실시간' : '일시정지';
  pill.title = `${live?.live ? '실시간 수집 켜짐' : '실시간 수집 꺼짐'}${live?.lastCrawlAt ? ` · 마지막 수집 ${fullTime(live.lastCrawlAt)}` : ''}`;
}

// ---------- 관리자 바 ----------
function renderAdminBar() {
  const m = state.meta;
  const bar = $('#adminbar');
  bar.hidden = !m?.admin || !state.adminOpen || isPublic();
  if (!m?.admin || isPublic()) return;
  renderPublish();
  const lv = m.live || {};
  $('#live-toggle').checked = !!lv.live;
  $('#live-label').textContent = lv.live ? 'ON' : 'OFF';
  const sel = $('#live-interval');
  if (lv.intervalMin && ![...sel.options].some((o) => Number(o.value) === lv.intervalMin)) sel.append(h('option', { value: lv.intervalMin }, `${lv.intervalMin}분`));
  sel.value = String(lv.intervalMin || 15);
  const running = !!lv.running || !!crawlFollow; // 클라우드: 누른 뒤 서버가 수집을 시작했다고 알리기 전에도
  $('#btn-crawl').disabled = running;
  $('#btn-crawl').textContent = running ? '수집 중…' : '지금 수집';
  const info = [];
  if (lv.lastCrawlAt) info.push(`마지막 ${timeAgo(lv.lastCrawlAt)}`);
  if (lv.live && lv.nextRunAt) info.push(`다음 ${new Date(lv.nextRunAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}`);
  $('#crawl-info').textContent = info.join(' · ');

  const st = m.stats || {};
  const ai = m.ai || {};
  // 숫자를 누르면 해당 게시판으로 이동
  const statLink = (label, value, board, title) =>
    h('a', { class: `stat${state.board === board ? ' on' : ''}`, href: `#/b/${board}`, title }, label, h('b', {}, value ?? 0));
  $('#admin-stats').replaceChildren(
    statLink('☕ 핸드드립', m.boardCounts?.story, 'story', '핸드드립 보기'),
    statLink('😄 푸어오버', m.pickCount, 'pick', '푸어오버 보기'),
    statLink('공개', st.public, 'all', '공개된 전체 글 보기'),
    statLink('그라운즈', st.adult, 'adult', '그라운즈 잠금 게시판 보기'),
    statLink('걸러짐', st.blocked, 'filtered', '걸러진 글 보기 — 여기서 [게시하기]로 공개할 수 있어요'),
    statLink('검수 대기', st.pending, 'filtered', 'Claude 검수를 기다리는 글 (걸러진 글함에 함께 보여요)'),
    statLink('후보', st.shorts, 'shorts', '쇼츠 후보함 보기'),
    h(
      'button',
      {
        class: 'stat stat-btn',
        type: 'button',
        title: ai.lastError ? `마지막 오류: ${ai.lastError.message}` : 'Claude 자동 검수 상태',
        onclick: () =>
          toast(
            ai.enabled
              ? ai.lastError
                ? `Claude 검수 오류: ${ai.lastError.message}`
                : `Claude 검수 켜짐 (${ai.model}) — 새 글은 수집 직후 자동으로 판정해요`
              : isCloud()
                ? 'Claude 자동 검수는 꺼져 있어요. Worker 비밀 ANTHROPIC_API_KEY 를 넣으면 새 글도 수집 직후 자동으로 판정해요. 지금은 키워드 필터로만 걸러요.'
                : 'Claude 자동 검수는 꺼져 있어요. .env 에 ANTHROPIC_API_KEY 를 넣고 서버를 다시 켜면 새 글도 자동으로 판정해요. (지금 있는 글은 대화에서 Claude 가 직접 판정했어요)',
            7000,
          ),
      },
      'Claude 검수',
      h('b', { style: { color: ai.enabled ? (ai.lastError ? 'var(--warn)' : 'var(--accent)') : 'var(--text-3)' } }, ai.enabled ? (ai.lastError ? '오류' : '켜짐') : '꺼짐'),
    ),
  );

  $('#source-status').replaceChildren(
    ...m.sources.map((s) => {
      const st2 = s.state;
      return h(
        'div',
        { class: 'src-card' },
        h('div', {}, badge(s.id, true), ' ', h('b', {}, s.name), s.strictness === 'strict' ? h('span', { class: 'muted' }, ' · 엄격') : null),
        s.disabled
          ? h('div', { class: 'st-bad' }, `수집 불가: ${s.disabledReason || '사유 없음'}`)
          : !s.active
            ? h('div', { class: 'muted' }, '설정에서 꺼짐')
            : st2
              ? h(
                  'div',
                  {},
                  h('span', { class: st2.ok ? 'st-ok' : 'st-bad' }, st2.ok ? '정상' : '실패'),
                  ` · ${timeAgo(st2.lastRunAt)} · 목록 ${st2.fetched ?? 0} · 새 글 ${st2.added ?? 0}`,
                  st2.error ? h('div', { class: 'st-bad' }, st2.error) : null,
                )
              : h('div', { class: 'muted' }, '아직 수집 전'),
      );
    }),
  );
}

// ---------- 공개 사이트 반영 상태 (로컬 관리자 바) ----------
/**
 * meta.publish 를 화면에 쓸 모양으로. 없거나 enabled 가 false 면 null (표시하지 않음).
 * 필드 이름은 로컬 서버(src/publish.js)와 맞추되, 비슷한 이름도 받아 준다.
 */
function publishInfo(pub) {
  if (!pub || typeof pub !== 'object' || pub.enabled === false) return null;
  const at = pub.lastOkAt ?? pub.lastSuccessAt ?? pub.lastPublishedAt ?? pub.publishedAt ?? pub.lastAt ?? null;
  const raw = pub.lastError ?? pub.error ?? null;
  let error = raw ? (typeof raw === 'string' ? raw : raw.message || '알 수 없는 오류') : null;
  const errorAt = raw && typeof raw === 'object' ? raw.at : pub.lastErrorAt;
  // 오류 뒤에 다시 성공했으면 지난 오류는 보이지 않는다
  if (error && at && errorAt && new Date(at) > new Date(errorAt)) error = null;
  const reads = typeof pub.reads?.done === 'number' ? pub.reads : null; // 미리보기 문서 { done, pending }
  return { at, error, running: !!(pub.running ?? pub.busy), url: httpUrl(pub.url ?? pub.siteUrl ?? null), reads };
}

let publishing = false; // 지금 올리기 요청을 보내는 중
function renderPublish() {
  const btn = $('#btn-publish');
  const link = $('#publish-site');
  // 공개 사이트 업로드는 내 컴퓨터 서버에만 있다 (공개·클라우드 모드에서는 표시하지 않는다)
  const info = state.meta?.admin && !usesPolling() ? publishInfo(state.meta.publish) : null;
  btn.hidden = !info;
  if (link) link.hidden = !info?.url;
  if (!info) return;
  const busy = publishing || info.running;
  btn.disabled = busy;
  btn.classList.toggle('warn', !!info.error && !busy);
  btn.textContent = busy
    ? '공개 사이트: 올리는 중…'
    : `${info.error ? '⚠ ' : ''}공개 사이트: ${info.at ? `마지막 반영 ${timeAgo(info.at)}` : '아직 반영 전'}`;
  const when = info.at ? `마지막 반영 ${fullTime(info.at)}` : '아직 반영 전';
  const reads = info.reads ? `\n미리보기 ${info.reads.done}개 올림${info.reads.pending ? ` · ${info.reads.pending}개 남음` : ''}` : '';
  btn.title = `${info.error ? `오류: ${info.error}\n` : ''}${when} · 누르면 지금 올려요${reads}`;
  if (link && info.url) link.setAttribute('href', info.url);
}

async function publishNow() {
  if (publishing) return;
  publishing = true;
  renderPublish();
  try {
    const r = await api('/api/admin/publish', { body: {} });
    if (r && r.ok === false) throw new Error(r.error || '실패');
    toast(r?.started || r?.running ? '공개 사이트에 올리는 중이에요' : '공개 사이트에 올렸어요');
  } catch (err) {
    toast(`공개 사이트에 올리지 못했어요: ${err.message}`, 5000);
  } finally {
    publishing = false;
    await loadMeta().catch(() => {});
    renderPublish();
  }
}

/** 올리는 중이면 끝날 때까지 메타를 몇 번 더 받아 반영 시각·오류를 맞춘다 */
let publishFollowTimer;
let publishFollowCount = 0;
function followPublish() {
  clearTimeout(publishFollowTimer);
  if (!state.meta?.admin || usesPolling() || !publishInfo(state.meta.publish)?.running || publishFollowCount >= 30) {
    publishFollowCount = 0;
    return;
  }
  publishFollowCount++;
  publishFollowTimer = setTimeout(() => loadMeta().catch(() => {}), 4000);
}

// ---------- 목록 ----------
const PAGE_SIZE = 30;
let listSeq = 0;
/** 지금 목록에 그려진 글 행 (스켈레톤 제외) */
const shownRows = () => $$('#posts .post[data-id]');

function emptyMessage() {
  return state.q
    ? `"${state.q}" 검색 결과가 없어요.`
    : state.board === 'shorts'
      ? '아직 쇼츠 후보가 없어요. 글 옆의 🎬 버튼으로 담아보세요.'
      : state.board === 'filtered'
        ? '걸러진 글이 없어요.'
        : state.board === 'pick' || state.board === 'story'
          ? '아직 글이 없어요.'
          : state.meta?.live?.lastCrawlAt
            ? '아직 글이 없어요.'
            : '아직 수집 전이에요. 잠시 뒤 새로고침해 주세요.';
}

/**
 * 목록 불러오기. reset 이면 처음부터, 아니면 이어서.
 * 서버는 page×size 로 자르므로, 관리자가 행을 지웠거나 새 글이 위에 끼면 페이지 경계가 밀린다.
 * 그래서 다음 페이지 번호를 세지 않고 "이미 그린 행 수"가 들어 있는 페이지부터 받아,
 * 이미 있는 글은 건너뛰고, 새로 붙일 글이 모자라면 다음 페이지를 한 번 더 받는다.
 * keep: 다시 불러오는 동안 스켈레톤을 띄우지 않는다 (실시간 갱신용)
 */
async function loadPosts(reset, { keep = false } = {}) {
  if (state.loading && !reset) return;
  const seq = ++listSeq;
  state.loading = true;
  if (reset) {
    state.pendingNew = 0;
    state.pendingExact = true;
    $('#new-banner').hidden = true;
    if (!keep) $('#posts').replaceChildren(...Array.from({ length: 8 }, () => h('li', { class: 'post' }, h('div', { class: 'skeleton', style: { width: `${50 + Math.random() * 40}%` } }))));
  }
  $('#btn-more').hidden = true;
  $('#empty').hidden = true;
  const shown = new Set(reset ? [] : shownRows().map((li) => li.dataset.id));
  let page = Math.floor(shown.size / PAGE_SIZE) + 1;
  const params = new URLSearchParams({ board: state.board, sort: state.sort, size: String(PAGE_SIZE) });
  if (state.q) params.set('q', state.q);
  if (state.stage) params.set('stage', state.stage);
  try {
    let data;
    const items = [];
    for (let tries = 0; tries < 3; tries++, page++) {
      params.set('page', String(page));
      data = await api(`/api/posts?${params}`);
      if (seq !== listSeq) return;
      for (const p of data.items) {
        if (shown.has(p.id)) continue; // 이미 그린 글 (새 글이 위에 끼어 밀려 온 것)
        shown.add(p.id);
        items.push(p);
      }
      if (reset || items.length >= PAGE_SIZE / 2 || !data.hasMore) break;
    }
    const rows = items.map(renderRow);
    if (reset) {
      $('#posts').replaceChildren(...rows);
      // 공개·클라우드: 이 목록이 반영한 수집 시각. 다음 확인에서 이보다 새 수집이 보이면 배너를 띄운다
      seenCrawlAt = state.meta?.live?.lastCrawlAt ?? seenCrawlAt;
      if (usesPolling()) $('#new-banner').hidden = true; // 받는 사이 확인에서 띄운 배너도 이제 반영됐다
    } else $('#posts').append(...rows);
    state.hasMore = data.hasMore;
    state.total = data.total;
    $('#btn-more').hidden = !data.hasMore;
    // 스크린리더에는 목록 전체 대신 개수만 알린다 (#posts 에는 aria-live 를 두지 않는다)
    const status = $('#list-status');
    if (status) status.textContent = reset ? `${boardName(state.board)} 글 ${data.total}개` : rows.length ? `글 ${rows.length}개를 더 불러왔어요` : '';
    if (!data.total) {
      $('#empty').hidden = false;
      $('#empty').textContent = emptyMessage();
    }
    if (rows.length) fillListSoon();
  } catch (e) {
    if (seq !== listSeq) return;
    if (e.status === 403 && state.board === 'adult') {
      state.meta.adult = false;
      return go({ board: 'adult' });
    }
    if (!reset || keep) {
      // 이미 불러온 글은 그대로 두고, 같은 자리부터 다시 받을 수 있게 '더 보기'를 다시 보여 준다
      $('#btn-more').hidden = !state.hasMore;
      if (!reset) toast(`더 불러오지 못했어요: ${e.message}`);
      else {
        // 실시간 갱신이 실패한 경우: 목록은 두고, 눌러서 다시 받을 수 있게 배너만 띄운다
        const b = $('#new-banner');
        b.textContent = '새 글이 들어왔어요 — 눌러서 보기';
        b.hidden = false;
      }
      return;
    }
    $('#posts').replaceChildren();
    $('#empty').hidden = false;
    $('#empty').textContent = `목록을 불러오지 못했어요: ${e.message}`;
  } finally {
    if (seq === listSeq) state.loading = false;
  }
}

/** 목록 끝이 화면 근처에 그대로 있으면(큰 화면, 행을 지운 뒤 등) 이어서 불러온다. 관찰자는 다시 들어올 때만 알려 주므로. */
function fillListSoon() {
  requestAnimationFrame(() => {
    if (!state.hasMore || state.loading) return;
    const r = $('#btn-more').parentElement.getBoundingClientRect();
    if (r.top < window.innerHeight + 400) loadPosts(false);
  });
}

/** 관리자 처리 등으로 목록에서 행을 뺀 뒤 */
function afterRowRemoved() {
  if (!shownRows().length && !state.hasMore) {
    $('#empty').hidden = false;
    $('#empty').textContent = emptyMessage();
  }
  fillListSoon();
}

function renderRow(p) {
  const admin = !!state.meta?.admin;
  const titleBtn = h(
    'a',
    {
      class: `post-title${state.readIds.has(p.id) ? ' read' : ''}`,
      href: p.url,
      target: '_blank',
      rel: 'noopener noreferrer',
      onclick: (e) => {
        if (state.clickMode === 'origin' && !e.ctrlKey && !e.metaKey) {
          markRead(p.id, e.currentTarget);
          return; // 기본 동작: 새 탭으로 원문
        }
        if (e.ctrlKey || e.metaKey || e.shiftKey) return;
        e.preventDefault();
        markRead(p.id, e.currentTarget);
        openReader(p);
      },
    },
    p.title,
  );

  const meta = h(
    'div',
    { class: 'post-meta' },
    h('time', { datetime: p.postedAt || p.firstSeenAt, title: fullTime(p.postedAt || p.firstSeenAt) }, timeAgo(p.postedAt || p.firstSeenAt)),
    p.likes != null ? h('span', {}, `추천 ${num(p.likes)}`) : null,
    p.views != null ? h('span', {}, `조회 ${num(p.views)}`) : null,
    p.category ? h('span', { class: 'cat' }, p.category) : null,
    p.alsoOn?.length
      ? h('span', { class: 'also', title: '같은 글이 올라온 다른 곳' }, '같은 글:', ...p.alsoOn.map((a) => h('a', { href: a.url, target: '_blank', rel: 'noopener noreferrer', style: { textDecoration: 'none' } }, badge(a.source, true))))
      : null,
    h('a', { class: 'origin-link', href: p.url, target: '_blank', rel: 'noopener noreferrer', title: '원문 사이트에서 보기' }, '원문 ↗'),
  );

  const main = h('div', { class: 'post-main' }, titleBtn, p.commentCount ? h('span', { class: 'cmt' }, `[${p.commentCount}]`) : null, meta);

  if (admin) {
    const tags = [];
    if (p.shorts) tags.push(h('span', { class: 'tag shorts' }, `🎬 ${STAGES[p.shorts.stage]}`));
    if (p.manual) tags.push(h('span', { class: 'tag' }, `수동: ${p.manual === 'ok' ? '게시' : p.manual === 'adult' ? '그라운즈' : '숨김'}`));
    if (p.aiPending) tags.push(h('span', { class: 'tag pending' }, 'Claude 검수 대기'));
    for (const r of p.auto?.reasons || []) tags.push(h('span', { class: 'tag kw', title: '키워드 필터' }, `키워드 · ${r}`));
    if (p.ai && p.ai.verdict !== 'ok') tags.push(h('span', { class: 'tag ai', title: `Claude (${p.ai.model})` }, `Claude · ${VERDICT_LABEL[p.ai.verdict] || p.ai.verdict}${p.ai.reason ? ` — ${p.ai.reason}` : ''}`));
    if (p.shorts?.note) tags.push(h('span', { class: 'tag', title: p.shorts.note }, `메모: ${p.shorts.note.slice(0, 40)}${p.shorts.note.length > 40 ? '…' : ''}`));
    if (tags.length) main.append(h('div', { class: 'reasons' }, tags));
    main.append(rowActions(p));
  }

  return h(
    'li',
    { class: 'post', dataset: { id: p.id } },
    h('a', { class: 'src-badge', href: `#/b/${p.source}`, style: { textDecoration: 'none' }, title: `${state.sources[p.source]?.name || p.source} 게시판만 보기` }, badge(p.source)),
    main,
    admin ? h('span', { class: `score${p.shortsScore >= 70 ? ' hi' : ''}`, title: '쇼츠 적합도 (키워드·반응·Claude 판정)' }, `🎬${p.shortsScore}`) : null,
  );
}

function rowActions(p) {
  const wrap = h('div', { class: 'row-actions' });
  const act = (label, patch, cls = '') =>
    h('button', { class: `btn sm ${cls}`, type: 'button', onclick: (e) => adminUpdate(p, patch, e.currentTarget.closest('.post')) }, label);
  if (state.board === 'filtered' || p.status === 'blocked') {
    wrap.append(act('게시하기', { manual: 'ok' }, 'primary'), act('그라운즈로', { manual: 'adult' }));
    if (p.manual) wrap.append(act('자동 판정으로', { manual: null }, 'ghost'));
  } else {
    if (p.status === 'ok') wrap.append(act('숨기기', { manual: 'blocked' }, 'danger'), act('그라운즈로', { manual: 'adult' }));
    if (p.status === 'adult') wrap.append(act('일반 게시판으로', { manual: 'ok' }), act('숨기기', { manual: 'blocked' }, 'danger'));
  }
  if (p.status === 'ok') {
    wrap.append(p.inStory ? act('☕ 핸드드립에서 빼기', { vibe: false }, 'ghost') : act('☕ 핸드드립으로', { vibe: true }));
    if (p.manualVibe !== null && p.manualVibe !== undefined) wrap.append(act('이야기 자동 판정으로', { vibe: null }, 'ghost'));
  }
  if (p.shorts) {
    for (const [k, v] of Object.entries(STAGES)) wrap.append(act(v, { shorts: { stage: k } }, p.shorts.stage === k ? 'on' : 'ghost'));
    wrap.append(act('후보 빼기', { shorts: null }, 'ghost'));
  } else {
    wrap.append(act('🎬 후보 담기', { shorts: { stage: 'candidate' } }));
  }
  return wrap;
}

async function adminUpdate(p, patch, rowEl) {
  try {
    const r = await api(`/api/admin/posts/${encodeURIComponent(p.id)}`, { body: patch });
    Object.assign(p, r.post);
    const msg =
      'manual' in patch
        ? patch.manual === 'ok'
          ? '공개 목록에 게시했어요'
          : patch.manual === 'adult'
            ? '그라운즈로 옮겼어요'
            : patch.manual === 'blocked'
              ? '숨겼어요 (걸러진 글함에 있어요)'
              : '자동 판정으로 되돌렸어요'
        : 'vibe' in patch
          ? patch.vibe === true
            ? '☕ 핸드드립에 넣었어요'
            : patch.vibe === false
              ? '☕ 핸드드립에서 뺐어요'
              : '핸드드립 자동 판정으로 되돌렸어요'
          : patch.shorts === null
            ? '후보에서 뺐어요'
            : `쇼츠 ${STAGES[patch.shorts.stage]}(으)로 표시했어요`;
    toast(msg);
    // 지금 보고 있는 게시판에 더 이상 안 맞으면 목록에서 뺀다
    const stillFits =
      state.board === 'filtered'
        ? p.status === 'blocked' || p.aiPending
        : state.board === 'adult'
          ? p.status === 'adult'
          : state.board === 'shorts'
            ? !!p.shorts && (!state.stage || p.shorts.stage === state.stage)
            : state.board === 'story'
              ? p.status === 'ok' && !!p.inStory
              : p.status === 'ok';
    if (rowEl?.isConnected) {
      if (stillFits) rowEl.replaceWith(renderRow(p));
      else {
        rowEl.remove();
        afterRowRemoved();
      }
    }
    refreshMetaSoon();
    return p;
  } catch (e) {
    toast(`실패: ${e.message}`);
  }
}

let metaTimer;
function refreshMetaSoon() {
  clearTimeout(metaTimer);
  metaTimer = setTimeout(() => loadMeta().catch(() => {}), 600);
}

function markRead(id, el) {
  state.readIds.add(id);
  const arr = [...state.readIds].slice(-800);
  store.set('hg.read', arr);
  el?.classList.add('read');
}

// ---------- 본문 보기 ----------
let readerPost = null;
let readerSeq = 0; // 열 때마다, 닫을 때마다 바뀐다. 늦게 온 응답은 버린다 (같은 글을 닫았다 다시 연 경우 포함)
async function openReader(p) {
  const seq = ++readerSeq;
  readerPost = p;
  const ov = $('#reader');
  if (ov.hidden) {
    openOverlay(ov);
    // 뒤로가기(안드로이드 포함)로 미리보기만 닫히도록, 주소는 그대로인 이력 한 칸을 넣는다
    try {
      history.pushState({ reader: true }, '', location.href);
    } catch {}
  }
  const src = state.sources[p.source] || {};
  $('#reader-title').textContent = p.title;
  $('#reader-meta').replaceChildren(...kids(
    h('span', { class: 'src' }, badge(p.source)),
    h('span', { class: 'src' }, src.name || p.source),
    h('time', { title: fullTime(p.postedAt || p.firstSeenAt) }, timeAgo(p.postedAt || p.firstSeenAt)),
    p.commentCount != null ? h('span', {}, `댓글 ${num(p.commentCount)}`) : null,
    p.likes != null ? h('span', {}, `추천 ${num(p.likes)}`) : null,
  ));
  $('#reader-actions').replaceChildren(
    h('a', { class: 'btn primary sm', href: p.url, target: '_blank', rel: 'noopener noreferrer' }, '원문 보기 ↗'),
  );
  $('#reader-admin').hidden = true;
  $('#reader-body').replaceChildren(h('div', { class: 'skeleton', style: { width: '70%', marginBottom: '10px' } }), h('div', { class: 'skeleton', style: { width: '90%', marginBottom: '10px' } }), h('div', { class: 'skeleton', style: { width: '55%' } }));
  $('#reader-foot').replaceChildren();
  $('#reader-comments').hidden = true;
  $('#reader-comments').replaceChildren();
  $('.reader .close').focus();

  try {
    const data = await api(`/api/posts/${encodeURIComponent(p.id)}/read`);
    if (seq !== readerSeq || readerPost !== p) return;
    Object.assign(p, data.post);
    renderReader(p, data);
  } catch (e) {
    if (seq !== readerSeq || readerPost !== p) return;
    if (e.status === 403) {
      closeOverlay($('#reader'));
      if (await unlockAdult()) openReader(p);
      return;
    }
    if (e.status === 404 && e.data?.url) {
      // 공개 사이트: 글은 있는데 미리보기 문서가 아직 올라오지 않았다
      $('#reader-body').replaceChildren(
        h('p', { class: 'notice' }, '미리보기를 준비 중이에요'),
        h('p', {}, h('a', { class: 'btn primary', href: httpUrl(e.data.url) || p.url, target: '_blank', rel: 'noopener noreferrer' }, '원문 보기 ↗')),
      );
      return;
    }
    if (e.status === 409) {
      $('#reader-body').replaceChildren(h('p', { class: 'notice' }, e.message));
      const row = $(`.post[data-id="${CSS.escape(p.id)}"]`);
      if (row) {
        row.remove();
        afterRowRemoved();
      }
      refreshMetaSoon();
      return;
    }
    $('#reader-body').replaceChildren(
      h('p', { class: 'notice' }, e.message),
      h('p', {}, h('a', { class: 'btn', href: p.url, target: '_blank', rel: 'noopener noreferrer' }, '원문 사이트에서 보기 ↗')),
    );
  }
}

function renderReader(p, data) {
  const body = $('#reader-body');
  // 서버에서 sanitize-html 로 정리된 HTML (스크립트·이벤트 속성 제거, 허용 태그만)
  body.innerHTML = data.html || '';
  if (!data.html?.trim()) body.replaceChildren(h('p', { class: 'muted' }, '본문을 가져오지 못했어요. 원문에서 확인해 주세요.'));
  body.querySelectorAll('img').forEach((img) => {
    img.addEventListener('error', () => {
      img.replaceWith(h('a', { class: 'btn sm', href: p.url, target: '_blank', rel: 'noopener noreferrer' }, '이미지를 불러오지 못했어요 — 원문에서 보기 ↗'));
    }, { once: true });
  });
  body.querySelectorAll('video').forEach((v) => {
    v.muted = true;
    v.loop = true;
  });
  if (data.statusChanged && state.meta?.admin) toast('본문을 확인해 보니 분류가 바뀌었어요');

  const src = state.sources[p.source] || {};
  const comments = data.comments || [];
  const copy = async (text, msg) => {
    try {
      await navigator.clipboard.writeText(text);
      toast(msg);
    } catch {
      toast('복사하지 못했어요 (브라우저 권한 확인)');
    }
  };
  const source = `출처: ${src.name || p.source} ${p.url}`;
  // append 가 아니라 통째로 바꾼다 (여러 번 그려도 버튼이 늘지 않게). 대본 복사는 운영자(관리자)에게만.
  const admin = !!state.meta?.admin;
  $('#reader-actions').replaceChildren(...kids(
    h('a', { class: 'btn primary sm', href: p.url, target: '_blank', rel: 'noopener noreferrer' }, '원문 보기 ↗'),
    admin && h('button', {
      class: 'btn sm',
      type: 'button',
      title: '제목·본문 글자·출처를 복사 (쇼츠 대본용)',
      onclick: () => copy(`${p.title}\n\n${data.text || ''}\n\n${source}`, '대본용 텍스트를 복사했어요'),
    }, '📋 대본 복사'),
    admin && comments.length
      ? h('button', {
          class: 'btn sm',
          type: 'button',
          title: '본문 + 베스트·추천 많은 댓글 10개를 함께 복사',
          onclick: () => copy(`${p.title}\n\n${data.text || ''}\n\n[댓글 반응]\n${topComments(comments, 10).map(commentLine).join('\n')}\n\n${source}`, '본문과 댓글을 함께 복사했어요'),
        }, '💬 댓글 포함 복사')
      : null,
  ));
  renderComments(p, data);
  $('#reader-foot').replaceChildren(
    h('span', { class: 'muted src' }, `출처: ${src.name || p.source}`),
    h('span', { class: 'reader-foot-actions' },
      h('a', { class: 'btn sm', href: p.url, target: '_blank', rel: 'noopener noreferrer' }, '원문에서 보기 ↗'),
      // 긴 글을 끝까지 읽은 뒤 위로 올라가지 않고 닫을 수 있게
      h('button', { class: 'btn sm', type: 'button', 'data-close': true }, '닫기'),
    ),
  );

  if (state.meta?.admin) renderReaderAdmin(p);
}

/** 베스트 댓글 먼저, 그다음 추천 많은 순 */
function topComments(list, n) {
  return [...list]
    .map((c, i) => ({ c, i }))
    .sort((a, b) => (b.c.best - a.c.best) || ((b.c.likes ?? 0) - (a.c.likes ?? 0)) || a.i - b.i)
    .slice(0, n)
    .map((x) => x.c);
}
const commentLine = (c) => `- ${c.text.replace(/\n+/g, ' ')}${c.likes ? ` (👍${c.likes})` : ''}`;

const COMMENTS_FIRST = 30;
function renderComments(p, data) {
  const box = $('#reader-comments');
  const list = data.comments || [];
  const total = data.commentTotal ?? p.commentCount ?? list.length;
  box.hidden = false;
  const head = h('h3', { class: 'cm-head' }, `💬 댓글 ${num(total) ?? 0}`);
  if (!list.length) {
    box.replaceChildren(
      head,
      h('p', { class: 'muted small' }, total ? '이 글의 댓글은 아직 여기서 못 가져와요.' : '댓글이 없어요.', ' ', total ? h('a', { href: p.url, target: '_blank', rel: 'noopener noreferrer' }, '원문에서 보기 ↗') : null),
    );
    return;
  }
  const item = (c) =>
    h(
      'li',
      { class: `cm${c.best ? ' best' : ''}${c.reply ? ' reply' : ''}` },
      h(
        'div',
        { class: 'cm-meta' },
        c.reply ? h('span', { class: 'cm-arrow', 'aria-hidden': 'true' }, '↳') : null,
        c.best ? h('span', { class: 'cm-best' }, 'BEST') : null,
        h('b', { class: 'cm-author' }, c.author || '익명'),
        c.postedAt ? h('time', { title: fullTime(c.postedAt) }, timeAgo(c.postedAt)) : null,
        c.likes ? h('span', { class: 'cm-like' }, `👍 ${num(c.likes)}`) : null,
        c.dislikes ? h('span', { class: 'cm-dislike' }, `👎 ${num(c.dislikes)}`) : null,
      ),
      c.text ? h('p', { class: 'cm-text' }, c.text) : null,
      c.images?.length
        ? h('div', { class: 'cm-imgs' }, c.images.map((im) => {
            if (im.kind === 'video') {
              // 움짤 스티커: 소리 없이 자동 반복 재생
              const v = h('video', { src: im.src, autoplay: true, loop: true, playsinline: true, preload: 'metadata', referrerpolicy: im.direct ? 'no-referrer' : null, onerror: (e) => e.currentTarget.remove() });
              v.muted = true;
              return v;
            }
            return h('img', { src: im.src, alt: '', loading: 'lazy', referrerpolicy: im.direct ? 'no-referrer' : null, onerror: (e) => e.currentTarget.remove() });
          }))
        : null,
    );
  const ol = h('ol', { class: 'cm-list' }, list.slice(0, COMMENTS_FIRST).map(item));
  const more =
    list.length > COMMENTS_FIRST
      ? h('button', {
          class: 'btn sm cm-more',
          type: 'button',
          onclick: (e) => {
            ol.append(...list.slice(COMMENTS_FIRST).map(item));
            e.currentTarget.remove();
          },
        }, `댓글 ${list.length - COMMENTS_FIRST}개 더 보기`)
      : null;
  const bestCount = list.filter((c) => c.best).length;
  const body = h('div', { class: 'cm-body', id: 'cm-body', hidden: true }, ...kids(
    bestCount || list.length < total
      ? h('p', { class: 'muted small cm-note' }, ...kids(bestCount ? `베스트 ${bestCount}개 먼저` : null, list.length < total ? ` · ${list.length}개 가져옴` : null))
      : null,
    ol,
    more,
  ));
  const label = (open) => `💬 댓글 ${num(total) ?? 0}개 ${open ? '접기 ▴' : '보기 ▾'}`;
  const toggle = h('button', {
    class: 'cm-toggle',
    type: 'button',
    'aria-expanded': 'false',
    'aria-controls': 'cm-body',
    onclick: (e) => {
      const open = body.hidden;
      body.hidden = !open;
      e.currentTarget.setAttribute('aria-expanded', String(open));
      e.currentTarget.textContent = label(open);
    },
  }, label(false));
  box.replaceChildren(toggle, body);
}

/** draft: 다시 그릴 때 살려 둘, 아직 저장하지 않은 메모 */
function renderReaderAdmin(p, draft) {
  const box = $('#reader-admin');
  box.hidden = false;
  const note = h('textarea', { placeholder: '쇼츠 메모 (예: 첫 컷은 카톡 캡처, 반응 포인트…)', maxlength: 2000 }, draft ?? p.shorts?.note ?? '');
  const stageBtns = Object.entries(STAGES).map(([k, v]) =>
    h('button', { class: `btn sm ${p.shorts?.stage === k ? 'on' : ''}`, type: 'button', onclick: () => save({ shorts: { stage: k, note: note.value } }) }, v),
  );
  async function save(patch) {
    const row = $(`.post[data-id="${CSS.escape(p.id)}"]`);
    const updated = await adminUpdate(p, patch, row);
    // 게시/숨기기/그라운즈/자동 판정은 메모를 보내지 않으므로, 입력 중이던 메모를 그대로 살린다
    if (updated && readerPost === p) renderReaderAdmin(updated, 'shorts' in patch ? undefined : note.value);
  }
  const reasons = [
    ...(p.auto?.reasons || []).map((r) => h('span', { class: 'tag kw' }, `키워드 · ${r}`)),
    p.ai ? h('span', { class: `tag ${p.ai.verdict === 'ok' ? 'shorts' : 'ai'}` }, `Claude · ${VERDICT_LABEL[p.ai.verdict] || p.ai.verdict}${p.ai.reason ? ` — ${p.ai.reason}` : ''} (쇼츠 ${p.ai.shortsScore})`) : null,
    p.aiPending ? h('span', { class: 'tag pending' }, 'Claude 검수 대기') : null,
  ].filter(Boolean);
  box.replaceChildren(
    h('div', { class: 'row-actions', style: { marginTop: 0, alignItems: 'center' } },
      h('b', {}, `🎬 쇼츠 ${p.shortsScore}점`),
      ...stageBtns,
      p.shorts ? h('button', { class: 'btn sm ghost', type: 'button', onclick: () => save({ shorts: null }) }, '후보 빼기') : null,
      h('span', { class: 'spacer' }),
      p.status !== 'ok' ? h('button', { class: 'btn sm primary', type: 'button', onclick: () => save({ manual: 'ok' }) }, '게시하기') : h('button', { class: 'btn sm danger', type: 'button', onclick: () => save({ manual: 'blocked' }) }, '숨기기'),
      p.status !== 'adult' ? h('button', { class: 'btn sm', type: 'button', onclick: () => save({ manual: 'adult' }) }, '그라운즈로') : null,
      p.manual ? h('button', { class: 'btn sm ghost', type: 'button', onclick: () => save({ manual: null }) }, '자동 판정으로') : null,
    ),
    note,
    h('div', { class: 'row-actions', style: { marginTop: 0 } },
      h('button', { class: 'btn sm', type: 'button', onclick: () => save({ shorts: { stage: p.shorts?.stage || 'candidate', note: note.value } }) }, p.shorts ? '메모 저장' : '메모와 함께 후보 담기'),
      reasons.length ? h('div', { class: 'reasons', style: { marginTop: 0 } }, reasons) : null,
    ),
  );
}

// ---------- 미리보기 보기 크기·화면 맞춤 ----------
// 머리의 고정 줄(#reader-view)과 .reader 의 --rz·zoomed·fit 으로만 바꾼다. 글을 다시 그려도 그대로 남는다.
/** 지금 설정을 화면에 맞춘다 (시작할 때 한 번, 바꿀 때마다) */
function applyReaderView() {
  const sheet = $('#reader .reader');
  const z = state.readerZoom;
  sheet.style.setProperty('--rz', String(z / 100));
  sheet.classList.toggle('zoomed', z !== 100);
  sheet.classList.toggle('fit', state.readerFit);
  updateFitHeight();
  // 끝에 닿아도 disabled 대신 aria-disabled: 포커스가 그 자리에 남아(사라지거나 옆 버튼으로 옮겨지지 않게),
  // 이어 누른 Enter·누르고 있는 반복은 아무것도 하지 않는다 (stepReaderZoom 이 범위 끝에서 그대로 둔다)
  $('#rv-out').setAttribute('aria-disabled', String(z <= READER_ZOOMS[0]));
  $('#rv-in').setAttribute('aria-disabled', String(z >= READER_ZOOMS[READER_ZOOMS.length - 1]));
  const num = $('#rv-reset');
  num.textContent = `${z}%`;
  num.setAttribute('aria-label', `보기 크기 ${z}%, 누르면 100%`);
  $('#rv-fit').setAttribute('aria-pressed', String(state.readerFit));
}

/**
 * 화면 맞춤 높이: 보이는 화면 높이에서 위아래 여유를 뺀 값.
 * vh 대신 px 로 넣는다 — zoom 안의 px 는 어느 브라우저나 같은 비율로 줄어들어, CSS 에서 --rz 로 나누면 화면 기준이 된다.
 */
/**
 * 화면 맞춤에서 빼는 세로로 아주 긴 그림 (높이 ÷ 너비가 이보다 큰 것): 한 화면에 넣으면 글씨를 못 읽을 만큼 가늘어져서
 * (예: 540×10000 캡처 → 폭 39px) 긴 캡처는 원래 폭으로 내려 읽게 둔다. 그림이 다 받아진 뒤 크기를 보고 data-tall 을 붙인다.
 */
const FIT_TALL_RATIO = 2.2;
function markTallImage(img) {
  if (img?.tagName !== 'IMG' || !img.naturalWidth || !img.naturalHeight) return;
  if (img.naturalHeight / img.naturalWidth > FIT_TALL_RATIO) img.setAttribute('data-tall', '');
  else img.removeAttribute('data-tall');
}

let fitHeight = '';
function updateFitHeight() {
  const v = `${Math.max(200, Math.round((window.innerHeight || 800) - 32))}px`;
  if (v === fitHeight) return;
  fitHeight = v;
  $('#reader .reader').style.setProperty('--fit-h', v);
}

/** [요소, 'top' | 'bottom'] 경계의 지금 화면 위치 */
const edgeY = ([el, side]) => el.getBoundingClientRect()[side];

/**
 * 화면 가운데 줄(y)이 미리보기의 어디인지 요소 경계로 적는다: 두 경계(lo·hi) 사이의 비율 f.
 * 본문·댓글은 y 에 걸친 요소 안으로 가장 깊이 들어가고, 요소 사이(여백, 글자 줄)면 바로 위 요소의 아래 끝 ~
 * 바로 아래 요소의 위 끝 사이로 잡는다 (없으면 감싼 요소의 끝). 그림 하나만 줄어도, 글이 다시 줄바꿈해도 같은 내용을 가리킨다.
 * 머리·관리 줄·꼬리는 안으로 들어가지 않는다 — 닫기 ✕·휴대폰 보기 줄처럼 화면에 고정된 요소가 있다.
 */
function readerPlaceAt(y) {
  let box = $('#reader .reader');
  for (;;) {
    let inside = null;
    let above = null;
    let below = null;
    for (let el = box.firstElementChild; el; el = el.nextElementSibling) {
      const r = el.getBoundingClientRect();
      if (!r.width && !r.height) continue; // 숨은 요소
      if (r.top <= y && y < r.bottom) {
        inside = el;
        break;
      }
      if (r.bottom <= y && (!above || r.bottom > above.r.bottom)) above = { el, r };
      if (r.top > y && (!below || r.top < below.r.top)) below = { el, r };
    }
    if (inside && !inside.matches('img, video, iframe, svg, picture, canvas') && inside.closest('#reader-body, #reader-comments')) {
      box = inside;
      continue;
    }
    const lo = inside ? [inside, 'top'] : above ? [above.el, 'bottom'] : [box, 'top'];
    const hi = inside ? [inside, 'bottom'] : below ? [below.el, 'top'] : [box, 'bottom'];
    const a = edgeY(lo);
    const span = edgeY(hi) - a;
    // 두 경계가 붙어 있으면(높이 0) 비율 대신 lo 에서의 거리
    return span > 0 ? { lo, hi, f: (y - a) / span } : { lo, hi, d: y - a };
  }
}

/**
 * 크기·화면 맞춤을 바꿔도 읽던 자리(화면 가운데에 있던 내용)를 지킨다.
 * 전체 높이 비율로는 안 된다 — 화면 맞춤은 긴 그림만 크게 줄이므로, 가운데에 있던 요소 경계를 기준으로 맞춘다.
 * 바뀐 뒤의 실제 위치를 다시 재서 차이만큼만 고치므로, 브라우저 기본 스크롤 앵커링이 먼저 움직였어도 두 번 움직이지 않는다.
 */
function keepReaderPlace(change) {
  const ov = $('#reader');
  if (ov.hidden || !(ov.scrollTop > 0)) return change(); // 맨 위면 맨 위 그대로
  const y = ov.getBoundingClientRect().top + ov.clientHeight / 2;
  const place = readerPlaceAt(y);
  change();
  if (!place.lo[0].isConnected || !place.hi[0].isConnected) return;
  const a = edgeY(place.lo);
  const now = 'f' in place ? a + place.f * (edgeY(place.hi) - a) : a + place.d;
  ov.scrollTop = Math.max(0, ov.scrollTop + (now - y));
}

/** patch: { zoom?: 50~150, fit?: boolean }. 바뀐 값만 저장한다 (저장소가 막혀도 화면은 바뀐다) */
function setReaderView(patch) {
  const zoom = readerZoomOf(patch.zoom ?? state.readerZoom);
  const fit = patch.fit ?? state.readerFit;
  if (zoom === state.readerZoom && fit === state.readerFit) return;
  const zoomChanged = zoom !== state.readerZoom;
  keepReaderPlace(() => {
    state.readerZoom = zoom;
    state.readerFit = fit;
    applyReaderView();
  });
  // 바뀐 크기를 스크린리더에 알린다 (포커스는 −/+ 에 있고 숫자는 옆 버튼에만 바뀌므로). 시작할 때는 알리지 않는다
  if (zoomChanged) $('#rv-status').textContent = `${zoom}%`;
  if ('zoom' in patch) store.set('hg.readerZoom', zoom);
  if ('fit' in patch) store.set('hg.readerFit', fit);
}

/** dir: -1 한 단계 작게, +1 한 단계 크게, 0 이면 100% (범위 끝에서는 그대로) */
function stepReaderZoom(dir) {
  const i = READER_ZOOMS.indexOf(state.readerZoom);
  const zoom = dir === 0 ? 100 : READER_ZOOMS[Math.min(READER_ZOOMS.length - 1, Math.max(0, i + dir))];
  setReaderView({ zoom });
}

const toggleReaderFit = () => setReaderView({ fit: !state.readerFit });

// ---------- 모달 공용 ----------
let lastFocus = null; // 첫 모달을 열 때 포커스가 있던 곳. 모두 닫히면 되돌린다
const anyOverlayOpen = () => $$('.overlay').some((o) => !o.hidden);
/** 모달이 열린 동안 뒤 화면은 Tab·스크린리더가 닿지 않게 */
function setBackgroundInert(on) {
  for (const n of $$('body > :not(.overlay):not(.toast)')) n.inert = on;
}
function openOverlay(el) {
  if (!anyOverlayOpen()) lastFocus = document.activeElement;
  el.hidden = false;
  document.body.style.overflow = 'hidden';
  setBackgroundInert(true);
}
function closeOverlay(el, { fromPop = false } = {}) {
  const wasOpen = !el.hidden;
  el.hidden = true;
  const allClosed = !anyOverlayOpen();
  if (allClosed) {
    document.body.style.overflow = '';
    setBackgroundInert(false);
  }
  let postId = null;
  if (el.id === 'reader') {
    postId = readerPost?.id ?? null;
    readerPost = null;
    readerSeq++;
    $('#reader-body').replaceChildren(); // 영상 재생 중지
    // 열 때 넣은 이력 한 칸을 되돌린다 (뒤로가기로 닫힌 경우는 이미 빠졌다)
    if (wasOpen && !fromPop && history.state?.reader) history.back();
  }
  el.dispatchEvent(new Event('closed'));
  if (allClosed && wasOpen) restoreFocus(postId);
}
function restoreFocus(postId) {
  const t = lastFocus;
  lastFocus = null;
  if (t?.isConnected && t !== document.body && typeof t.focus === 'function') return t.focus();
  // 관리자 처리로 행이 새로 그려졌으면 같은 글의 제목으로
  if (postId) $(`.post[data-id="${CSS.escape(postId)}"] .post-title`)?.focus();
}

let rulesLoaded = null; // 금지어 창을 열 때 불러온 값. 저장하지 않은 변경이 있으면 닫기 전에 묻는다
const rulesValues = () => ['#rules-block', '#rules-adult', '#rules-allow'].map((id) => $(id).value).join('\u0000');
function requestClose(ov) {
  if (ov.id === 'rules-modal' && rulesLoaded !== null && rulesValues() !== rulesLoaded && !confirm('저장하지 않은 금지어 변경이 있어요. 닫을까요?')) return;
  closeOverlay(ov);
}

// 누르기 시작한 곳이 바깥(오버레이)일 때만 바깥 클릭으로 닫는다.
// 시트 안에서 드래그(글자 선택 등)하다 바깥에서 놓으면 click 이 오버레이로 가기 때문.
let pressedOverlay = null;
document.addEventListener(
  'pointerdown',
  (e) => {
    pressedOverlay = e.target?.classList?.contains('overlay') ? e.target : null;
  },
  true,
);
document.addEventListener('click', (e) => {
  const ov = e.target.closest?.('.overlay');
  if (!ov) return;
  const backdrop = e.target === ov && pressedOverlay === ov;
  pressedOverlay = null;
  if (backdrop || e.target.closest('[data-close]')) requestClose(ov);
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const open = $$('.overlay').filter((o) => !o.hidden).pop();
  if (open) requestClose(open);
});
// 미리보기 단축키: - 작게, + / = 크게, 0 은 100%, f(한글 자판에서는 ㄹ) 화면 맞춤.
// 미리보기가 맨 위에 열려 있을 때만. 입력칸 안, Ctrl/⌘/Alt 조합(브라우저 확대 등)은 건드리지 않는다.
const READER_ZOOM_KEYS = new Map([['-', -1], ['+', 1], ['=', 1], ['0', 0]]);
const READER_FIT_KEYS = new Set(['f', 'F', 'ㄹ']);
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing || e.defaultPrevented) return;
  const top = $$('.overlay').filter((o) => !o.hidden).pop();
  if (!top || top.id !== 'reader') return;
  if (e.target?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return;
  if (READER_ZOOM_KEYS.has(e.key)) stepReaderZoom(READER_ZOOM_KEYS.get(e.key));
  else if (READER_FIT_KEYS.has(e.key)) {
    if (!e.repeat) toggleReaderFit(); // 누르고 있어도 켜졌다 꺼졌다 반복하지 않게
  } else return;
  e.preventDefault();
});
// 미리보기가 열린 채 뒤로가기 → 미리보기만 닫는다
window.addEventListener('popstate', () => {
  const ov = $('#reader');
  if (!ov.hidden) closeOverlay(ov, { fromPop: true });
});

/** 비밀번호 창. 성공하면 true. 같은 창이 이미 떠 있으면 그 결과를 같이 기다린다. */
const UNLOCK_ENDPOINT = '/api/unlock';
let pwPending = null; // { endpoint, promise }
function promptPassword({ title, desc, endpoint }) {
  if (pwPending?.endpoint === endpoint) return pwPending.promise;
  if (pwPending) closeOverlay($('#pw-modal')); // 다른 용도의 창이 떠 있으면 그건 취소(false)로 끝낸다
  const promise = new Promise((resolve) => {
    const ov = $('#pw-modal');
    $('#pw-title').textContent = title;
    $('#pw-desc').textContent = desc;
    $('#pw-error').hidden = true;
    const input = $('#pw-input');
    input.value = '';
    openOverlay(ov);
    setTimeout(() => input.focus(), 30);
    let settled = false;
    let submitting = false;
    const form = $('#pw-form');
    const onSubmit = async (e) => {
      e.preventDefault();
      if (submitting || settled) return; // Enter 연타로 두 번 보내지 않게 (시도 횟수 제한)
      submitting = true;
      try {
        await api(endpoint, { body: { password: input.value } });
        if (settled) return; // 응답을 기다리는 사이 창이 닫혔다
        settled = true;
        cleanup();
        closeOverlay(ov);
        resolve(true);
      } catch (err) {
        if (settled) return;
        $('#pw-error').textContent = err.message;
        $('#pw-error').hidden = false;
        input.select();
      } finally {
        submitting = false;
      }
    };
    const onClosed = () => {
      cleanup();
      if (!settled) {
        settled = true;
        resolve(false);
      }
    };
    function cleanup() {
      form.removeEventListener('submit', onSubmit);
      ov.removeEventListener('closed', onClosed);
    }
    form.addEventListener('submit', onSubmit);
    ov.addEventListener('closed', onClosed);
  });
  const entry = { endpoint, promise };
  pwPending = entry;
  promise.then(() => {
    if (pwPending === entry) pwPending = null;
  });
  return promise;
}

let unlockPending = null; // 목록과 미리보기가 동시에 잠금 해제를 요청해도 한 번만 묻고, 메타도 한 번만 다시 받는다
function unlockAdult() {
  if (!unlockPending) {
    const run = (async () => {
      const ok = await promptPassword({ title: '🔒 그라운즈', desc: '성인용 게시판이에요. 비밀번호를 입력하세요. (12시간 동안 열려 있어요)', endpoint: UNLOCK_ENDPOINT });
      if (ok) {
        await loadMeta().catch(() => {});
        toast('잠금을 풀었어요');
      }
      return ok;
    })();
    unlockPending = run;
    run
      .finally(() => {
        if (unlockPending === run) unlockPending = null;
      })
      .catch(() => {});
  }
  return unlockPending;
}

// ---------- 실시간 알림 (SSE) ----------
/**
 * 수집 이벤트에서 "지금 보는 게시판"에 들어온 새 글 수.
 * 서버가 게시판별 수(counts)를 주면 그대로, 아니면 공개 글 수(addedPublic, 옛 서버면 added)로 어림한다.
 * exact 가 false 면 배너에 숫자를 쓰지 않는다 (출처별·픽 게시판, 검색 중 등).
 */
function freshFor(d) {
  const b = state.board;
  if (b === 'shorts') return { n: 0, exact: true };
  const c = d.counts;
  if (c) {
    const v = typeof c[b] === 'number' ? c[b] : c.bySource?.[b];
    if (typeof v === 'number') return { n: v, exact: !state.q };
    // 서버는 저장된 글이 있는 출처만 bySource 에 넣는다. 출처 게시판인데 없으면 그 출처의 새 글은 0개
    // (전체 공개 수로 어림하면 글이 하나도 없는 출처 게시판에 다른 출처의 새 글 배너가 뜬다)
    if (c.bySource && b !== 'adult' && b !== 'filtered') return { n: 0, exact: true };
  }
  if (b === 'adult' || b === 'filtered') {
    // 공개 글 수만 오므로, 공개되지 않은 새 글이 있었는지만 본다 (몇 개인지는 모름)
    const rest = d.addedPublic == null ? d.added || 0 : d.added == null ? 0 : d.added - d.addedPublic;
    return { n: Math.max(0, rest), exact: false };
  }
  return { n: Math.max(0, d.addedPublic ?? d.added ?? 0), exact: b === 'all' && !state.q };
}

let eventSource = null;
/**
 * 관리자 여부는 연결할 때의 쿠키로 정해지므로, 로그인/로그아웃 뒤에는 다시 연결한다.
 * 공개·클라우드에는 SSE 가 없다 → 메타 확인을 (관리자 여부에 맞는 간격으로) 다시 건다.
 */
function connectEvents() {
  eventSource?.close();
  eventSource = null;
  if (usesPolling()) {
    if (!state.meta?.admin) crawlFollow = null;
    startPolling();
    return null;
  }
  const es = new EventSource('/api/events');
  eventSource = es;
  let opened = false;
  es.addEventListener('open', () => {
    // 끊겼다가 저절로 다시 붙은 경우: 그사이 놓친 상태를 메타로 맞춘다
    if (opened) loadMeta().catch(() => {});
    opened = true;
  });
  es.addEventListener('crawl', (e) => {
    const d = JSON.parse(e.data);
    loadMeta().catch(() => {});
    const { n, exact } = freshFor(d);
    if (!n) {
      if (state.meta?.admin) toast(d.added ? `수집 완료 — 이 게시판 새 글 없음 (전체 ${d.added}개)` : '수집 완료 — 새 글 없음');
      return;
    }
    const atTop = window.scrollY < 200 && !anyOverlayOpen();
    if (state.sort === 'new' && atTop && !state.q) {
      // 맨 위에서 보고 있으면 바로 갱신하고, 실제로 새로 생긴 행만 세어 알린다
      const before = new Set(shownRows().map((li) => li.dataset.id));
      loadPosts(true, { keep: true }).then(() => {
        const fresh = shownRows().filter((li) => !before.has(li.dataset.id));
        fresh.forEach((li) => li.classList.add('fresh'));
        if (fresh.length) toast(`새 글 ${fresh.length}개가 들어왔어요`);
        else if (state.meta?.admin) toast('수집 완료 — 이 게시판 새 글 없음');
      });
    } else {
      state.pendingNew += n;
      state.pendingExact &&= exact;
      const b = $('#new-banner');
      b.textContent = state.pendingExact ? `새 글 ${state.pendingNew}개 — 눌러서 보기` : '새 글이 들어왔어요 — 눌러서 보기';
      b.hidden = false;
    }
  });
  es.addEventListener('live', (e) => {
    const d = JSON.parse(e.data);
    if (state.meta) state.meta.live = { ...state.meta.live, ...d };
    renderLive(state.meta?.live);
    if (state.meta?.admin) renderAdminBar(); // 다른 탭에서 켜고 끈 것도 토글에 반영
  });
  es.addEventListener('state', (e) => {
    const d = JSON.parse(e.data);
    if (!state.meta?.admin) return;
    state.meta.live = d;
    renderLive(d);
    renderAdminBar();
  });
  // 공개 사이트에 올린 결과 (로컬 서버가 보내면). 관리자 바의 반영 상태만 바꾼다
  es.addEventListener('publish', (e) => {
    if (!state.meta?.admin) return;
    let d;
    try {
      d = JSON.parse(e.data);
    } catch {
      return;
    }
    state.meta.publish = { ...state.meta.publish, ...d };
    renderPublish();
  });
  return es;
}

// ---------- 공개·클라우드: 새 글 확인 (주기적으로 /api/meta) ----------
// 공개 사이트와 클라우드의 방문자는 2분, 클라우드의 관리자는 30초, '지금 수집'을 누른 뒤에는 끝날 때까지 3초마다.
let seenCrawlAt = null; // 지금 목록이 반영한 lastCrawlAt (loadPosts 가 처음부터 다시 받을 때 맞춘다)
let pollTimer = null;
let pollDue = false; // 탭이 숨겨진 동안 확인 차례가 지나갔다 → 돌아오면 한 번 확인
let pollStarted = false;

function pollDelay() {
  if (!isCloud() || !state.meta?.admin) return PUBLIC_POLL_MS;
  return crawlFollow ? CRAWL_POLL_MS : CLOUD_ADMIN_POLL_MS;
}
/** 확인을 시작한다. 이미 돌고 있으면 지금 상태(관리자 여부·수집 중)에 맞는 간격으로 다시 건다 */
function startPolling() {
  if (!pollStarted) {
    pollStarted = true;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'hidden' && pollDue) pollMeta();
    });
  }
  schedulePoll();
}
function schedulePoll(ms = pollDelay()) {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(() => {
    pollTimer = null;
    // 숨겨진 탭에서는 쉬었다가, 다시 보일 때 한 번만 확인한다
    if (document.visibilityState === 'hidden') pollDue = true;
    else pollMeta();
  }, ms);
}
async function pollMeta() {
  pollDue = false;
  try {
    const wasAdmin = !!state.meta?.admin;
    await loadMeta();
    if (!!state.meta?.admin !== wasAdmin) {
      // 다른 탭에서 로그인/로그아웃했거나 로그인이 만료됐다: 간격을 맞추고 목록을 그 권한으로 다시 받는다
      if (!state.meta?.admin) crawlFollow = null;
      if (!state.meta?.admin && ['shorts', 'filtered'].includes(state.board)) go({ board: 'story' });
      else loadPosts(true);
      return;
    }
    followCrawl();
    const at = state.meta?.live?.lastCrawlAt;
    if (at && at !== seenCrawlAt) {
      const b = $('#new-banner');
      b.textContent = '새 글이 있어요 — 눌러서 보기';
      b.hidden = false;
    }
  } catch {
    // 잠깐 연결이 안 되면 다음 차례에 다시
  } finally {
    schedulePoll();
  }
}

/**
 * 클라우드 '지금 수집': 시작을 요청하고, 끝날 때까지 몇 초마다 메타를 받아 관리자 바·표시를 맞춘다.
 * 끝나면 알리고, 새 수집이 반영됐으면 다음 확인과 같은 새 글 배너가 뜬다.
 */
async function crawlNowCloud() {
  if (crawlFollow) return;
  crawlFollow = { checks: 0, sawRunning: false, fromAt: state.meta?.live?.lastCrawlAt ?? null };
  renderAdminBar();
  renderLive(state.meta?.live);
  let r;
  try {
    r = await api('/api/admin/crawl', { body: {} });
  } catch (err) {
    crawlFollow = null;
    renderAdminBar();
    renderLive(state.meta?.live);
    toast(`실패: ${err.message}`);
    return;
  }
  if (r?.running && state.meta) state.meta.live = { ...state.meta.live, running: true };
  toast(r?.started === false ? '이미 수집 중이에요. 끝나면 알려드릴게요' : '수집을 시작했어요. 끝나면 알려드릴게요');
  // 응답이 이미 끝났다고 하면(running: false) 바로 확인한다
  schedulePoll(r?.running === false ? 0 : CRAWL_POLL_MS);
}

/** 메타를 받을 때마다: 따라가던 수집이 끝났는지 본다 */
function followCrawl() {
  const f = crawlFollow;
  if (!f) return;
  const lv = state.meta?.live || {};
  f.checks++;
  let done = false;
  if (!state.meta?.admin || f.checks >= CRAWL_FOLLOW_MAX) {
    crawlFollow = null; // 로그아웃했거나 너무 오래 걸린다: 평소 간격으로 (끝나면 다음 확인에서 보인다)
  } else if (lv.running) {
    f.sawRunning = true;
    return;
  } else {
    done = f.sawRunning || (lv.lastCrawlAt ?? null) !== f.fromAt;
    if (!done && f.checks < 3) return; // 서버가 아직 시작 전일 수 있다
    crawlFollow = null;
  }
  renderAdminBar();
  renderLive(state.meta?.live);
  if (done) toast('수집을 마쳤어요');
}

// ---------- 이벤트 연결 ----------
function bind() {
  $('#sorts').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-sort]');
    if (b) go({ sort: b.dataset.sort });
  });
  $('#stage-filter').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-stage]');
    if (b) go({ stage: b.dataset.stage });
  });
  let searchTimer;
  // 서버도 q 를 trim 하므로, 끝 공백만 늘었거나 같은 검색어면 다시 불러오지 않는다
  const search = (q) => {
    clearTimeout(searchTimer);
    if (q === state.q) return;
    searchEcho = q;
    go({ q });
  };
  $('#search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => search(e.target.value.trim()), 350);
  });
  $('#search-form').addEventListener('submit', (e) => {
    e.preventDefault();
    search($('#search').value.trim()); // 남아 있던 디바운스도 여기서 취소된다
  });
  // 다음 페이지 위치는 loadPosts 가 이미 그린 행 수로 정한다 (실패해도 어긋나지 않게 여기서 세지 않는다)
  $('#btn-more').addEventListener('click', () => loadPosts(false));
  new IntersectionObserver((entries) => {
    if (entries.some((en) => en.isIntersecting) && state.hasMore && !state.loading) loadPosts(false);
  }, { rootMargin: '400px' }).observe($('#btn-more').parentElement);
  $('#new-banner').addEventListener('click', () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
    if (state.sort !== 'new') go({ sort: 'new' });
    else loadPosts(true);
  });

  // 보기 설정
  $('#btn-settings').addEventListener('click', () => {
    $$('input[name="click"]').forEach((r) => (r.checked = r.value === state.clickMode));
    $$('input[name="source"]').forEach((r) => (r.checked = (r.value === 'on') === state.showSource));
    $$('input[name="theme"]').forEach((r) => (r.checked = r.value === state.theme));
    openOverlay($('#settings-modal'));
  });
  $('#settings-modal').addEventListener('change', (e) => {
    if (e.target.name === 'click') {
      state.clickMode = e.target.value;
      store.set('hg.click', state.clickMode);
    }
    if (e.target.name === 'source') {
      state.showSource = e.target.value === 'on';
      store.set('hg.showSource', state.showSource);
      applySourceVisibility();
    }
    if (e.target.name === 'theme') {
      state.theme = e.target.value;
      store.set('hg.theme', state.theme);
      applyTheme();
    }
  });

  // 미리보기 보기 크기·화면 맞춤 (고정 줄이라 여기서 한 번만 붙인다)
  const zoomBtn = (sel, dir) => $(sel).addEventListener('click', () => stepReaderZoom(dir));
  zoomBtn('#rv-out', -1);
  zoomBtn('#rv-in', 1);
  zoomBtn('#rv-reset', 0);
  $('#rv-fit').addEventListener('click', toggleReaderFit);
  window.addEventListener('resize', updateFitHeight);
  // load 는 버블링하지 않으니 캡처 단계에서 받는다 (본문을 다시 그려도 그대로)
  $('#reader-body').addEventListener('load', (e) => markTallImage(e.target), true);

  // 관리자
  $('#btn-admin').addEventListener('click', async () => {
    if (isPublic()) return; // 공개 사이트에는 관리자 기능이 없다
    if (state.meta?.admin) {
      state.adminOpen = !state.adminOpen;
      store.set('hg.adminOpen', state.adminOpen);
      renderAdminBar();
      return;
    }
    // 클라우드에서는 누구나 이 창을 볼 수 있으므로 안내는 짧고 중립적으로
    const desc = isCloud() ? '관리자 비밀번호를 입력하세요.' : '실시간 수집, 걸러진 글 게시, 쇼츠 후보함을 관리해요.';
    const ok = await promptPassword({ title: '관리자 로그인', desc, endpoint: '/api/admin/login' });
    if (ok) {
      state.adminOpen = true;
      await loadMeta();
      connectEvents(); // 관리자 쿠키로 다시 연결해야 실시간 상태('state')를 받는다 (클라우드: 30초 간격으로)
      await loadPosts(true);
      toast('관리자로 로그인했어요');
    }
  });
  $('#btn-logout').addEventListener('click', async () => {
    await api('/api/admin/logout', { body: {} }).catch(() => {});
    await loadMeta();
    connectEvents();
    if (['shorts', 'filtered'].includes(state.board)) go({ board: 'story' });
    else loadPosts(true);
    toast('로그아웃했어요');
  });
  $('#live-toggle').addEventListener('change', async (e) => {
    try {
      const lv = await api('/api/admin/live', { body: { live: e.target.checked } });
      state.meta.live = lv;
      renderLive(lv);
      renderAdminBar();
      toast(lv.live ? `실시간 ON — ${lv.intervalMin}분마다 자동 수집해요` : '실시간 OFF — 자동 수집을 멈췄어요');
    } catch (err) {
      e.target.checked = !e.target.checked;
      toast(`실패: ${err.message}`);
    }
  });
  $('#live-interval').addEventListener('change', async (e) => {
    try {
      const lv = await api('/api/admin/live', { body: { intervalMin: Number(e.target.value) } });
      state.meta.live = lv;
      renderAdminBar();
      toast(`수집 간격을 ${lv.intervalMin}분으로 바꿨어요`);
    } catch (err) {
      toast(`실패: ${err.message}`);
    }
  });
  $('#btn-crawl').addEventListener('click', async () => {
    if (isCloud()) return crawlNowCloud(); // SSE 가 없으니 끝날 때까지 메타로 따라간다
    try {
      await api('/api/admin/crawl', { body: {} });
      $('#btn-crawl').disabled = true;
      $('#btn-crawl').textContent = '수집 중…';
      renderLive({ ...state.meta.live, running: true });
      toast('수집을 시작했어요. 끝나면 알려드릴게요');
    } catch (err) {
      toast(`실패: ${err.message}`);
    }
  });
  $('#btn-publish').addEventListener('click', publishNow);
  $('#btn-sources').addEventListener('click', () => {
    $('#source-status').hidden = !$('#source-status').hidden;
  });
  $('#btn-rules').addEventListener('click', async () => {
    try {
      const r = await api('/api/admin/rules');
      $('#rules-block').value = r.block.join('\n');
      $('#rules-adult').value = r.adult.join('\n');
      $('#rules-allow').value = r.allow.join('\n');
      $('#rules-result').textContent = '';
      rulesLoaded = rulesValues();
      openOverlay($('#rules-modal'));
    } catch (err) {
      toast(`실패: ${err.message}`);
    }
  });
  $('#rules-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const lines = (id) => $(id).value.split('\n').map((s) => s.trim()).filter(Boolean);
    try {
      const r = await api('/api/admin/rules', { body: { block: lines('#rules-block'), adult: lines('#rules-adult'), allow: lines('#rules-allow') } });
      $('#rules-result').textContent = `저장했어요. 다시 판정해서 ${r.changed}개 글의 분류가 바뀌었어요.`;
      rulesLoaded = rulesValues();
      refreshMetaSoon();
      loadPosts(true);
    } catch (err) {
      $('#rules-result').textContent = `실패: ${err.message}`;
    }
  });

  window.addEventListener('hashchange', route);
}

// ---------- 시작 ----------
applyTheme();
applySourceVisibility();
applyReaderView();
bind();
try {
  await loadMeta();
} catch (e) {
  $('#empty').hidden = false;
  $('#empty').textContent = `서버에 연결하지 못했어요: ${e.message}`;
}
if (!location.hash) history.replaceState(null, '', '#/b/story');
await route();
// 로컬은 SSE, 공개 사이트·클라우드는 실시간 연결 대신 주기적으로 메타를 다시 받아 새 글을 알린다
connectEvents();
setInterval(() => {
  // 상대 시간 표기 갱신
  $$('.post time').forEach((t) => (t.textContent = timeAgo(t.getAttribute('datetime'))));
  if (usesPolling()) renderLive(state.meta?.live);
  else renderPublish();
}, 60e3);
