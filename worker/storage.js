// Durable Object(SiteDO) SQLite 저장소. 로컬의 data/*.json 대신 쓰는 백엔드들이다.
//   posts         글 하나 = 행 하나 (값 하나 2MB 한도 — 글 전체를 한 값에 넣지 않는다)
//   kv            출처 상태·마지막 수집 시각·실행 설정·관리자 금지어·'지금 수집' 요청 등 작은 값
//   reads         미리보기 캐시 (원문에서 가져와 정리한 본문, 기본 12시간)
//   attempts      비밀번호 시도 기록 (DO 가 메모리에서 내려가도 시도 제한이 풀리지 않게)
//   import_posts  옮기기(/api/admin/import) 중 받은 글 — commit 때 한 번에 바꾼다
// sql.exec 는 동기라 저장소 백엔드도 동기다. 쿼리 하나에 문장 하나만 쓴다.

/** 값 하나의 상한 (DO SQLite 의 문자열·행 한도 2MB 보다 조금 아래, UTF-8 바이트) */
export const VALUE_MAX_BYTES = 1_900_000;
const enc = new TextEncoder();

/** UTF-8 로 VALUE_MAX_BYTES 를 넘는지 (짧은 글은 바이트를 세지 않는다) */
export function tooBig(text) {
  if (text.length * 3 <= VALUE_MAX_BYTES) return false;
  return enc.encode(text).length > VALUE_MAX_BYTES;
}

export function migrate(sql) {
  sql.exec('CREATE TABLE IF NOT EXISTS posts (id TEXT PRIMARY KEY, json TEXT NOT NULL)');
  sql.exec('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
  sql.exec('CREATE TABLE IF NOT EXISTS reads (id TEXT PRIMARY KEY, at INTEGER NOT NULL, json TEXT NOT NULL)');
  sql.exec('CREATE TABLE IF NOT EXISTS attempts (kind TEXT NOT NULL, k TEXT NOT NULL, n INTEGER NOT NULL, reset_at INTEGER NOT NULL, PRIMARY KEY (kind, k))');
  sql.exec('CREATE TABLE IF NOT EXISTS import_posts (seq INTEGER PRIMARY KEY AUTOINCREMENT, json TEXT NOT NULL)');
}

const rows = (cursor) => (typeof cursor?.toArray === 'function' ? cursor.toArray() : [...cursor]);

/** 작은 JSON 값 저장소 */
export function kvStore(sql) {
  return {
    get(k) {
      const r = rows(sql.exec('SELECT v FROM kv WHERE k = ?', k))[0];
      if (!r) return undefined;
      try {
        return JSON.parse(r.v);
      } catch {
        return undefined;
      }
    },
    set(k, v) {
      const text = JSON.stringify(v ?? null);
      if (tooBig(text)) throw new Error(`저장할 값이 너무 커요 (${k})`);
      sql.exec('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', k, text);
    },
    del(k) {
      sql.exec('DELETE FROM kv WHERE k = ?', k);
    },
  };
}

/**
 * 글 저장소 (src/store.js 의 백엔드). 바뀐 글만 쓰고, 요청·알람이 끝날 때 store.flush() 로 저장한다.
 * @param {{sql: any, transactionSync?: (fn: () => any) => any}} storage DO 의 ctx.storage
 */
export function postsBackend(storage) {
  const sql = storage.sql;
  const kv = kvStore(sql);
  const tx = (fn) => (typeof storage.transactionSync === 'function' ? storage.transactionSync(fn) : fn());
  const put = (p) => {
    const text = JSON.stringify(p);
    if (tooBig(text)) {
      console.warn(`[store] 글이 너무 커서 저장하지 않았어요: ${p.id}`);
      return;
    }
    sql.exec('INSERT INTO posts (id, json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json', p.id, text);
  };
  return {
    autosave: false,
    load() {
      const posts = {};
      for (const r of rows(sql.exec('SELECT id, json FROM posts'))) {
        try {
          posts[r.id] = JSON.parse(r.json);
        } catch {
          console.warn(`[store] 깨진 글 행을 건너뜀: ${r.id}`);
        }
      }
      return { posts, sources: kv.get('sources') ?? {}, lastCrawlAt: kv.get('lastCrawlAt') ?? null, settings: kv.get('settings') ?? {} };
    },
    save(db, ch) {
      tx(() => {
        if (ch.all) {
          sql.exec('DELETE FROM posts');
          for (const p of Object.values(db.posts)) put(p);
        } else {
          for (const id of ch.deleted) sql.exec('DELETE FROM posts WHERE id = ?', id);
          for (const id of ch.posts) if (Object.hasOwn(db.posts, id)) put(db.posts[id]);
        }
        if (ch.all || ch.meta) {
          kv.set('sources', db.sources);
          kv.set('lastCrawlAt', db.lastCrawlAt);
          kv.set('settings', db.settings);
        }
      });
    },
  };
}

/** 관리자 금지어 (src/filter.js 의 백엔드) */
export function rulesBackend(kv) {
  return {
    load: () => kv.get('customRules') ?? null,
    save: (rules) => kv.set('customRules', rules),
  };
}

/** 미리보기 캐시 (src/reader.js setReadCache) */
export function readCache(sql) {
  return {
    get(id) {
      const r = rows(sql.exec('SELECT at, json FROM reads WHERE id = ?', id))[0];
      if (!r) return null;
      try {
        return { at: Number(r.at), data: JSON.parse(r.json) };
      } catch {
        return null;
      }
    },
    set(id, at, data) {
      const text = JSON.stringify(data);
      if (tooBig(text)) return; // 너무 큰 본문은 메모리에만 (다음엔 원문에서 다시)
      sql.exec('INSERT INTO reads (id, at, json) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET at = excluded.at, json = excluded.json', id, at, text);
    },
    delete(id) {
      sql.exec('DELETE FROM reads WHERE id = ?', id);
    },
    clear() {
      sql.exec('DELETE FROM reads');
    },
  };
}

/** 오래됐거나 글이 없어진 미리보기를 지운다 (글 저장을 마친 뒤에 부른다) */
export function pruneReads(sql, ttlMs, now = Date.now()) {
  sql.exec('DELETE FROM reads WHERE at < ?', now - ttlMs);
  sql.exec('DELETE FROM reads WHERE id NOT IN (SELECT id FROM posts)');
}

/** 비밀번호 시도 기록 (src/api.js memoryAttempts 와 같은 모양) */
export function attemptsStore(sql, { max = 10, windowMs = 10 * 60e3 } = {}) {
  const get = (kind, key) => rows(sql.exec('SELECT n, reset_at FROM attempts WHERE kind = ? AND k = ?', kind, key))[0];
  return {
    limited(kind, key, now) {
      const a = get(kind, key);
      return !!a && Number(a.reset_at) > now && Number(a.n) >= max;
    },
    fail(kind, key, now) {
      sql.exec('DELETE FROM attempts WHERE reset_at <= ?', now);
      const a = get(kind, key);
      if (!a) sql.exec('INSERT INTO attempts (kind, k, n, reset_at) VALUES (?, ?, 1, ?)', kind, key, now + windowMs);
      else sql.exec('UPDATE attempts SET n = n + 1 WHERE kind = ? AND k = ?', kind, key);
    },
    clear(kind, key) {
      sql.exec('DELETE FROM attempts WHERE kind = ? AND k = ?', kind, key);
    },
  };
}

/** 옮기기 대기열 (src/api.js memoryStaging 과 같은 모양). 시작한 지 한 시간이 지나면 처음부터 다시. */
export function stagingStore(sql, kv, { maxAgeMs = 3600e3 } = {}) {
  return {
    begin(id) {
      sql.exec('DELETE FROM import_posts');
      kv.set('importId', { id, at: Date.now() });
    },
    is(id) {
      const cur = kv.get('importId');
      return !!cur && typeof id === 'string' && cur.id === id && Date.now() - cur.at < maxAgeMs;
    },
    add(id, list) {
      for (const p of list) sql.exec('INSERT INTO import_posts (json) VALUES (?)', JSON.stringify(p));
      return this.count();
    },
    count() {
      return Number(rows(sql.exec('SELECT COUNT(*) AS n FROM import_posts'))[0]?.n ?? 0);
    },
    take() {
      const out = [];
      for (const r of rows(sql.exec('SELECT json FROM import_posts ORDER BY seq'))) {
        try {
          out.push(JSON.parse(r.json));
        } catch {}
      }
      return out;
    },
    clear() {
      sql.exec('DELETE FROM import_posts');
      kv.del('importId');
    },
  };
}
