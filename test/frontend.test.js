// 프런트엔드(public/app.js) 회귀 테스트.
// 브라우저 없이 돌리려고, index.html 을 htmlparser2 로 읽어 작은 가짜 DOM 을 만들고(선택자는 css-select),
// app.js 를 node:vm 안에서 그대로 실행한다. fetch / EventSource / 타이머 / history 는 가짜로 바꿔 끼운다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'htmlparser2';
import { selectAll, selectOne, is } from 'css-select';
import { textContent as domText } from 'domutils';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_SRC = readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
const HTML_SRC = readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const CSS_SRC = readFileSync(path.join(ROOT, 'public/style.css'), 'utf8');

// ---------------------------------------------------------------- 가짜 DOM
class FakeEvent {
  constructor(type, init = {}) {
    Object.assign(this, init);
    this.type = type;
    this.bubbles = !!init.bubbles;
    this.defaultPrevented = false;
    this.target = null;
    this.currentTarget = null;
    this._stop = false;
  }
  preventDefault() {
    this.defaultPrevented = true;
  }
  stopPropagation() {
    this._stop = true;
  }
}

class Listeners {
  constructor() {
    this.map = {};
  }
  add(type, fn, opts) {
    const capture = typeof opts === 'boolean' ? opts : !!opts?.capture;
    const once = typeof opts === 'object' && !!opts?.once;
    const arr = (this.map[type] ||= []);
    if (!arr.some((l) => l.fn === fn && l.capture === capture)) arr.push({ fn, capture, once });
  }
  remove(type, fn, opts) {
    const capture = typeof opts === 'boolean' ? opts : !!opts?.capture;
    this.map[type] = (this.map[type] || []).filter((l) => !(l.fn === fn && l.capture === capture));
  }
  count(type) {
    return (this.map[type] || []).length;
  }
  invoke(node, ev, phase) {
    for (const l of [...(this.map[ev.type] || [])]) {
      if (phase === 'capture' && !l.capture) continue;
      if (phase === 'bubble' && l.capture) continue;
      if (l.once) this.remove(ev.type, l.fn, l.capture);
      ev.currentTarget = node;
      l.fn.call(node, ev);
    }
  }
}

class FNode {
  constructor() {
    this.parent = null;
    this._ls = new Listeners();
  }
  get parentNode() {
    return this.parent;
  }
  get parentElement() {
    return this.parent && this.parent.type === 'tag' ? this.parent : null;
  }
  get prev() {
    const sib = this.parent?.children;
    const i = sib ? sib.indexOf(this) : -1;
    return i > 0 ? sib[i - 1] : null;
  }
  get next() {
    const sib = this.parent?.children;
    const i = sib ? sib.indexOf(this) : -1;
    return i >= 0 && i < sib.length - 1 ? sib[i + 1] : null;
  }
  get isConnected() {
    let n = this;
    while (n.parent) n = n.parent;
    return n.type === 'root';
  }
  remove() {
    if (!this.parent) return;
    this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }
  addEventListener(type, fn, opts) {
    this._ls.add(type, fn, opts);
  }
  removeEventListener(type, fn, opts) {
    this._ls.remove(type, fn, opts);
  }
  dispatchEvent(ev) {
    ev.target = this;
    const path = [];
    for (let n = this; n; n = n.parent) path.push(n);
    if (this.type !== 'window' && this._win) path.push(this._win);
    for (let i = path.length - 1; i >= 1 && !ev._stop; i--) path[i]._ls.invoke(path[i], ev, 'capture');
    if (!ev._stop) this._ls.invoke(this, ev, 'target');
    if (ev.bubbles) for (let i = 1; i < path.length && !ev._stop; i++) path[i]._ls.invoke(path[i], ev, 'bubble');
    return !ev.defaultPrevented;
  }
}

class FText extends FNode {
  constructor(data) {
    super();
    this.type = 'text';
    this.data = String(data);
  }
  get textContent() {
    return this.data;
  }
  set textContent(v) {
    this.data = String(v);
  }
}

function toNode(doc, v) {
  return v instanceof FNode ? v : new FText(String(v)); // 실제 DOM 처럼 null 도 "null" 글자가 된다
}

class FElement extends FNode {
  constructor(doc, name, attribs = {}) {
    super();
    this.type = 'tag';
    this.name = name.toLowerCase();
    this.attribs = { ...attribs };
    this.children = [];
    this.ownerDocument = doc;
    this._win = doc._win;
    // style.setProperty('--x', …) (CSS 변수) 도 받는다. 값은 그대로 같은 이름의 속성으로 남긴다
    this.style = Object.defineProperties({}, {
      setProperty: { value(k, v) { this[k] = String(v); } },
      getPropertyValue: { value(k) { return this[k] ?? ''; } },
      removeProperty: { value(k) { delete this[k]; } },
    });
    this.inert = false;
    const el = this;
    const key = (p) => `data-${String(p).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
    this.dataset = new Proxy(
      {},
      {
        get: (_, p) => el.attribs[key(p)],
        set: (_, p, v) => ((el.attribs[key(p)] = String(v)), true),
        has: (_, p) => key(p) in el.attribs,
        deleteProperty: (_, p) => delete el.attribs[key(p)],
      },
    );
    const list = () => (el.attribs.class || '').split(/\s+/).filter(Boolean);
    const setList = (a) => (el.attribs.class = a.join(' '));
    this.classList = {
      add: (...c) => setList([...new Set([...list(), ...c])]),
      remove: (...c) => setList(list().filter((x) => !c.includes(x))),
      contains: (c) => list().includes(c),
      toggle: (c, force) => {
        const on = force === undefined ? !list().includes(c) : !!force;
        if (on) el.classList.add(c);
        else el.classList.remove(c);
        return on;
      },
    };
  }
  get tagName() {
    return this.name.toUpperCase();
  }
  // children 은 css-select 가 쓰는 대로 글자 노드까지 담는다. 요소만 따라가는 길은 실제 DOM 처럼 이 둘로
  get firstElementChild() {
    return this.children.find((n) => n.type === 'tag') || null;
  }
  get nextElementSibling() {
    const sib = this.parent?.children || [];
    return sib.slice(sib.indexOf(this) + 1).find((n) => n.type === 'tag') || null;
  }
  get id() {
    return this.attribs.id || '';
  }
  get className() {
    return this.attribs.class || '';
  }
  set className(v) {
    this.attribs.class = String(v);
  }
  get hidden() {
    return 'hidden' in this.attribs;
  }
  set hidden(v) {
    if (v) this.attribs.hidden = '';
    else delete this.attribs.hidden;
  }
  get disabled() {
    return 'disabled' in this.attribs;
  }
  set disabled(v) {
    if (v) this.attribs.disabled = '';
    else delete this.attribs.disabled;
  }
  get title() {
    return this.attribs.title || '';
  }
  set title(v) {
    this.attribs.title = String(v);
  }
  get name_() {
    return this.attribs.name;
  }
  get value() {
    if (this._value !== undefined) return this._value;
    if (this.name === 'textarea') return this.textContent;
    if (this.name === 'select') return this.options.find((o) => 'selected' in o.attribs)?.value ?? this.options[0]?.value ?? '';
    return this.attribs.value ?? '';
  }
  set value(v) {
    this._value = String(v);
  }
  get options() {
    return selectAll('option', this);
  }
  get textContent() {
    return domText(this);
  }
  set textContent(v) {
    this.replaceChildren(String(v));
  }
  set innerHTML(html) {
    this.replaceChildren(...convert(this.ownerDocument, parseDocument(String(html)).children));
  }
  getAttribute(k) {
    return k in this.attribs ? this.attribs[k] : null;
  }
  setAttribute(k, v) {
    this.attribs[k] = String(v);
  }
  removeAttribute(k) {
    delete this.attribs[k];
  }
  hasAttribute(k) {
    return k in this.attribs;
  }
  append(...nodes) {
    for (const v of nodes) {
      const n = toNode(this.ownerDocument, v);
      n.remove();
      n.parent = this;
      this.children.push(n);
    }
  }
  replaceChildren(...nodes) {
    for (const c of [...this.children]) c.remove();
    this.append(...nodes);
  }
  replaceWith(node) {
    const p = this.parent;
    if (!p) return;
    const n = toNode(this.ownerDocument, node);
    n.remove();
    const i = p.children.indexOf(this);
    p.children.splice(i, 1, n);
    n.parent = p;
    this.parent = null;
  }
  querySelector(sel) {
    return selectOne(sel, this);
  }
  querySelectorAll(sel) {
    return selectAll(sel, this);
  }
  matches(sel) {
    return is(this, sel);
  }
  closest(sel) {
    for (let n = this; n && n.type === 'tag'; n = n.parent) if (is(n, sel)) return n;
    return null;
  }
  focus() {
    this.ownerDocument.activeElement = this;
  }
  blur() {
    if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body;
  }
  select() {}
  getBoundingClientRect() {
    return this._rect || { top: 100000, bottom: 100100, left: 0, right: 0, width: 0, height: 100 };
  }
  // 테스트 도우미
  click() {
    this.dispatchEvent(new FakeEvent('pointerdown', { bubbles: true }));
    this.dispatchEvent(new FakeEvent('click', { bubbles: true }));
  }
}

function convert(doc, nodes) {
  const out = [];
  for (const n of nodes) {
    if (n.type === 'text') out.push(new FText(n.data));
    else if (n.type === 'tag' || n.type === 'script' || n.type === 'style') {
      const el = new FElement(doc, n.name, n.attribs);
      el.append(...convert(doc, n.children || []));
      out.push(el);
    }
  }
  return out;
}

class FDocument extends FNode {
  constructor(win, html) {
    super();
    this.type = 'root';
    this._win = win;
    this.children = [];
    this.title = '';
    this.visibilityState = 'visible'; // 테스트가 'hidden' 으로 바꾸고 visibilitychange 를 보낸다
    const parsed = convert(this, parseDocument(html).children);
    for (const n of parsed) {
      n.parent = this;
      this.children.push(n);
    }
    this.documentElement = selectOne('html', this);
    this.body = selectOne('body', this);
    this.activeElement = this.body;
  }
  createElement(tag) {
    return new FElement(this, tag);
  }
  createTextNode(t) {
    return new FText(t);
  }
  querySelector(sel) {
    return selectOne(sel, this);
  }
  querySelectorAll(sel) {
    return selectAll(sel, this);
  }
}

// ---------------------------------------------------------------- 가짜 시계 (setTimeout / rAF)
const drain = async () => {
  for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
};
function makeClock() {
  let now = 0;
  let seq = 0;
  const timers = new Map();
  return {
    setTimeout(fn, ms = 0, ...args) {
      const id = ++seq;
      timers.set(id, { fn, at: now + Math.max(0, Number(ms) || 0), args });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    async advance(ms = 0) {
      const end = now + ms;
      for (let guard = 0; guard < 1000; guard++) {
        await drain();
        let pick = null;
        for (const [id, t] of timers) if (t.at <= end && (!pick || t.at < pick[1].at)) pick = [id, t];
        if (!pick) break;
        timers.delete(pick[0]);
        now = Math.max(now, pick[1].at);
        pick[1].fn(...pick[1].args);
      }
      now = end;
      await drain();
    },
  };
}

// ---------------------------------------------------------------- 가짜 서버
function makePosts(n, prefix = 'p') {
  return Array.from({ length: n }, (_, i) => ({
    id: `${prefix}${i}`,
    source: 'dogdrip',
    title: `글 ${prefix}${i}`,
    url: `https://example.invalid/${prefix}${i}`,
    firstSeenAt: new Date(Date.now() - i * 60e3).toISOString(),
    status: 'ok',
    shortsScore: 50,
    alsoOn: [],
  }));
}

function makeServer({ posts = makePosts(100), admin = false, adult = false, meta = {}, live = null } = {}) {
  const s = {
    posts,
    admin,
    adult,
    // 주면 src/server.js 처럼 방문자에겐 live·lastCrawlAt 만, 관리자에겐 전부(intervalMin·running·nextRunAt) 보낸다
    live,
    requests: [],
    fail: 0, // 0 이 아니면 그 수만큼 /api/posts 를 500 으로
    readDeferred: null, // 설정하면 /read 응답을 테스트가 직접 푼다
    extraMeta: meta,
    rules: { block: ['정치'], adult: [], allow: [] },
    list(board, q) {
      let list = s.posts.filter((p) => (board === 'adult' ? p.status === 'adult' : board === 'filtered' ? p.status === 'blocked' : p.status === 'ok'));
      if (q) list = list.filter((p) => p.title.toLowerCase().includes(q.toLowerCase()));
      return list;
    },
    async handle(u, method, body) {
      const p = u.pathname;
      if (p === '/api/meta')
        return {
          status: 200,
          body: {
            siteName: '웃참',
            pickCount: 1,
            adult: s.adult,
            admin: s.admin,
            live: s.live
              ? { live: s.live.live, lastCrawlAt: s.live.lastCrawlAt, ...(s.admin ? s.live : {}) }
              : { live: false, lastCrawlAt: null, ...(s.admin ? { intervalMin: 15, running: false, nextRunAt: null } : {}) },
            sources: [{ id: 'dogdrip', name: '개드립', short: '개드립', color: '#000', active: true, count: 3 }],
            ...(s.admin ? { stats: { public: 3, adult: 0, blocked: 2, pending: 1, shorts: 0 }, ai: { enabled: false } } : {}),
            ...s.extraMeta,
          },
        };
      if (p === '/api/posts') {
        if (s.fail > 0) {
          s.fail--;
          return { status: 500, body: { error: '서버 오류' } };
        }
        const board = u.searchParams.get('board');
        if (board === 'adult' && !s.adult) return { status: 403, body: { error: 'locked' } };
        const page = Number(u.searchParams.get('page')) || 1;
        const size = Number(u.searchParams.get('size')) || 30;
        const list = s.list(board, u.searchParams.get('q'));
        return { status: 200, body: { page, size, total: list.length, hasMore: page * size < list.length, items: list.slice((page - 1) * size, page * size) } };
      }
      if (p === '/api/unlock') {
        if (body?.password !== 'pw') return { status: 401, body: { error: '비밀번호가 달라요' } };
        s.adult = true;
        return { status: 200, body: { ok: true } };
      }
      if (p === '/api/admin/login') {
        if (body?.password !== 'admin') return { status: 401, body: { error: '비밀번호가 달라요' } };
        s.admin = true;
        return { status: 200, body: { ok: true } };
      }
      if (p === '/api/admin/logout') {
        s.admin = false;
        return { status: 200, body: { ok: true } };
      }
      if (p === '/api/admin/rules') return { status: 200, body: { ...s.rules, changed: 0 } };
      if (p === '/api/admin/crawl') {
        if (!s.admin) return { status: 401, body: { error: '관리자 전용' } };
        if (s.onCrawl) return s.onCrawl();
        return { status: 202, body: { started: true, running: true } };
      }
      if (p === '/api/admin/publish') {
        if (!s.admin) return { status: 401, body: { error: '관리자 전용' } };
        if (s.onPublish) return s.onPublish();
        s.extraMeta.publish = { ...s.extraMeta.publish, lastOkAt: new Date().toISOString(), lastError: null, running: false };
        return { status: 200, body: { ok: true } };
      }
      let m = /^\/api\/admin\/posts\/(.+)$/.exec(p);
      if (m) {
        const post = s.posts.find((x) => x.id === decodeURIComponent(m[1]));
        if ('manual' in body) {
          post.manual = body.manual;
          post.status = body.manual || 'ok';
        }
        if ('shorts' in body) post.shorts = body.shorts ? { note: '', ...post.shorts, ...body.shorts } : null;
        return { status: 200, body: { post: { ...post } } };
      }
      m = /^\/api\/posts\/(.+)\/read$/.exec(p);
      if (m) {
        const post = s.posts.find((x) => x.id === decodeURIComponent(m[1]));
        const data = { post: { ...post }, html: '<p>본문</p>', text: '본문', mediaCount: 0, comments: [] };
        if (s.readDeferred) return s.readDeferred(data);
        return { status: 200, body: data };
      }
      return { status: 404, body: { error: 'not found' } };
    },
  };
  return s;
}

// ---------------------------------------------------------------- 앱 띄우기
const HOOK = `globalThis.__app = {
  state, loadPosts, route, go, hashOf, parseHash, freshFor, promptPassword, unlockAdult, openReader, closeOverlay,
  renderReaderAdmin, renderBoards, adminUpdate, connectEvents, shownRows,
  loadMeta, pollMeta, publishInfo, renderPublish,
};
`;

// stored: 처음부터 localStorage 에 있던 값 { 키: JSON 문자열 }. brokenStorage: 읽기·쓰기가 모두 예외 (사생활 보호 모드 등)
async function boot({ hash = '', server = makeServer(), scrollY = 0, stored = {}, brokenStorage = false } = {}) {
  const marker = '// ---------- 시작 ----------';
  assert.ok(APP_SRC.includes(marker), 'app.js 의 시작 구역 표시가 바뀌었어요 (테스트 훅 위치)');
  const src = `(async () => { 'use strict';\n${APP_SRC.replace(marker, `${HOOK}${marker}`)}\n})()`;

  const clock = makeClock();
  const win = new FNode();
  win.type = 'window';
  const doc = new FDocument(win, HTML_SRC);

  // history / location
  const base = 'http://test.local/';
  const entries = [{ state: null, url: base + hash }];
  let idx = 0;
  const cur = () => entries[idx];
  const hashOfUrl = (u) => {
    const i = u.indexOf('#');
    return i < 0 ? '' : u.slice(i);
  };
  const resolveUrl = (u) => (u == null ? cur().url : u.startsWith('#') ? base + u : u);
  const fire = (type) => clock.setTimeout(() => win.dispatchEvent(new FakeEvent(type)), 0);
  const history = {
    get state() {
      return cur().state;
    },
    get length() {
      return entries.length;
    },
    pushState(state, _t, url) {
      entries.splice(idx + 1);
      entries.push({ state, url: resolveUrl(url) });
      idx++;
    },
    replaceState(state, _t, url) {
      entries[idx] = { state, url: resolveUrl(url) };
    },
    go(delta) {
      const before = hashOfUrl(cur().url);
      const to = idx + delta;
      if (to < 0 || to >= entries.length) return;
      clock.setTimeout(() => {
        idx = to;
        win.dispatchEvent(new FakeEvent('popstate'));
        if (hashOfUrl(cur().url) !== before) win.dispatchEvent(new FakeEvent('hashchange'));
      }, 0);
    },
    back() {
      this.go(-1);
    },
    forward() {
      this.go(1);
    },
  };
  const location = {
    get hash() {
      return hashOfUrl(cur().url);
    },
    set hash(h) {
      const v = h.startsWith('#') ? h : `#${h}`;
      if (v === this.hash) return;
      history.pushState(null, '', base + v);
      fire('hashchange');
    },
    get href() {
      return cur().url;
    },
  };

  const storage = new Map(Object.entries(stored));
  const blocked = () => {
    throw new Error('SecurityError: 저장소를 쓸 수 없어요');
  };
  const sources = [];
  class FakeEventSource {
    constructor(url) {
      this.url = url;
      this.closed = false;
      this._ls = new Listeners();
      sources.push(this);
    }
    addEventListener(t, fn) {
      this._ls.add(t, fn);
    }
    close() {
      this.closed = true;
    }
    emit(type, data) {
      const ev = new FakeEvent(type, { data: JSON.stringify(data) });
      ev.target = this;
      this._ls.invoke(this, ev, 'target');
    }
  }
  const toasts = [];
  const ctx = {
    console,
    document: doc,
    location,
    history,
    URLSearchParams,
    Event: FakeEvent,
    Node: FNode,
    CSS: { escape: (s) => String(s).replace(/["\\]/g, '\\$&') },
    localStorage: brokenStorage
      ? { getItem: blocked, setItem: blocked }
      : {
          getItem: (k) => (storage.has(k) ? storage.get(k) : null),
          setItem: (k, v) => storage.set(k, String(v)),
        },
    navigator: { clipboard: { writeText: async () => {} } },
    confirmAnswer: true,
    confirm: () => ctx.confirmAnswer,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    setInterval: () => 0,
    requestAnimationFrame: (fn) => clock.setTimeout(fn, 0),
    IntersectionObserver: class {
      constructor(cb) {
        this.cb = cb;
        ctx.__io = this;
      }
      observe() {}
    },
    EventSource: FakeEventSource,
    scrollY,
    innerHeight: 800,
    scrollTo() {},
    addEventListener: (t, fn, o) => win.addEventListener(t, fn, o),
    removeEventListener: (t, fn, o) => win.removeEventListener(t, fn, o),
    fetch: async (url, init = {}) => {
      const u = new URL(url, base);
      const method = init.method || 'GET';
      const body = init.body ? JSON.parse(init.body) : undefined;
      server.requests.push({ path: u.pathname, query: Object.fromEntries(u.searchParams), method, body });
      const r = await server.handle(u, method, body);
      return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
    },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  await vm.runInContext(src, ctx, { filename: 'public/app.js' });
  await clock.advance(0);

  const $ = (sel) => doc.querySelector(sel);
  const $$ = (sel) => doc.querySelectorAll(sel);
  const toastEl = $('#toast');
  return {
    ctx,
    app: ctx.__app,
    doc,
    win,
    storage,
    server,
    clock,
    history,
    location,
    sources,
    toasts,
    $,
    $$,
    rowIds: () => $$('#posts .post[data-id]').map((li) => li.dataset.id),
    toastText: () => (toastEl.hidden ? '' : toastEl.textContent),
    postRequests: () => server.requests.filter((r) => r.path === '/api/posts'),
    setHash: async (h) => {
      location.hash = h;
      await clock.advance(0);
    },
    // init: { ctrlKey, metaKey, altKey, repeat … }. 보낸 이벤트를 돌려준다 (preventDefault 확인용)
    key: async (key, init = {}) => {
      const ev = new FakeEvent('keydown', { key, bubbles: true, ...init });
      (doc.activeElement || doc.body).dispatchEvent(ev);
      await clock.advance(0);
      return ev;
    },
    type: async (el, value) => {
      el.value = value;
      el.dispatchEvent(new FakeEvent('input', { bubbles: true }));
    },
    submit: async (form) => {
      form.dispatchEvent(new FakeEvent('submit', { bubbles: true }));
    },
  };
}

// ================================================================ 테스트

test('frontend: 더 보기가 실패해도 이미 불러온 목록은 남고, 같은 페이지를 다시 받는다', async () => {
  const t = await boot({ hash: '#/b/all' });
  assert.equal(t.rowIds().length, 30);
  t.server.fail = 1;
  await t.app.loadPosts(false);
  await t.clock.advance(0);
  assert.equal(t.rowIds().length, 30, '실패해도 1페이지 30개는 그대로');
  assert.equal(t.$('#btn-more').hidden, false, '다시 시도할 수 있게 더 보기 버튼이 보인다');
  assert.match(t.toastText(), /더 불러오지 못했어요/);
  assert.equal(t.$('#empty').hidden, true);
  const failed = t.postRequests().at(-1);
  assert.equal(failed.query.page, '2');

  await t.app.loadPosts(false);
  await t.clock.advance(0);
  assert.equal(t.postRequests().at(-1).query.page, '2', '다시 받을 때도 2페이지 (3페이지로 건너뛰지 않음)');
  assert.deepEqual(t.rowIds(), t.server.posts.slice(0, 60).map((p) => p.id));
});

test('frontend: 처음 불러오기가 실패하면 목록 대신 오류 문구', async () => {
  const server = makeServer();
  server.fail = 1;
  const t = await boot({ hash: '#/b/all', server });
  assert.equal(t.rowIds().length, 0);
  assert.equal(t.$('#empty').hidden, false);
  assert.match(t.$('#empty').textContent, /목록을 불러오지 못했어요/);
});

test('frontend: 행을 지운 뒤 다음 페이지를 받아도 건너뛰는 글·중복 행이 없다', async () => {
  const t = await boot({ hash: '#/b/all' });
  // 1페이지 글 3개를 숨긴다 (서버 목록에서도 빠진다)
  for (const id of ['p1', 'p2', 'p3']) {
    const row = t.$(`.post[data-id="${id}"]`);
    await t.app.adminUpdate(t.server.posts.find((p) => p.id === id), { manual: 'blocked' }, row);
  }
  await t.clock.advance(0);
  assert.equal(t.rowIds().length, 27);
  await t.app.loadPosts(false);
  await t.clock.advance(0);
  const expected = t.server.list('all').slice(0, t.rowIds().length).map((p) => p.id);
  assert.deepEqual(t.rowIds(), expected, '서버 목록 순서 그대로 빠짐없이 이어진다');
  for (const id of ['p30', 'p31', 'p32']) assert.ok(t.rowIds().includes(id), `${id} 가 빠지면 안 된다`);

  // 새 글 3개가 맨 위에 끼어도 다음 페이지에 같은 글이 두 번 나오지 않는다
  t.server.posts.unshift(...makePosts(3, 'new'));
  await t.app.loadPosts(false);
  await t.clock.advance(0);
  const ids = t.rowIds();
  assert.equal(new Set(ids).size, ids.length, '같은 data-id 행이 두 번 생기면 안 된다');
  assert.ok(!ids.includes('new0'), '위에 낀 새 글은 이어 붙이지 않는다 (배너로 알림)');
});

test('frontend: 검색 디바운스는 입력창 공백을 지우지 않고, 같은 검색어면 다시 불러오지 않는다', async () => {
  const t = await boot({ hash: '#/b/all' });
  const input = t.$('#search');
  input.focus();
  const before = t.postRequests().length;
  await t.type(input, '글 p1 ');
  await t.clock.advance(400);
  assert.equal(t.location.hash, '#/b/all?q=%EA%B8%80+p1');
  assert.equal(input.value, '글 p1 ', '끝 공백이 남아 있어야 다음 단어를 이어 칠 수 있다');
  assert.equal(t.postRequests().length, before + 1);

  await t.type(input, '글 p1  ');
  await t.clock.advance(400);
  assert.equal(t.postRequests().length, before + 1, '공백만 늘면 다시 요청하지 않는다');

  // 입력 후 바로 Enter: 남은 디바운스가 한 번 더 부르지 않는다
  await t.type(input, '글 p2');
  await t.submit(t.$('#search-form'));
  await t.clock.advance(400);
  assert.equal(t.postRequests().length, before + 2);
  assert.equal(t.postRequests().at(-1).query.q, '글 p2');

  // 뒤로가기 등 검색창 밖에서 바뀐 q 는 입력창에 반영한다
  await t.setHash('#/b/all');
  assert.equal(input.value, '');
});

test('frontend: 시트 안에서 드래그해 바깥에서 놓으면 모달이 닫히지 않는다', async () => {
  const t = await boot();
  t.$('#btn-settings').click();
  const ov = t.$('#settings-modal');
  assert.equal(ov.hidden, false);
  // 제목에서 누르기 시작 → 바깥(오버레이)에서 click
  t.$('#settings-title').dispatchEvent(new FakeEvent('pointerdown', { bubbles: true }));
  ov.dispatchEvent(new FakeEvent('click', { bubbles: true }));
  assert.equal(ov.hidden, false, '드래그로는 닫히지 않는다');
  // 바깥에서 누르고 바깥에서 떼면 닫힌다
  ov.click();
  assert.equal(ov.hidden, true);
});

test('frontend: 금지어 창은 저장 안 한 변경이 있으면 닫기 전에 묻는다', async () => {
  const server = makeServer({ admin: true });
  const t = await boot({ server });
  t.$('#btn-rules').click();
  await t.clock.advance(0);
  const ov = t.$('#rules-modal');
  assert.equal(ov.hidden, false);
  assert.equal(t.$('#rules-block').value, '정치');
  t.$('#rules-block').value = '정치\n새단어';
  t.ctx.confirmAnswer = false;
  await t.key('Escape');
  assert.equal(ov.hidden, false, '취소하면 그대로 열려 있다');
  t.ctx.confirmAnswer = true;
  await t.key('Escape');
  assert.equal(ov.hidden, true);
});

test('frontend: 새 글 배너는 공개 글 수(addedPublic)를 쓰고, 0 이면 띄우지 않는다', async () => {
  const t = await boot({ hash: '#/b/all', scrollY: 1000 });
  const es = t.sources.at(-1);
  es.emit('crawl', { added: 10, addedPublic: 0 });
  await t.clock.advance(0);
  assert.equal(t.$('#new-banner').hidden, true, '걸러진·므흣 글만 들어왔으면 배너 없음');

  es.emit('crawl', { added: 10, addedPublic: 4 });
  await t.clock.advance(0);
  assert.equal(t.$('#new-banner').hidden, false);
  assert.equal(t.$('#new-banner').textContent, '새 글 4개 — 눌러서 보기');

  // 출처별 게시판은 공개 수가 그 게시판 수가 아니므로 숫자 없이
  await t.setHash('#/b/dogdrip');
  es.emit('crawl', { added: 10, addedPublic: 4 });
  await t.clock.advance(0);
  assert.equal(t.$('#new-banner').textContent, '새 글이 들어왔어요 — 눌러서 보기');

  // 서버가 게시판별 수를 주면 그 수를 쓴다
  t.app.state.board = 'dogdrip';
  assert.deepEqual({ ...t.app.freshFor({ added: 10, addedPublic: 4, counts: { all: 4, bySource: { dogdrip: 0, inven: 4 } } }) }, { n: 0, exact: true });
  t.app.state.board = 'shorts';
  assert.equal(t.app.freshFor({ added: 10, addedPublic: 4 }).n, 0);
  t.app.state.board = 'all';
  assert.deepEqual({ ...t.app.freshFor({ added: 5 }) }, { n: 5, exact: true }, '옛 서버(added 만)는 그대로');
});

test('frontend: 맨 위에서 보는 중이면 실제로 새로 생긴 행만 세어 알린다', async () => {
  const t = await boot({ hash: '#/b/all' });
  const es = t.sources.at(-1);
  t.server.posts.unshift(...makePosts(2, 'fresh'));
  es.emit('crawl', { added: 9, addedPublic: 2 });
  await t.clock.advance(0);
  assert.deepEqual(t.rowIds().slice(0, 2), ['fresh0', 'fresh1']);
  assert.ok(t.$('.post[data-id="fresh0"]').classList.contains('fresh'));
  assert.equal(t.toastText(), '새 글 2개가 들어왔어요');
});

test('frontend: 관리자 로그인/로그아웃 뒤 실시간 연결을 다시 맺고, live 이벤트가 관리자 바를 갱신한다', async () => {
  const t = await boot({ hash: '#/b/all' });
  assert.equal(t.sources.length, 1);
  const first = t.sources[0];
  t.$('#btn-admin').click();
  await t.clock.advance(50);
  assert.equal(t.$('#pw-modal').hidden, false);
  t.$('#pw-input').value = 'admin';
  await t.submit(t.$('#pw-form'));
  await t.clock.advance(0);
  assert.equal(t.app.state.meta.admin, true);
  assert.equal(first.closed, true, '로그인 전 연결은 닫는다');
  assert.equal(t.sources.length, 2, '관리자 쿠키로 새로 연결');
  const es = t.sources[1];
  es.emit('live', { live: true, lastCrawlAt: null });
  await t.clock.advance(0);
  assert.equal(t.$('#live-toggle').checked, true, '다른 탭에서 켠 실시간이 토글에도 반영');
  assert.equal(t.$('#live-label').textContent, 'ON');

  t.$('#btn-logout').click();
  await t.clock.advance(0);
  assert.equal(es.closed, true);
  assert.equal(t.sources.length, 3);
});

test('frontend: 잠금 창이 열린 채 뒤로/앞으로 가도 옛 게시판이 적용되거나 리스너가 쌓이지 않는다', async () => {
  const t = await boot({ hash: '#/b/all' });
  await t.setHash('#/b/adult');
  assert.equal(t.$('#pw-modal').hidden, false);
  const loads = t.postRequests().length;
  t.history.back();
  await t.clock.advance(0);
  assert.equal(t.location.hash, '#/b/all');
  assert.equal(t.$('#pw-modal').hidden, true, '뒤로가기로 다른 게시판이 되면 잠금 창은 닫힌다');
  assert.equal(t.app.state.board, 'all');
  assert.equal(t.postRequests().length, loads + 1, '기다리던 옛 route 는 버려진다 (목록을 한 번만 받는다)');

  t.history.forward();
  await t.clock.advance(50);
  assert.equal(t.$('#pw-modal').hidden, false);
  // 같은 창을 또 요청해도 리스너는 하나
  t.app.promptPassword({ title: 'x', desc: 'y', endpoint: '/api/unlock' });
  assert.equal(t.$('#pw-form')._ls.count('submit'), 1);
  t.$('#pw-input').value = 'wrong';
  await t.submit(t.$('#pw-form'));
  await t.submit(t.$('#pw-form')); // Enter 연타
  await t.clock.advance(0);
  assert.equal(t.server.requests.filter((r) => r.path === '/api/unlock').length, 1, '한 번 제출에 한 번만 요청');
  assert.equal(t.$('#pw-error').hidden, false);

  t.$('#pw-input').value = 'pw';
  await t.submit(t.$('#pw-form'));
  await t.clock.advance(0);
  assert.equal(t.location.hash, '#/b/adult');
  assert.equal(t.app.state.board, 'adult');
});

test('frontend: 잠금 창을 취소하면 정렬·검색을 지키며 원래 게시판으로', async () => {
  const t = await boot({ hash: '#/b/all?sort=hot&q=%EA%B8%80' });
  await t.setHash('#/b/adult');
  assert.equal(t.$('#pw-modal').hidden, false);
  t.$('#pw-modal [data-close]').click();
  await t.clock.advance(0);
  assert.equal(t.location.hash, '#/b/all?sort=hot&q=%EA%B8%80');
  assert.equal(t.app.state.sort, 'hot');
  assert.equal(t.app.state.q, '글');
});

test('frontend: 같은 글을 닫았다 다시 열어도 복사 버튼은 하나, 늦은 응답은 버린다', async () => {
  const server = makeServer({ admin: true }); // 대본 복사 버튼은 관리자에게만 보인다
  const pending = [];
  server.readDeferred = (data) => new Promise((resolve) => pending.push(() => resolve({ status: 200, body: data })));
  const t = await boot({ hash: '#/b/all', server });
  const p = server.list('all')[0];
  t.app.openReader(p);
  await t.clock.advance(0);
  t.app.closeOverlay(t.$('#reader'));
  await t.clock.advance(0);
  t.app.openReader(p);
  await t.clock.advance(0);
  assert.equal(pending.length, 2);
  // 새 응답이 먼저 오고, 관리자가 메모를 쓰는 중에 닫기 전의 옛 응답이 늦게 와도 다시 그리지 않는다
  pending[1]();
  await t.clock.advance(0);
  t.$('#reader-admin textarea').value = '쓰는 중인 메모';
  pending[0]();
  await t.clock.advance(0);
  assert.equal(t.$('#reader-admin textarea').value, '쓰는 중인 메모', '늦은 옛 응답은 버린다');
  const labels = t.$$('#reader-actions > *').map((el) => el.textContent);
  assert.deepEqual(labels.filter((l) => l.includes('대본 복사')).length, 1);
  assert.equal(labels.filter((l) => l.includes('원문 보기')).length, 1);
});

test('frontend: 미리보기는 뒤로가기로 닫히고, 닫으면 포커스를 제목으로 돌려준다', async () => {
  const t = await boot({ hash: '#/b/all' });
  const title = t.$('.post[data-id="p0"] .post-title');
  title.focus();
  title.dispatchEvent(new FakeEvent('click', { bubbles: true }));
  await t.clock.advance(0);
  const reader = t.$('#reader');
  assert.equal(reader.hidden, false);
  assert.equal(t.history.state?.reader, true, '열 때 이력 한 칸');
  assert.equal(t.$('main').inert, true, '뒤 화면은 inert');
  t.history.back();
  await t.clock.advance(0);
  assert.equal(reader.hidden, true, '뒤로가기는 미리보기만 닫는다');
  assert.equal(t.location.hash, '#/b/all');
  assert.equal(t.$('main').inert, false);
  assert.equal(t.doc.activeElement, title, '닫으면 포커스가 제목으로 돌아온다');

  // ✕ 로 닫으면 넣었던 이력 한 칸을 되돌린다
  title.dispatchEvent(new FakeEvent('click', { bubbles: true }));
  await t.clock.advance(0);
  const len = t.history.length;
  t.$('#reader .close').click();
  await t.clock.advance(0);
  assert.equal(reader.hidden, true);
  assert.equal(t.history.state?.reader, undefined);
  assert.equal(t.history.length, len);
  // 바닥에도 닫기 버튼이 있다 (모바일에서 긴 글을 다 읽은 뒤)
  title.dispatchEvent(new FakeEvent('click', { bubbles: true }));
  await t.clock.advance(0);
  t.$('#reader-foot [data-close]').click();
  await t.clock.advance(0);
  assert.equal(reader.hidden, true);
});

test('frontend: 게시하기를 눌러도 저장 안 한 쇼츠 메모가 남는다', async () => {
  const server = makeServer({ admin: true });
  server.posts[0].status = 'blocked';
  const t = await boot({ hash: '#/b/filtered', server });
  const p = server.list('filtered')[0];
  t.app.openReader(p);
  await t.clock.advance(0);
  const note = t.$('#reader-admin textarea');
  note.value = '첫 컷은 카톡 캡처';
  const publish = t.$$('#reader-admin button').find((b) => b.textContent === '게시하기');
  publish.click();
  await t.clock.advance(0);
  assert.equal(server.posts[0].status, 'ok');
  assert.equal(t.$('#reader-admin textarea').value, '첫 컷은 카톡 캡처');
});

test('frontend: 게시판 칩 숫자는 서버의 boardCounts 를 쓴다 (없으면 예전 방식)', async () => {
  const server = makeServer({ admin: true, meta: { boardCounts: { pick: 7, all: 468, adult: 48, filtered: 61, shorts: 2 } } });
  const t = await boot({ server });
  const count = (board) => t.$(`#boards a[href="#/b/${board}"] .count`)?.textContent;
  assert.equal(count('pick'), '7');
  assert.equal(count('all'), '468');
  assert.equal(count('filtered'), '61');
  assert.equal(count('shorts'), '2');
  assert.equal(count('adult'), undefined, '잠겨 있으면 므흣 수는 보이지 않는다');

  const old = await boot({ server: makeServer({ admin: true }) });
  assert.equal(old.$('#boards a[href="#/b/all"] .count').textContent, '3', '옛 서버: 출처별 합');
  assert.equal(old.$('#boards a[href="#/b/filtered"] .count').textContent, '3', '옛 서버: blocked + pending');
});

test('frontend: 다크 모드에서 원문 인라인 색을 덮고, 휴대폰 미리보기 닫기 버튼은 고정', () => {
  const flat = CSS_SRC.replace(/\s+/g, ' ');
  assert.match(flat, /:root\[data-theme='dark'\] \.reader-body \[style\*='color'\], :root\[data-theme='dark'\] \.reader-body font\[color\] \{ color: inherit !important; background-color: transparent !important; \}/);
  const media = /@media \(prefers-color-scheme: dark\) \{ :root:not\(\[data-theme='light'\]\) \.reader-body \[style\*='color'\]/;
  assert.match(flat, media, '시스템 다크 모드(auto)에서도');
  const mobile = flat.slice(flat.indexOf('@media (max-width: 640px)'));
  assert.match(mobile, /\.reader \.close \{ position: fixed;/);
  assert.match(flat, /\.sr-only \{/);
});

test('frontend: 목록은 aria-live 로 통째로 읽히지 않고, 개수만 status 로 알린다', async () => {
  assert.doesNotMatch(HTML_SRC, /id="posts"[^>]*aria-live/);
  const t = await boot({ hash: '#/b/all' });
  assert.equal(t.$('#list-status').getAttribute('role'), 'status');
  assert.equal(t.$('#list-status').textContent, '전체 글 100개');
  assert.ok(!/null/.test(t.$('#boards').textContent), '게시판 칩에 "null" 글자가 끼면 안 된다');
});

test('frontend: 조건부로 빠진 요소가 "null"/"false" 글자로 화면에 남지 않는다', async () => {
  const server = makeServer(); // 일반 방문자: 관리자 칩·대본 복사 버튼이 빠진다
  server.posts[0].likes = null;
  server.posts[0].commentCount = null;
  const t = await boot({ hash: '#/b/all', server });
  assert.doesNotMatch(t.$('#boards').textContent, /null|false/);
  t.app.openReader(server.posts[0]);
  await t.clock.advance(0);
  for (const sel of ['#reader-meta', '#reader-actions', '#reader-comments', '#reader-foot']) {
    assert.doesNotMatch(t.$(sel).textContent, /null|false/, sel);
  }
});

// 통합 점검: 서버의 'crawl' counts.bySource 는 저장된 글이 있는 출처만 담는다. 글이 하나도 없는 출처 게시판에
// 다른 출처의 새 글 수(addedPublic)로 배너가 뜨지 않아야 한다.
test('frontend(통합): counts.bySource 에 없는 출처 게시판은 새 글 0개로 본다', async () => {
  const t = await boot({ hash: '#/b/dogdrip', scrollY: 1000 });
  const es = t.sources.at(-1);
  const payload = { added: 5, addedPublic: 3, aiReviewed: 0, at: new Date().toISOString(), counts: { all: 3, pick: 1, bySource: { inven: 3 } } };
  assert.deepEqual({ ...t.app.freshFor(payload) }, { n: 0, exact: true });
  es.emit('crawl', payload);
  await t.clock.advance(0);
  assert.equal(t.$('#new-banner').hidden, true, '글이 없는 출처 게시판에는 배너가 뜨지 않는다');
  // 므흣·걸러진 글 게시판은 counts 에 없으니 공개되지 않은 새 글이 있었는지만 본다 (그대로)
  t.app.state.board = 'filtered';
  assert.deepEqual({ ...t.app.freshFor(payload) }, { n: 2, exact: false });
  t.app.state.board = 'all';
  assert.deepEqual({ ...t.app.freshFor(payload) }, { n: 3, exact: true });
});

// ================================================================ 공개 사이트(Worker) 모드 / 공개 사이트 반영 상태
const metaCount = (t) => t.server.requests.filter((r) => r.path === '/api/meta').length;
const publicServer = (lastCrawlAt, extra = {}) => makeServer({ meta: { mode: 'public', live: { live: true, lastCrawlAt }, ...extra } });

test('frontend(공개): 관리자 버튼·바를 숨기고 SSE 를 열지 않으며, 갱신 표시는 중립적으로', async () => {
  const server = publicServer(new Date(Date.now() - 5 * 60e3).toISOString());
  const t = await boot({ hash: '#/b/all', server });
  assert.equal(t.$('#btn-admin').hidden, true, '👤 버튼 숨김');
  assert.equal(t.$('#adminbar').hidden, true, '관리자 바 숨김');
  assert.equal(t.$('#btn-publish').hidden, true);
  assert.equal(t.sources.length, 0, '/api/events 를 열지 않는다');
  const pill = t.$('#live-pill');
  assert.equal(pill.hidden, false);
  assert.equal(t.$('#live-pill .txt').textContent, '5분 전 갱신');
  assert.ok(pill.classList.contains('public'));
  assert.ok(!pill.classList.contains('on'), '빨간 실시간 표시를 쓰지 않는다');
  assert.match(pill.title, /^마지막 갱신 /);
  assert.equal(t.rowIds().length, 30, '목록은 그대로');
  assert.equal(t.$('#sorts button[data-sort="shorts"]').hidden, true, '쇼츠추천순 정렬도 없다');
  // 혹시 눌려도 로그인 창을 띄우지 않는다
  t.$('#btn-admin').click();
  await t.clock.advance(50);
  assert.equal(t.$('#pw-modal').hidden, true);
  // 아직 수집 기록이 없으면 표시하지 않는다
  const empty = await boot({ server: publicServer(null) });
  assert.equal(empty.$('#live-pill').hidden, true);
});

test('frontend(공개): 2분마다 /api/meta 를 다시 받아 lastCrawlAt 이 바뀌면 숫자 없는 새 글 배너', async () => {
  const server = publicServer(new Date(Date.now() - 5 * 60e3).toISOString());
  const t = await boot({ hash: '#/b/all', server, scrollY: 1000 });
  const before = metaCount(t);
  await t.clock.advance(119e3);
  assert.equal(metaCount(t), before, '2분 전에는 받지 않는다');
  await t.clock.advance(1e3);
  assert.equal(metaCount(t), before + 1);
  assert.equal(t.$('#new-banner').hidden, true, '같은 수집이면 배너 없음');

  server.extraMeta.live = { live: true, lastCrawlAt: new Date().toISOString() };
  server.extraMeta.boardCounts = { story: 1, pick: 1, all: 101 };
  await t.clock.advance(120e3);
  assert.equal(metaCount(t), before + 2);
  assert.equal(t.$('#new-banner').hidden, false);
  assert.equal(t.$('#new-banner').textContent, '새 글이 있어요 — 눌러서 보기');
  assert.equal(t.$('#live-pill .txt').textContent, '방금 갱신', '갱신 표시도 새 시각으로');
  assert.equal(t.$('#boards a[href="#/b/all"] .count').textContent, '101', '칩 숫자도 새 메타로');
  assert.equal(t.sources.length, 0);

  // 눌러서 보면 목록을 다시 받고 배너를 닫는다. 같은 수집으로는 다시 뜨지 않는다
  const loads = t.postRequests().length;
  t.$('#new-banner').click();
  await t.clock.advance(0);
  assert.equal(t.postRequests().length, loads + 1);
  assert.equal(t.$('#new-banner').hidden, true);
  await t.clock.advance(120e3);
  assert.equal(metaCount(t), before + 3);
  assert.equal(t.$('#new-banner').hidden, true);

  // 다른 게시판으로 옮겨 목록을 새로 받은 뒤에는 그 수집은 이미 본 것
  server.extraMeta.live = { live: true, lastCrawlAt: new Date(Date.now() + 1000).toISOString() };
  await t.app.loadMeta();
  await t.setHash('#/b/dogdrip');
  await t.clock.advance(120e3);
  assert.equal(t.$('#new-banner').hidden, true);

  // 메타를 못 받아도 다음 차례에 다시 시도한다
  const realHandle = server.handle;
  server.handle = async (u, m, b) => (u.pathname === '/api/meta' ? { status: 500, body: { error: '잠시 오류' } } : realHandle(u, m, b));
  await t.clock.advance(120e3);
  server.handle = realHandle;
  server.extraMeta.live = { live: true, lastCrawlAt: new Date(Date.now() + 2000).toISOString() };
  await t.clock.advance(120e3);
  assert.equal(t.$('#new-banner').hidden, false, '오류 뒤에도 계속 확인');
});

test('frontend(공개): 탭이 숨겨져 있으면 쉬었다가, 돌아오면 한 번만 확인', async () => {
  const server = publicServer('2026-10-17T00:00:00.000Z');
  const t = await boot({ hash: '#/b/all', server, scrollY: 1000 });
  const before = metaCount(t);
  t.doc.visibilityState = 'hidden';
  t.doc.dispatchEvent(new FakeEvent('visibilitychange'));
  server.extraMeta.live = { live: true, lastCrawlAt: '2026-10-17T00:15:00.000Z' };
  await t.clock.advance(10 * 60e3);
  assert.equal(metaCount(t), before, '숨겨진 동안은 받지 않는다');
  assert.equal(t.$('#new-banner').hidden, true);

  t.doc.visibilityState = 'visible';
  t.doc.dispatchEvent(new FakeEvent('visibilitychange'));
  await t.clock.advance(0);
  assert.equal(metaCount(t), before + 1, '돌아오면 바로 한 번');
  assert.equal(t.$('#new-banner').hidden, false);
  assert.equal(t.$('#new-banner').textContent, '새 글이 있어요 — 눌러서 보기');

  // 잠깐 숨겼다 2분이 지나기 전에 돌아오면 추가로 받지 않는다
  t.doc.visibilityState = 'hidden';
  t.doc.dispatchEvent(new FakeEvent('visibilitychange'));
  await t.clock.advance(30e3);
  t.doc.visibilityState = 'visible';
  t.doc.dispatchEvent(new FakeEvent('visibilitychange'));
  await t.clock.advance(0);
  assert.equal(metaCount(t), before + 1, '확인 차례가 지나가지 않았으면 그대로');
  await t.clock.advance(90e3);
  assert.equal(metaCount(t), before + 2, '그 뒤로 다시 2분마다');
});

test('frontend(공개): 미리보기 404 에 url 이 오면 준비 중 안내와 원문 보기 버튼', async () => {
  const server = publicServer(new Date().toISOString());
  server.readDeferred = () => ({ status: 404, body: { error: '미리보기를 준비 중이에요', url: 'https://example.invalid/origin-p0' } });
  const t = await boot({ hash: '#/b/all', server });
  const p = server.list('all')[0];
  t.app.openReader(p);
  await t.clock.advance(0);
  assert.equal(t.$('#reader').hidden, false);
  assert.equal(t.$('#reader-body .notice').textContent, '미리보기를 준비 중이에요');
  const a = t.$('#reader-body a.btn');
  assert.equal(a.getAttribute('href'), 'https://example.invalid/origin-p0');
  assert.equal(a.textContent, '원문 보기 ↗');
  assert.equal(a.getAttribute('target'), '_blank');
  assert.equal(a.getAttribute('rel'), 'noopener noreferrer');
  assert.equal(t.$('#reader-comments').hidden, true);
  t.app.closeOverlay(t.$('#reader'));
  await t.clock.advance(0);

  // http(s) 가 아닌 주소는 쓰지 않고 글 주소로
  server.readDeferred = () => ({ status: 404, body: { error: '미리보기를 준비 중이에요', url: 'javascript:alert(1)' } });
  t.app.openReader(p);
  await t.clock.advance(0);
  assert.equal(t.$('#reader-body a.btn').getAttribute('href'), p.url);
  t.app.closeOverlay(t.$('#reader'));
  await t.clock.advance(0);

  // url 이 없는 404 는 예전처럼 서버 문구 + 원문 링크
  server.readDeferred = () => ({ status: 404, body: { error: '글을 찾을 수 없어요' } });
  t.app.openReader(p);
  await t.clock.advance(0);
  assert.equal(t.$('#reader-body .notice').textContent, '글을 찾을 수 없어요');
  assert.match(t.$('#reader-body a.btn').textContent, /원문 사이트에서 보기/);
});

test('frontend(로컬): 모드가 없으면 예전처럼 관리자 버튼·실시간 표시·SSE, 주기적 메타 확인 없음', async () => {
  const t = await boot({ hash: '#/b/all' });
  assert.equal(t.$('#btn-admin').hidden, false);
  assert.equal(t.$('#live-pill').hidden, false);
  assert.equal(t.$('#live-pill .txt').textContent, '일시정지');
  assert.ok(!t.$('#live-pill').classList.contains('public'));
  assert.equal(t.sources.length, 1);
  assert.equal(t.sources[0].url, '/api/events');
  const before = metaCount(t);
  await t.clock.advance(10 * 60e3);
  assert.equal(metaCount(t), before, '로컬은 SSE 로 알림을 받으므로 메타를 주기적으로 받지 않는다');
  assert.equal(t.$('#btn-publish').hidden, true, '관리자가 아니면 반영 상태 없음');
  // mode: "local" 도 같다
  const local = await boot({ server: makeServer({ meta: { mode: 'local' } }) });
  assert.equal(local.$('#btn-admin').hidden, false);
  assert.equal(local.sources.length, 1);
});

test('frontend(로컬 관리자): 관리자 바에 공개 사이트 반영 상태, 누르면 지금 올리기', async () => {
  const at = new Date(Date.now() - 3 * 60e3).toISOString();
  // src/publish.js 의 publishStatus() 모양 그대로
  const server = makeServer({ admin: true, meta: { publish: { enabled: true, url: 'https://simsimhae.example.invalid', lastOkAt: at, lastError: null, running: false, reads: { done: 40, pending: 3 } } } });
  const t = await boot({ server });
  const btn = t.$('#btn-publish');
  assert.equal(t.$('#adminbar').hidden, false);
  assert.equal(t.$('#sorts button[data-sort="shorts"]').hidden, false, '처음엔 숨겨 둔 쇼츠추천순 정렬이 관리자에겐 보인다');
  assert.equal(btn.hidden, false);
  assert.equal(btn.textContent, '공개 사이트: 마지막 반영 3분 전');
  assert.ok(!btn.classList.contains('warn'));
  assert.match(btn.title, /누르면 지금 올려요/);
  assert.match(btn.title, /미리보기 40개 올림 · 3개 남음/);
  assert.equal(t.$('#publish-site').hidden, false);
  assert.equal(t.$('#publish-site').getAttribute('href'), 'https://simsimhae.example.invalid');

  // 오류: 경고색 + title 에 오류
  server.extraMeta.publish = { enabled: true, lastOkAt: at, lastError: { message: 'HTTP 401 (토큰 확인)', at: new Date().toISOString() } };
  await t.app.loadMeta();
  assert.ok(btn.classList.contains('warn'));
  assert.match(btn.title, /HTTP 401 \(토큰 확인\)/);
  assert.equal(btn.textContent, '⚠ 공개 사이트: 마지막 반영 3분 전');
  // 오류 뒤에 다시 성공했으면 지난 오류는 보이지 않는다
  assert.equal(t.app.publishInfo({ enabled: true, lastOkAt: '2026-10-17T01:00:00Z', lastError: { message: 'x', at: '2026-10-17T00:00:00Z' } }).error, null);
  assert.equal(t.app.publishInfo({ enabled: true, lastError: '문자열 오류' }).error, '문자열 오류');

  // 누르면 POST /api/admin/publish. 보내는 동안은 다시 누를 수 없다
  let release;
  server.onPublish = () =>
    new Promise((resolve) => {
      release = () => {
        server.extraMeta.publish = { enabled: true, lastOkAt: new Date().toISOString(), lastError: null };
        resolve({ status: 200, body: { ok: true, posts: 120 } });
      };
    });
  btn.click();
  await t.clock.advance(0);
  assert.equal(btn.textContent, '공개 사이트: 올리는 중…');
  assert.equal(btn.disabled, true);
  btn.click();
  await t.clock.advance(0);
  const calls = server.requests.filter((r) => r.path === '/api/admin/publish');
  assert.equal(calls.length, 1, '보내는 중에는 한 번만');
  assert.equal(calls[0].method, 'POST');
  release();
  await t.clock.advance(0);
  assert.equal(t.toastText(), '공개 사이트에 올렸어요');
  assert.equal(btn.disabled, false);
  assert.equal(btn.textContent, '공개 사이트: 마지막 반영 방금', '올린 뒤 메타를 다시 받아 반영');
  assert.ok(!btn.classList.contains('warn'));

  // 실패하면 이유를 알린다
  server.onPublish = () => ({ status: 502, body: { error: '공개 사이트에 연결하지 못했어요' } });
  btn.click();
  await t.clock.advance(0);
  assert.equal(t.toastText(), '공개 사이트에 올리지 못했어요: 공개 사이트에 연결하지 못했어요');
  assert.equal(btn.disabled, false);

  // 로컬 서버가 SSE 'publish' 를 보내면 바로 반영 (관리자만). 시작 알림은 일부 필드만 온다
  const es = t.sources.at(-1);
  es.emit('publish', { running: true, lastOkAt: at, lastError: null });
  await t.clock.advance(0);
  assert.equal(btn.textContent, '공개 사이트: 올리는 중…');
  assert.equal(btn.hidden, false, '시작 알림에 enabled 가 없어도 그대로 보인다');
  es.emit('publish', { enabled: true, url: 'https://simsimhae.example.invalid', lastOkAt: at, lastError: '용량 초과', running: false, reads: { done: 40, pending: 0 } });
  await t.clock.advance(0);
  assert.ok(btn.classList.contains('warn'));
  assert.match(btn.title, /용량 초과/);
  assert.equal(btn.textContent, '⚠ 공개 사이트: 마지막 반영 3분 전');
});

test('frontend(로컬 관리자): 올리는 중이면 끝날 때까지 메타를 다시 받고, 없거나 꺼져 있으면 표시하지 않는다', async () => {
  const at = new Date(Date.now() - 20 * 60e3).toISOString();
  const server = makeServer({ admin: true, meta: { publish: { enabled: true, running: true, lastOkAt: at } } });
  const t = await boot({ server });
  const btn = t.$('#btn-publish');
  assert.equal(btn.textContent, '공개 사이트: 올리는 중…');
  assert.equal(btn.disabled, true);
  const before = metaCount(t);
  server.extraMeta.publish = { enabled: true, running: false, lastOkAt: new Date().toISOString() };
  await t.clock.advance(4000);
  assert.equal(metaCount(t), before + 1);
  assert.equal(btn.textContent, '공개 사이트: 마지막 반영 방금');
  await t.clock.advance(60e3);
  assert.equal(metaCount(t), before + 1, '끝나면 더 받지 않는다');

  const none = await boot({ server: makeServer({ admin: true }) });
  assert.equal(none.$('#btn-publish').hidden, true, 'meta.publish 가 없으면 표시하지 않는다');
  assert.equal(none.$('#publish-site').hidden, true);
  const off = await boot({ server: makeServer({ admin: true, meta: { publish: { enabled: false, lastOkAt: at } } }) });
  assert.equal(off.$('#btn-publish').hidden, true, 'enabled false 면 표시하지 않는다');
  const never = await boot({ server: makeServer({ admin: true, meta: { publish: { enabled: true } } }) });
  assert.equal(never.$('#btn-publish').textContent, '공개 사이트: 아직 반영 전');
  assert.equal(never.$('#publish-site').hidden, true, '주소가 없으면 열기 링크 없음');
});

test('frontend: 공개 모드·반영 상태 스타일이 있고, 관리자 버튼·실시간 표시는 처음엔 숨겨 둔다', () => {
  const flat = CSS_SRC.replace(/\s+/g, ' ');
  assert.match(flat, /\.live-pill\.public \{/);
  assert.match(flat, /\.live-pill\.public \.dot \{ display: none; \}/);
  assert.match(flat, /\.btn\.pub-status\.warn \{[^}]*var\(--warn\)/);
  // 공개 사이트에서 메타를 받기 전에 잠깐 보이지 않게
  assert.match(HTML_SRC, /id="btn-admin"[^>]*hidden/);
  assert.match(HTML_SRC, /id="live-pill"[^>]*hidden/);
  // 운영자용 정렬(쇼츠추천순)도 메타를 받기 전·메타를 못 받았을 때 방문자에게 보이지 않게
  assert.match(HTML_SRC, /data-sort="shorts"[^>]*hidden/);
});

// ================================================================ 클라우드 모드 (worker/CLOUD.md 원칙 2)
const ago = (min) => new Date(Date.now() - min * 60e3).toISOString();
const cloudServer = ({ admin = false, lastCrawlAt = ago(5), live = {}, meta = {} } = {}) =>
  makeServer({ admin, meta: { mode: 'cloud', ...meta }, live: { live: true, intervalMin: 15, running: false, nextRunAt: null, lastCrawlAt, ...live } });
const crawlCalls = (t) => t.server.requests.filter((r) => r.path === '/api/admin/crawl');
async function loginAdmin(t) {
  t.$('#btn-admin').click();
  await t.clock.advance(50);
  assert.equal(t.$('#pw-modal').hidden, false, '로그인 창');
  t.$('#pw-input').value = 'admin';
  await t.submit(t.$('#pw-form'));
  await t.clock.advance(0);
}

test('frontend(클라우드): 방문자 — 👤 는 보이고, SSE 없이 2분마다 메타 확인, 갱신 표시·로그인 안내는 중립적', async () => {
  const server = cloudServer({ lastCrawlAt: ago(5) });
  const t = await boot({ hash: '#/b/all', server, scrollY: 1000 });
  assert.equal(t.$('#btn-admin').hidden, false, '👤 버튼 보임');
  assert.equal(t.$('#adminbar').hidden, true);
  assert.equal(t.sources.length, 0, '/api/events 를 열지 않는다');
  const pill = t.$('#live-pill');
  assert.equal(t.$('#live-pill .txt').textContent, '5분 전 갱신', '방문자에겐 수집 상태 대신 갱신 시각만');
  assert.ok(pill.classList.contains('public'));
  assert.equal(t.$('#sorts button[data-sort="shorts"]').hidden, true);
  assert.equal(t.rowIds().length, 30);

  const before = metaCount(t);
  await t.clock.advance(119e3);
  assert.equal(metaCount(t), before, '방문자는 2분 전에는 받지 않는다');
  await t.clock.advance(1e3);
  assert.equal(metaCount(t), before + 1);
  assert.equal(t.$('#new-banner').hidden, true, '같은 수집이면 배너 없음');
  server.live.lastCrawlAt = new Date().toISOString();
  await t.clock.advance(120e3);
  assert.equal(t.$('#new-banner').hidden, false);
  assert.equal(t.$('#new-banner').textContent, '새 글이 있어요 — 눌러서 보기');
  assert.equal(t.$('#live-pill .txt').textContent, '방금 갱신');

  // 👤 → 로그인 창. 누구나 볼 수 있으니 안내에 운영 이야기를 쓰지 않는다
  t.$('#btn-admin').click();
  await t.clock.advance(50);
  assert.equal(t.$('#pw-modal').hidden, false);
  assert.equal(t.$('#pw-desc').textContent, '관리자 비밀번호를 입력하세요.');
  assert.doesNotMatch(t.$('#pw-desc').textContent, /쇼츠|수집|후보/);
});

test('frontend(클라우드): 관리자로 로그인하면 관리자 바·걸러진 글·후보함·금지어가 그대로, 30초마다 메타 확인, 업로드 표시 없음', async () => {
  // 혹시 meta.publish 가 와도 클라우드에서는 보이지 않는다
  const server = cloudServer({ lastCrawlAt: ago(10), meta: { publish: { enabled: true, url: 'https://x.example.invalid', lastOkAt: ago(3) } } });
  server.posts[0].status = 'blocked';
  const t = await boot({ hash: '#/b/all', server, scrollY: 1000 });
  await loginAdmin(t);
  assert.equal(t.app.state.meta.admin, true);
  assert.equal(t.$('#adminbar').hidden, false, '관리자 바');
  assert.equal(t.sources.length, 0, '로그인해도 SSE 는 열지 않는다');
  assert.equal(t.$('#btn-publish').hidden, true, '공개 사이트 업로드 표시 없음');
  assert.equal(t.$('#publish-site').hidden, true);
  assert.ok(!t.$('#live-pill').classList.contains('public'), '관리자에겐 수집 상태 표시');
  assert.equal(t.$('#live-pill .txt').textContent, '실시간');
  assert.equal(t.$('#live-toggle').checked, true);
  assert.equal(t.$('#sorts button[data-sort="shorts"]').hidden, false);
  assert.ok(t.$('#boards a[href="#/b/filtered"]'), '걸러진 글 칩');
  assert.ok(t.$('#boards a[href="#/b/shorts"]'), '후보함 칩');
  // Claude 검수 안내는 클라우드에 맞게 (Worker 비밀)
  t.$('#admin-stats .stat-btn').click();
  assert.match(t.toastText(), /Worker 비밀 ANTHROPIC_API_KEY/);

  // 관리자는 30초마다
  const before = metaCount(t);
  await t.clock.advance(29e3);
  assert.equal(metaCount(t), before);
  await t.clock.advance(1e3);
  assert.equal(metaCount(t), before + 1, '30초');
  // 다른 곳(알람)에서 시작한 수집·다음 수집 시각도 다음 확인에서 관리자 바에
  server.live.running = true;
  server.live.nextRunAt = new Date(Date.now() + 15 * 60e3).toISOString();
  await t.clock.advance(30e3);
  assert.equal(metaCount(t), before + 2);
  assert.equal(t.$('#btn-crawl').disabled, true);
  assert.equal(t.$('#btn-crawl').textContent, '수집 중…');
  assert.equal(t.$('#live-pill .txt').textContent, '수집 중');
  assert.match(t.$('#crawl-info').textContent, /^마지막 10분 전 · 다음 /);
  server.live.running = false;
  server.live.lastCrawlAt = new Date().toISOString();
  await t.clock.advance(30e3);
  assert.equal(t.$('#btn-crawl').disabled, false);
  assert.equal(t.$('#btn-crawl').textContent, '지금 수집');
  assert.match(t.$('#crawl-info').textContent, /^마지막 방금/);
  assert.equal(t.$('#new-banner').hidden, false, '새 수집이면 배너');
  assert.equal(t.$('#new-banner').textContent, '새 글이 있어요 — 눌러서 보기');

  // 걸러진 글 → 게시하기
  await t.setHash('#/b/filtered');
  assert.deepEqual(t.rowIds(), ['p0']);
  t.$$('.post[data-id="p0"] .row-actions button').find((b) => b.textContent === '게시하기').click();
  await t.clock.advance(1e3); // 처리 뒤 메타 한 번 (refreshMetaSoon)
  assert.equal(server.posts[0].status, 'ok');
  assert.deepEqual(t.rowIds(), [], '게시한 글은 걸러진 글함에서 빠진다');
  // 후보함
  await t.setHash('#/b/shorts');
  assert.equal(t.app.state.board, 'shorts');
  assert.equal(t.$('#stage-filter').hidden, false);
  // 금지어 관리
  t.$('#btn-rules').click();
  await t.clock.advance(0);
  assert.equal(t.$('#rules-modal').hidden, false);
  assert.equal(t.$('#rules-block').value, '정치');
  await t.key('Escape');
  assert.equal(t.$('#rules-modal').hidden, true);

  // 로그아웃하면 방문자 화면, 다시 2분 간격
  t.$('#btn-logout').click();
  await t.clock.advance(0);
  assert.equal(t.app.state.meta.admin, false);
  assert.equal(t.$('#adminbar').hidden, true);
  assert.equal(t.location.hash, '#/b/story', '관리자 게시판에서 나온다');
  assert.ok(t.$('#live-pill').classList.contains('public'));
  assert.equal(t.sources.length, 0);
  const after = metaCount(t);
  await t.clock.advance(60e3);
  assert.equal(metaCount(t), after, '방문자가 되면 30초 간격이 아니다');
  await t.clock.advance(60e3);
  assert.equal(metaCount(t), after + 1);
});

test('frontend(클라우드): 지금 수집 → 끝날 때까지 3초마다 메타를 받아 표시하고, 끝나면 알림과 새 글 배너', async () => {
  const server = cloudServer({ admin: true, lastCrawlAt: ago(20) });
  server.onCrawl = () => {
    server.live.running = true;
    return { status: 202, body: { started: true, running: true } };
  };
  const t = await boot({ hash: '#/b/all', server, scrollY: 1000 });
  assert.equal(t.sources.length, 0);
  const btn = t.$('#btn-crawl');
  const before = metaCount(t);
  btn.click();
  await t.clock.advance(0);
  assert.equal(crawlCalls(t).length, 1);
  assert.equal(crawlCalls(t)[0].method, 'POST');
  assert.equal(btn.disabled, true);
  assert.equal(btn.textContent, '수집 중…');
  assert.equal(t.$('#live-pill .txt').textContent, '수집 중');
  assert.equal(t.toastText(), '수집을 시작했어요. 끝나면 알려드릴게요');
  btn.click(); // 수집 중에는 다시 보내지 않는다
  await t.clock.advance(0);
  assert.equal(crawlCalls(t).length, 1);

  await t.clock.advance(3e3);
  assert.equal(metaCount(t), before + 1, '3초 뒤 확인');
  assert.equal(btn.disabled, true, '아직 수집 중');
  await t.clock.advance(3e3);
  assert.equal(metaCount(t), before + 2);
  assert.equal(t.$('#new-banner').hidden, true);

  server.live.running = false;
  server.live.lastCrawlAt = new Date().toISOString();
  await t.clock.advance(3e3);
  assert.equal(metaCount(t), before + 3);
  assert.equal(btn.disabled, false);
  assert.equal(btn.textContent, '지금 수집');
  assert.equal(t.$('#live-pill .txt').textContent, '실시간');
  assert.equal(t.toastText(), '수집을 마쳤어요');
  assert.equal(t.$('#new-banner').hidden, false, '새 글 배너 (공개 모드와 같은 방식)');
  assert.equal(t.$('#new-banner').textContent, '새 글이 있어요 — 눌러서 보기');

  // 끝나면 다시 30초 간격
  await t.clock.advance(29e3);
  assert.equal(metaCount(t), before + 3);
  await t.clock.advance(1e3);
  assert.equal(metaCount(t), before + 4);

  // 배너를 누르면 새 목록, 같은 수집으로는 다시 뜨지 않는다
  t.$('#new-banner').click();
  await t.clock.advance(0);
  assert.equal(t.$('#new-banner').hidden, true);
  await t.clock.advance(30e3);
  assert.equal(t.$('#new-banner').hidden, true);
});

test('frontend(클라우드): 수집이 시작되지 않으면 몇 번 확인 뒤 버튼을 되살리고, 실패·이미 끝난 응답도 처리', async () => {
  const server = cloudServer({ admin: true, lastCrawlAt: ago(20) });
  const t = await boot({ hash: '#/b/all', server, scrollY: 1000 });
  const btn = t.$('#btn-crawl');
  // 서버가 받았다고만 하고 수집 기록이 바뀌지 않는다
  btn.click();
  await t.clock.advance(6e3);
  assert.equal(btn.disabled, true, '서버가 시작하기 전일 수 있어 잠시 기다린다');
  await t.clock.advance(3e3);
  assert.equal(btn.disabled, false, '세 번 확인해도 그대로면 되살린다');
  assert.notEqual(t.toastText(), '수집을 마쳤어요');
  const m = metaCount(t);
  await t.clock.advance(3e3);
  assert.equal(metaCount(t), m, '평소 간격(30초)으로 돌아간다');

  // 실패하면 이유를 알리고 버튼을 되살린다
  server.onCrawl = () => ({ status: 429, body: { error: '잠시 뒤에 다시 해 주세요' } });
  btn.click();
  await t.clock.advance(0);
  assert.equal(t.toastText(), '실패: 잠시 뒤에 다시 해 주세요');
  assert.equal(btn.disabled, false);
  assert.equal(btn.textContent, '지금 수집');

  // 이미 끝났다는 응답(running: false)이면 바로 확인
  server.onCrawl = () => {
    server.live.lastCrawlAt = new Date().toISOString();
    return { status: 200, body: { ok: true, started: true, running: false } };
  };
  const m2 = metaCount(t);
  btn.click();
  await t.clock.advance(0);
  assert.equal(metaCount(t), m2 + 1);
  assert.equal(btn.disabled, false);
  assert.equal(t.toastText(), '수집을 마쳤어요');
  assert.equal(t.$('#new-banner').hidden, false);
});

test('frontend(클라우드): 다른 탭에서 로그아웃·로그인이 만료되면 다음 확인에서 방문자 화면으로', async () => {
  const server = cloudServer({ admin: true, lastCrawlAt: ago(5) });
  server.posts[0].status = 'blocked';
  const t = await boot({ hash: '#/b/filtered', server });
  assert.deepEqual(t.rowIds(), ['p0']);
  t.$('#btn-crawl').click();
  await t.clock.advance(0);
  server.admin = false;
  await t.clock.advance(3e3);
  assert.equal(t.app.state.meta.admin, false);
  assert.equal(t.location.hash, '#/b/story');
  assert.equal(t.$('#adminbar').hidden, true);
  assert.ok(t.$('#live-pill').classList.contains('public'));
  const m = metaCount(t);
  await t.clock.advance(60e3);
  assert.equal(metaCount(t), m, '따라가던 수집도 멈추고 방문자 간격(2분)으로');
  await t.clock.advance(60e3);
  assert.equal(metaCount(t), m + 1);
});

test('frontend(로컬 관리자): 지금 수집은 예전처럼 SSE 로 기다리고 메타를 주기적으로 받지 않는다', async () => {
  const t = await boot({ server: makeServer({ admin: true }) });
  assert.equal(t.sources.length, 1);
  const before = metaCount(t);
  t.$('#btn-crawl').click();
  await t.clock.advance(0);
  assert.equal(crawlCalls(t).length, 1);
  assert.equal(t.toastText(), '수집을 시작했어요. 끝나면 알려드릴게요');
  assert.equal(t.$('#btn-crawl').disabled, true);
  await t.clock.advance(60e3);
  assert.equal(metaCount(t), before, '로컬은 수집 중에도 메타를 따로 받지 않는다');
  t.sources[0].emit('state', { live: false, intervalMin: 15, running: false, nextRunAt: null, lastCrawlAt: new Date().toISOString() });
  await t.clock.advance(0);
  assert.equal(t.$('#btn-crawl').disabled, false);
  // 로그인 안내도 예전 그대로
  const v = await boot();
  v.$('#btn-admin').click();
  await v.clock.advance(50);
  assert.match(v.$('#pw-desc').textContent, /실시간 수집/);
});

// ================================================================ 미리보기 보기 크기·화면 맞춤
const readerSheet = (t) => t.$('#reader .reader');
const zoomText = (t) => t.$('#rv-reset').textContent;
async function openNth(t, i = 0) {
  t.app.openReader(t.server.list('all')[i]);
  await t.clock.advance(0);
}

test('frontend(보기 크기): 조절 줄은 미리보기 머리에 하나, 여러 번 열고 다시 그려도 늘지 않고 이벤트도 한 번', async () => {
  const t = await boot({ hash: '#/b/all', server: makeServer({ admin: true }) }); // 관리자: renderReader 가 버튼을 더 그린다
  for (const i of [0, 1, 0]) {
    await openNth(t, i);
    t.app.closeOverlay(t.$('#reader'));
    await t.clock.advance(0);
  }
  await openNth(t, 2);
  assert.equal(t.$$('.reader-view').length, 1);
  const bar = t.$('#reader-view');
  assert.ok(bar.closest('.reader-head'), '미리보기 머리 안');
  assert.equal(bar.closest('#reader-actions'), null, '글마다 통째로 바뀌는 #reader-actions 밖');
  assert.deepEqual(t.$$('#reader-view button').map((b) => b.textContent), ['−', '100%', '+', '화면 맞춤']);
  for (const id of ['#rv-out', '#rv-reset', '#rv-in', '#rv-fit']) assert.equal(t.$(id)._ls.count('click'), 1, `${id} 클릭 이벤트는 하나`);
  // 한 번 누르면 한 단계만 (이벤트가 겹쳐 붙었으면 여러 단계 움직인다)
  t.$('#rv-out').click();
  assert.equal(zoomText(t), '90%');
  t.$('#rv-fit').click();
  assert.equal(t.$('#rv-fit').getAttribute('aria-pressed'), 'true', '두 번 붙었으면 켜졌다 바로 꺼진다');
  assert.equal(t.$('#reader').hidden, false, '조절 버튼은 미리보기를 닫지 않는다');
  // 다른 창에는 조절 줄이 없다
  for (const id of ['#pw-modal', '#settings-modal', '#rules-modal']) assert.equal(t.$(`${id} .reader-view`), null, id);
});

test('frontend(보기 크기): − / + 는 50~150% 단계, 끝에서 aria-disabled(포커스는 그 자리), 가운데 숫자는 100%로', async () => {
  const t = await boot({ hash: '#/b/all' });
  await openNth(t);
  const sheet = readerSheet(t);
  const off = (id) => t.$(id).getAttribute('aria-disabled');
  // Enter·Space 는 포커스가 있는 버튼에 click 으로 간다 (누르고 있으면 반복)
  const enter = () => t.doc.activeElement.click();
  assert.equal(zoomText(t), '100%');
  assert.equal(sheet.classList.contains('zoomed'), false);
  assert.equal(sheet.style.getPropertyValue('--rz'), '1');
  assert.equal(off('#rv-out'), 'false');
  assert.equal(off('#rv-in'), 'false');

  const seen = [];
  t.$('#rv-out').focus();
  for (let i = 0; i < 7; i++) {
    enter();
    seen.push(zoomText(t));
  }
  assert.deepEqual(seen, ['90%', '80%', '70%', '60%', '50%', '50%', '50%'], '끝에 닿은 뒤 이어 누른 Enter 는 100%로 되돌리지 않는다');
  assert.equal(off('#rv-out'), 'true', '50% 에서 − 비활성 표시');
  assert.equal(off('#rv-in'), 'false');
  assert.equal(sheet.classList.contains('zoomed'), true);
  assert.equal(sheet.style.getPropertyValue('--rz'), '0.5');
  assert.equal(t.doc.activeElement, t.$('#rv-out'), '포커스는 − 에 그대로');
  for (const id of ['#rv-out', '#rv-in']) assert.equal(t.$(id).disabled, false, `${id} 는 disabled 가 아니다 (포커스가 빠지지 않게)`);
  assert.equal(t.storage.get('hg.readerZoom'), '50');
  assert.match(t.$('#rv-reset').getAttribute('aria-label'), /50%/);

  t.$('#rv-reset').click();
  assert.equal(zoomText(t), '100%');
  assert.equal(sheet.classList.contains('zoomed'), false);
  assert.equal(sheet.style.getPropertyValue('--rz'), '1');
  assert.equal(off('#rv-out'), 'false');

  seen.length = 0;
  t.$('#rv-in').focus();
  for (let i = 0; i < 5; i++) {
    enter();
    seen.push(zoomText(t));
  }
  assert.deepEqual(seen, ['115%', '130%', '150%', '150%', '150%']);
  assert.equal(off('#rv-in'), 'true', '150% 에서 + 비활성 표시');
  assert.equal(t.doc.activeElement, t.$('#rv-in'), '포커스는 + 에 그대로');
  assert.equal(sheet.style.getPropertyValue('--rz'), '1.5');
  assert.equal(t.storage.get('hg.readerZoom'), '150');

  // 미리보기 글 상자에만 붙는다 (목록·다른 창은 그대로)
  assert.equal(t.$$('.zoomed').length, 1);
  assert.equal(t.$$('.zoomed')[0], sheet);
  assert.equal(t.$('#posts').closest('.zoomed'), null);
});

test('frontend(보기 크기): 단축키로 끝에 닿아도 −/+ 의 포커스가 사라지지 않고, 바뀐 크기는 status 로 알린다 (시작할 때는 조용히)', async () => {
  const t = await boot({ hash: '#/b/all', stored: { 'hg.readerZoom': '80' } });
  const status = t.$('#rv-status');
  assert.equal(status.getAttribute('role'), 'status');
  assert.ok(status.closest('#reader .reader[role="dialog"]'), '미리보기 대화 상자 안 (뒤 화면처럼 inert 가 되지 않는다)');
  assert.equal(status.textContent, '', '저장된 크기를 맞출 때는 알리지 않는다');
  await openNth(t);
  assert.equal(status.textContent, '', '여는 것만으로는 알리지 않는다');

  t.$('#rv-in').focus();
  for (const want of ['90%', '100%', '115%', '130%', '150%']) {
    await t.key('+');
    assert.equal(status.textContent, want);
  }
  assert.equal(t.$('#rv-in').getAttribute('aria-disabled'), 'true');
  assert.equal(t.$('#rv-in').disabled, false);
  assert.equal(t.doc.activeElement, t.$('#rv-in'), '단축키로 끝에 닿아도 포커스는 + 에');
  // 바뀌지 않으면(끝에서 또 누름) 그대로, 화면 맞춤은 크기를 알리지 않는다 (버튼의 aria-pressed 가 알린다)
  status.textContent = '';
  await t.key('+');
  assert.equal(status.textContent, '');
  t.$('#rv-fit').click();
  assert.equal(status.textContent, '');
  t.$('#rv-out').click();
  assert.equal(status.textContent, '130%', '버튼으로 바꿔도 알린다');
  t.$('#rv-out').focus();
  for (let i = 0; i < 8; i++) await t.key('-');
  assert.equal(zoomText(t), '50%');
  assert.equal(t.doc.activeElement, t.$('#rv-out'), '− 쪽 끝도 마찬가지');
  assert.equal(status.textContent, '50%');
  // 토스트(방송 화면에 보이는 글자)는 쓰지 않는다
  assert.equal(t.toastText(), '');
});

test('frontend(화면 맞춤): 세로로 아주 긴 캡처(높이 ÷ 너비 > 2.2)는 다 받아진 뒤 data-tall 을 붙여 맞춤에서 뺀다', async () => {
  const t = await boot({ hash: '#/b/all' });
  await openNth(t);
  const body = t.$('#reader-body');
  const img = (w, hgt) => {
    const el = t.doc.createElement('img');
    el.naturalWidth = w;
    el.naturalHeight = hgt;
    body.append(el);
    el.dispatchEvent(new FakeEvent('load')); // load 는 버블링하지 않는다 — 본문 상자가 캡처 단계에서 받는다
    return el;
  };
  assert.equal(img(540, 10000).hasAttribute('data-tall'), true, '540×10000 캡처는 내려 읽게');
  assert.equal(img(600, 1300).hasAttribute('data-tall'), false, '2.2 배 이하는 한 화면에 맞춘다');
  assert.equal(img(640, 800).hasAttribute('data-tall'), false);
  const notYet = t.doc.createElement('img');
  body.append(notYet);
  notYet.dispatchEvent(new FakeEvent('load'));
  assert.equal(notYet.hasAttribute('data-tall'), false, '크기를 모르면 건드리지 않는다');
});

test('frontend(화면 맞춤): 켜면 .fit·aria-pressed, 보이는 화면 높이(px)를 넣고 창 크기가 바뀌면 다시, 보기 크기와 함께 쓴다', async () => {
  const t = await boot({ hash: '#/b/all' });
  await openNth(t);
  const sheet = readerSheet(t);
  const fit = t.$('#rv-fit');
  assert.equal(fit.getAttribute('aria-pressed'), 'false');
  assert.equal(sheet.classList.contains('fit'), false);
  fit.click();
  assert.equal(fit.getAttribute('aria-pressed'), 'true');
  assert.equal(sheet.classList.contains('fit'), true);
  assert.equal(t.storage.get('hg.readerFit'), 'true');
  assert.equal(t.storage.has('hg.readerZoom'), false, '바꾼 값만 저장');
  assert.equal(sheet.style.getPropertyValue('--fit-h'), '768px', '화면 높이 800 에서 위아래 여유 32');
  t.ctx.innerHeight = 600;
  t.win.dispatchEvent(new FakeEvent('resize'));
  assert.equal(sheet.style.getPropertyValue('--fit-h'), '568px', '창 크기·화면 방향이 바뀌면 다시');

  t.$('#rv-out').click();
  assert.equal(zoomText(t), '90%');
  assert.equal(sheet.classList.contains('fit'), true, '보기 크기를 바꿔도 화면 맞춤은 그대로');
  assert.equal(sheet.classList.contains('zoomed'), true);
  fit.click();
  assert.equal(fit.getAttribute('aria-pressed'), 'false');
  assert.equal(sheet.classList.contains('fit'), false);
  assert.equal(sheet.classList.contains('zoomed'), true, '화면 맞춤을 꺼도 보기 크기는 그대로');
  assert.equal(t.storage.get('hg.readerFit'), 'false');
});

test('frontend(보기 크기): 브라우저마다 기억해 다시 열어도 그대로, 이상한 값·막힌 저장소에서는 기본값(100%, 끔)', async () => {
  const t = await boot({ hash: '#/b/all', stored: { 'hg.readerZoom': '80', 'hg.readerFit': 'true' } });
  assert.equal(zoomText(t), '80%', '열기 전부터 맞춰 둔다');
  await openNth(t);
  assert.equal(readerSheet(t).classList.contains('zoomed'), true);
  assert.equal(readerSheet(t).style.getPropertyValue('--rz'), '0.8');
  assert.equal(t.$('#rv-fit').getAttribute('aria-pressed'), 'true');
  assert.equal(readerSheet(t).classList.contains('fit'), true);
  // 닫았다가 다른 글을 열어도 유지
  t.$('#rv-out').click();
  t.app.closeOverlay(t.$('#reader'));
  await t.clock.advance(0);
  await openNth(t, 1);
  assert.equal(zoomText(t), '70%');
  assert.equal(readerSheet(t).classList.contains('fit'), true);
  assert.equal(t.storage.get('hg.readerZoom'), '70');
  // 새로 켜도 (같은 저장소) 그대로
  const again = await boot({ stored: Object.fromEntries(t.storage) });
  assert.equal(zoomText(again), '70%');
  assert.equal(again.$('#rv-fit').getAttribute('aria-pressed'), 'true');

  for (const stored of [{ 'hg.readerZoom': '75', 'hg.readerFit': '"yes"' }, { 'hg.readerZoom': '"big"', 'hg.readerFit': '1' }, { 'hg.readerZoom': '{oops', 'hg.readerFit': '{' }]) {
    const b = await boot({ stored });
    assert.equal(zoomText(b), '100%', JSON.stringify(stored));
    assert.equal(b.$('#rv-fit').getAttribute('aria-pressed'), 'false', JSON.stringify(stored));
    assert.equal(readerSheet(b).classList.contains('zoomed'), false);
    assert.equal(readerSheet(b).classList.contains('fit'), false);
  }

  const broken = await boot({ hash: '#/b/all', brokenStorage: true });
  assert.equal(zoomText(broken), '100%');
  assert.equal(broken.$('#rv-fit').getAttribute('aria-pressed'), 'false');
  assert.ok(broken.rowIds().length > 0, '저장소가 막혀도 목록은 뜬다');
  await openNth(broken);
  broken.$('#rv-in').click();
  broken.$('#rv-fit').click();
  assert.equal(zoomText(broken), '115%', '저장하지 못해도 화면은 바뀐다');
  assert.equal(broken.$('#rv-fit').getAttribute('aria-pressed'), 'true');
  assert.equal(readerSheet(broken).classList.contains('fit'), true);
});

test('frontend(보기 크기): 단축키 - + = 0 f ㄹ 는 미리보기가 맨 위에 열려 있을 때만, 입력칸 안·Ctrl/⌘/Alt 조합·Esc 와 겹치지 않게', async () => {
  const t = await boot({ hash: '#/b/all', server: makeServer({ admin: true }) });
  const sheet = readerSheet(t);
  const isFit = () => sheet.classList.contains('fit');
  // 미리보기가 닫혀 있으면 무시
  let ev = await t.key('-');
  assert.equal(zoomText(t), '100%');
  assert.equal(ev.defaultPrevented, false);
  await t.key('f');
  assert.equal(isFit(), false);

  await openNth(t);
  ev = await t.key('-');
  assert.equal(zoomText(t), '90%');
  assert.equal(ev.defaultPrevented, true);
  const steps = [];
  for (const k of ['-', '+', '=', '=', '0']) {
    await t.key(k);
    steps.push(zoomText(t));
  }
  assert.deepEqual(steps, ['80%', '90%', '100%', '115%', '100%']);
  await t.key('f');
  assert.equal(isFit(), true);
  await t.key('ㄹ');
  assert.equal(isFit(), false, '한글 자판에서 f 자리');
  await t.key('F');
  assert.equal(isFit(), true, 'Caps Lock·Shift');
  await t.key('f', { repeat: true });
  assert.equal(isFit(), true, '누르고 있는 반복 입력으로 켜졌다 꺼졌다 하지 않는다');
  ev = await t.key('a');
  assert.equal(ev.defaultPrevented, false, '다른 키는 그대로');

  // 브라우저 확대(Ctrl/⌘ +, -, 0) 등 조합은 건드리지 않는다
  for (const mod of ['ctrlKey', 'metaKey', 'altKey']) {
    for (const k of ['-', '+', '=', '0', 'f']) {
      ev = await t.key(k, { [mod]: true });
      assert.equal(ev.defaultPrevented, false, `${mod} + ${k}`);
    }
  }
  assert.equal(zoomText(t), '100%');
  assert.equal(isFit(), true);

  // 한글 조합 중(IME) 키와 다른 곳에서 이미 처리한(preventDefault) 키도 건드리지 않는다
  for (const k of ['-', '+', '0', 'f', 'ㄹ']) {
    ev = await t.key(k, { isComposing: true });
    assert.equal(ev.defaultPrevented, false, `조합 중 ${k}`);
  }
  assert.equal(zoomText(t), '100%');
  assert.equal(isFit(), true);
  for (const k of ['-', '+', 'f']) {
    const pre = new FakeEvent('keydown', { key: k, bubbles: true });
    pre.preventDefault();
    t.doc.body.dispatchEvent(pre);
    await t.clock.advance(0);
  }
  assert.equal(zoomText(t), '100%', '이미 처리된 키는 무시');
  assert.equal(isFit(), true);

  // 입력칸 안: 관리자 메모(textarea), contenteditable
  t.$('#reader-admin textarea').focus();
  ev = await t.key('-');
  await t.key('f');
  assert.equal(zoomText(t), '100%');
  assert.equal(isFit(), true);
  assert.equal(ev.defaultPrevented, false, '메모에 - 가 그대로 입력된다');
  const editable = t.doc.createElement('div');
  editable.setAttribute('contenteditable', 'true');
  t.$('#reader-body').append(editable);
  editable.focus();
  await t.key('-');
  assert.equal(zoomText(t), '100%');

  // 미리보기 위에 다른 창(비밀번호)이 떠 있으면 무시하고, Esc 는 예전처럼 맨 위 창부터 닫는다
  t.app.promptPassword({ title: '확인', desc: '', endpoint: '/api/admin/login' });
  await t.clock.advance(50);
  t.doc.body.focus();
  await t.key('-');
  assert.equal(zoomText(t), '100%');
  await t.key('Escape');
  assert.equal(t.$('#pw-modal').hidden, true);
  assert.equal(t.$('#reader').hidden, false);
  t.$('.reader .close').focus();
  await t.key('-');
  assert.equal(zoomText(t), '90%', '비밀번호 창이 닫히면 다시 동작');
  await t.key('Escape');
  assert.equal(t.$('#reader').hidden, true, 'Esc 는 미리보기를 닫는다');
  assert.equal(zoomText(t), '90%', 'Esc 는 크기를 바꾸지 않는다');
  await t.key('-');
  assert.equal(zoomText(t), '90%', '닫힌 뒤에는 다시 무시');
});

// 미리보기의 가짜 배치 (가짜 DOM 에는 배치가 없으니 손으로): 화면(오버레이) 높이 800,
// 머리 186 → 본문 [앞 글 300 → 여백 24 → 1080×6000 긴 캡처(720 폭이면 4000) → 여백 24 → 뒤 글 1500] → 꼬리 170.
// 본문은 보기 크기(--rz)만큼 함께 줄고, 화면 맞춤이면 캡처만 보이는 화면 높이(--fit-h)로 줄어든다. 요소의 화면 위치는 scrollTop 을 따라 움직인다
function fakeReaderLayout(t) {
  const ov = t.$('#reader');
  const sheet = readerSheet(t);
  t.$('#reader-body').innerHTML = '<p id="lead">앞 글</p><img id="cap" src="cap.png"><p id="tail">뒤 글 <b>굵게</b></p>';
  const H = 800;
  const boxes = () => {
    const z = Number(sheet.style.getPropertyValue('--rz') || 1);
    const cap = sheet.classList.contains('fit') ? Math.min(parseFloat(sheet.style.getPropertyValue('--fit-h')), 4000 * z) : 4000 * z;
    const b = {};
    let y = 0;
    const put = (name, h, gap = 0) => {
      y += gap;
      b[name] = [y, h];
      y += h;
    };
    put('head', 186);
    put('lead', 300 * z);
    put('cap', cap, 24 * z);
    put('tail', 1500 * z, 24 * z);
    b.body = [b.lead[0], y - b.lead[0]];
    put('foot', 170);
    b.total = y;
    return b;
  };
  let scrollTop = 0;
  Object.defineProperties(ov, {
    scrollTop: { get: () => scrollTop, set: (v) => (scrollTop = v), configurable: true },
    scrollHeight: { get: () => boxes().total, configurable: true },
    clientHeight: { value: H, configurable: true },
    _rect: { value: { top: 0, bottom: H, left: 0, right: 760, width: 760, height: H }, configurable: true },
  });
  const rectOf = (name) => () => {
    const [top, h] = boxes()[name];
    return { top: top - scrollTop, bottom: top - scrollTop + h, left: 0, right: 760, width: 760, height: h };
  };
  const named = { '.reader-head': 'head', '#reader-body': 'body', '#lead': 'lead', '#cap': 'cap', '#tail': 'tail', '#reader-foot': 'foot' };
  for (const [sel, name] of Object.entries(named)) Object.defineProperty(t.$(sel), '_rect', { get: rectOf(name), configurable: true });
  const none = { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 };
  for (const sel of ['#reader-admin', '#reader-comments']) Object.defineProperty(t.$(sel), '_rect', { value: none, configurable: true }); // 숨은 요소
  // '<b>' 는 뒤 글 맨 끝 줄에 있다 (가운데에 걸치지 않은 안쪽 요소, 줄 높이도 보기 크기를 따른다)
  const bold = () => {
    const r = rectOf('tail')();
    const h = 26 * Number(sheet.style.getPropertyValue('--rz') || 1);
    return { ...r, top: r.bottom - h, height: h };
  };
  Object.defineProperty(t.$('#tail b'), '_rect', { get: bold, configurable: true });
  const at = (name, frac) => boxes()[name][0] + frac * boxes()[name][1]; // 내용 안의 위치
  return {
    get scrollTop() { return scrollTop; },
    set scrollTop(v) { scrollTop = v; },
    middle: () => scrollTop + H / 2, // 지금 화면 가운데에 있는 내용 위치
    centre: (name, frac) => (scrollTop = at(name, frac) - H / 2), // 그 위치를 화면 가운데로
    at,
  };
}
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 0.5, `${msg}: ${a} ≠ ${b}`);

test('frontend(보기 크기): 크기·화면 맞춤을 바꿔도 화면 가운데에 있던 내용이 그대로 가운데 (전체 비율이 아니라 가운데 요소 기준)', async () => {
  const t = await boot({ hash: '#/b/all' });
  await openNth(t);
  const L = fakeReaderLayout(t);

  // 맨 위에서 바꾸면 맨 위 그대로 (크게 해도 머리부터)
  await t.key('f');
  assert.equal(L.scrollTop, 0);
  await t.key('f');
  await t.key('+');
  await t.key('+');
  assert.equal(L.scrollTop, 0);
  await t.key('0');
  assert.equal(L.scrollTop, 0);

  // 긴 캡처 바로 아래 글을 읽다가 화면 맞춤 켜기 → 캡처만 768 로 줄어도 같은 글이 가운데 (옛 전체 비율 방식은 화면 하나 가까이 아래로 튀었다)
  L.centre('tail', 0.2);
  const before = L.scrollTop;
  await t.key('f');
  assert.equal(readerSheet(t).classList.contains('fit'), true);
  near(L.middle(), L.at('tail', 0.2), '맞춤 켜기');
  assert.ok(before - L.scrollTop > 3000, '줄어든 캡처 높이만큼 위로');
  // 같은 자리에서 끄기 → 원래 자리 (옛 방식은 캡처 한가운데로 갔다)
  await t.key('f');
  near(L.middle(), L.at('tail', 0.2), '맞춤 끄기');
  near(L.scrollTop, before, '켰다 끄면 처음 자리');

  // 보기 크기: 글이 함께 줄어도 같은 글의 같은 지점
  await t.key('-');
  assert.equal(zoomText(t), '90%');
  near(L.middle(), L.at('tail', 0.2), '작게');
  t.$('#rv-in').click();
  t.$('#rv-in').click();
  assert.equal(zoomText(t), '115%');
  near(L.middle(), L.at('tail', 0.2), '크게');
  t.$('#rv-reset').click();

  // 캡처 중간을 보다가 맞춤 → 캡처의 같은 높이 비율이 가운데
  L.centre('cap', 0.25);
  t.$('#rv-fit').click();
  near(L.middle(), L.at('cap', 0.25), '그림 안에서 맞춤 켜기');
  t.$('#rv-fit').click();
  near(L.middle(), L.at('cap', 0.25), '그림 안에서 맞춤 끄기');

  // 요소 사이 여백에 걸쳐 있으면 바로 위·아래 요소 끝 사이의 같은 지점
  L.centre('lead', 1);
  L.scrollTop += 9;
  t.$('#rv-fit').click();
  near(L.middle(), L.at('lead', 1) + 9, '여백에서 맞춤 켜기');
  t.$('#rv-fit').click();
  // 캡처 바로 아래 여백: 위 경계는 캡처의 아래 끝 (감싼 본문의 위 끝이면 줄어든 캡처만큼 어긋난다)
  L.centre('cap', 1);
  L.scrollTop += 9;
  t.$('#rv-fit').click();
  near(L.middle(), L.at('cap', 1) + 9, '캡처 아래 여백에서 맞춤 켜기');
  t.$('#rv-fit').click();
  near(L.middle(), L.at('cap', 1) + 9, '캡처 아래 여백에서 맞춤 끄기');

  // 뒤 글 안쪽 요소(<b>, 끝 줄)가 가운데에 걸치지 않으면 뒤 글 위 끝 ~ <b> 위 끝 사이 비율 (글이 줄어도 같은 지점)
  L.centre('tail', 0.5);
  await t.key('-');
  near(L.middle(), L.at('tail', 0.5), '글자 줄 사이에서 작게');
  t.$('#rv-fit').click();
  near(L.middle(), L.at('tail', 0.5), '글자 줄 사이에서 맞춤 켜기');
  t.$('#rv-fit').click();
  await t.key('0');

  // 닫힌 미리보기는 건드리지 않는다
  t.app.closeOverlay(t.$('#reader'));
  await t.clock.advance(0);
  L.scrollTop = 1234;
  t.$('#rv-in').click();
  assert.equal(L.scrollTop, 1234);
});


test('frontend(보기 크기): CSS — zoom 은 지원할 때만 본문·댓글에, 그림·영상·iframe 은 상자 안 가운데, 화면 맞춤은 화면 높이, 미리보기 안에만·색은 변수만', () => {
  const flat = CSS_SRC.replace(/\s+/g, ' ');
  const start = flat.indexOf('/* ---------- 미리보기 보기 크기');
  assert.ok(start > 0, '보기 크기 구역');
  const block = flat.slice(start, flat.indexOf('.toast {', start));
  assert.match(block, /\.reader \{ --rz: 1; --rzc: 1; \}/);
  assert.match(block, /@supports \(zoom: 1\) \{ \/\*[^*]*\*\/ \.reader\.zoomed \{ --rzc: var\(--rz\); \} \.reader\.zoomed \.reader-body, \.reader\.zoomed \.cm-body \{ zoom: var\(--rz\); \}/, '본문과 댓글 목록에 zoom');
  assert.match(block, /@supports not \(zoom: 1\) \{ \/\*[^*]*\*\/ \.reader\.zoomed \.reader-body \{ font-size: calc\(16px \* var\(--rz\)\); \}/, 'zoom 을 모르면 글자 크기로');
  assert.match(block, /\.reader\.zoomed \.reader-body img, \.reader\.zoomed \.reader-body video, \.reader\.zoomed \.reader-body iframe \{ max-width: min\(100%, calc\(100% \* var\(--rz\)\)\); margin-left: auto; margin-right: auto; \}/);
  assert.match(block, /\.reader\.fit \.reader-body img:not\(\[data-tall\]\), \.reader\.fit \.reader-body video \{ width: auto; height: auto; max-height: calc\(var\(--fit-h, 90vh\) \/ var\(--rzc\)\); margin-left: auto; margin-right: auto; \}/);
  assert.match(block, /\.reader\.fit \.reader-body iframe \{[^}]*max-width: min\(100%, calc\(100% \* var\(--rz\)\), calc\(var\(--fit-h, 90vh\) \/ var\(--rzc\) \* 16 \/ 9\)\);/);
  // 표는 넘치면 안에서 가로 스크롤 (예전 규칙 유지), pre 도
  assert.match(flat, /\.reader-body table \{ max-width: 100%; display: block; overflow-x: auto; \}/);
  assert.match(flat, /\.reader-body pre \{ max-width: 100%; overflow-x: auto; \}/);
  // 손가락으로 누르기 쉬운 높이, 켜진 화면 맞춤은 강조색
  const btn = /\.reader-view button \{([^}]*)\}/.exec(block)[1];
  assert.ok(Number(/(?:^|[ ;])height: (\d+)px/.exec(btn)[1]) >= 32, '버튼 높이 32px 이상');
  assert.match(block, /\.reader-view \.rv-fit\[aria-pressed='true'\] \{[^}]*var\(--accent\)/);
  assert.match(block, /\.reader-tools \{[^}]*flex-wrap: wrap;/, '좁은 화면에서는 줄바꿈');
  // 상태 표시 글자는 본문 색 (밝은 화면의 --accent 글자는 대비 약 3:1), 상태는 바탕·테두리로
  for (const sel of [/\.reader\.zoomed \.reader-view \.rv-num/, /\.reader-view \.rv-fit\[aria-pressed='true'\]/]) {
    const rule = new RegExp(`${sel.source} \\{([^}]*)\\}`).exec(block)[1];
    assert.match(rule, /(?:^|[ ;])color: var\(--text\);/, sel.source);
    assert.match(rule, /background: var\(--accent-soft\);/, sel.source);
    assert.match(rule, /box-shadow: inset 0 0 0 1px var\(--accent\);/, sel.source);
  }
  // 끝의 −/+ 는 disabled 가 아니라 aria-disabled 로 흐리게 (포커스가 남는다)
  assert.match(block, /\.reader-view button\[aria-disabled='true'\] \{ opacity: 0\.35;/);
  assert.match(block, /\.reader-view button:hover:not\(\[aria-disabled='true'\]\)/);
  assert.doesNotMatch(block, /:disabled/);
  // 휴대폰: 보기 줄은 화면 아래 가운데에 고정, 꼬리는 그만큼 띄운다
  const phone = /@media \(max-width: 640px\) \{ \/\*[^*]*\*\/ \.reader-view \{([^}]*)\}([^}]*\})/.exec(block);
  assert.ok(phone, '휴대폰 보기 줄 구역');
  assert.match(phone[1], /position: fixed;/);
  assert.match(phone[1], /bottom: calc\(12px \+ env\(safe-area-inset-bottom, 0px\)\);/);
  assert.match(phone[1], /width: max-content;/, '왼쪽 50% 로 폭이 반으로 줄어 두 줄이 되지 않게');
  assert.match(phone[1], /background: var\(--surface-2\);/);
  assert.match(phone[2], /\.reader-foot \{ padding-bottom: calc\(72px \+ env\(safe-area-inset-bottom, 0px\)\); \}/);
  // 색은 :root 변수만 (밝은·어두운 화면 둘 다 따라간다)
  assert.doesNotMatch(block, /#[0-9a-f]{3,8}\b|rgba?\(/i);
  // 모든 규칙이 미리보기 안에만 걸린다 (목록·다른 창에는 영향 없음)
  const selectors = [...block.replace(/\/\*.*?\*\//g, '').matchAll(/([^{}]+)\{/g)]
    .map((m) => m[1].trim())
    .filter((s) => !s.startsWith('@'))
    .flatMap((s) => s.split(',').map((x) => x.trim()));
  assert.ok(selectors.length > 10);
  for (const s of selectors) assert.match(s, /^\.reader([-.\s]|$)/, s);
  // 휴대폰: 머리 오른쪽 60px 는 그대로 닫기 ✕ 자리
  const mobile = flat.slice(flat.indexOf('@media (max-width: 640px)'));
  assert.match(mobile, /\.reader-head \{ padding: 14px 60px 10px 16px; \}/);
  assert.match(flat, /\.reader-head \{ padding: 18px 68px 12px 20px;/);
});
