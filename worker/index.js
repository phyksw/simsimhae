// 호네키 쇼츠 장부 — 정적 화면(public/) + 추천 API(/api/*).
// 추천은 Durable Object(SQLite) 하나에 모은다.
// - '내 추천'(누가 눌렀나)은 브라우저마다 내려 주는 무작위 쿠키로 구분한다(같은 와이파이·통신사 IP 를 쓰는 사람끼리 섞이지 않게).
// - IP 는 속도 제한과 'IP 하나가 같은 에피소드에 넣을 수 있는 추천 수(최대 3)'에만 쓴다. IPv6 는 /64 로 묶는다.
// - 쿠키·IP 는 그대로 저장하지 않고, 저장소 안에서 처음 만든 무작위 소금과 섞은 해시로만 남긴다.
import { DurableObject } from "cloudflare:workers";

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};
const ID_RE = /^[0-9a-f]{12}$/;
const TOKEN_RE = /^[0-9a-f-]{36}$/;
const COOKIE = "lv";
const MAX_BODY = 256;
const RATE = { vote: 30, read: 120 }; // 1분에
const PER_IP_PER_EP = 3;

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...extra } });
}

function hex(bytes) {
  return [...bytes].map((x) => x.toString(16).padStart(2, "0")).join("");
}

// IPv6 는 /64 앞부분만(주소 끝만 바꿔 여러 번 누르지 못하게), IPv4 는 그대로.
function ipKey(ip) {
  if (!ip || !ip.includes(":")) return ip || "unknown";
  const [a, b = ""] = ip.split("::");
  const head = a ? a.split(":") : [];
  const tail = b ? b.split(":") : [];
  const fill = Array(Math.max(0, 8 - head.length - tail.length)).fill("0");
  const full = [...head, ...fill, ...tail];
  return `${full
    .slice(0, 4)
    .map((x) => (parseInt(x || "0", 16) || 0).toString(16))
    .join(":")}::/64`;
}

function readCookie(request, name) {
  const raw = request.headers.get("cookie") || "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return "";
}

async function readSmallBody(request) {
  const len = Number(request.headers.get("content-length") || 0);
  if (len > MAX_BODY) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) {
    all.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

let idsCache = null;
async function knownIds(env, url) {
  if (idsCache) return idsCache;
  const res = await env.ASSETS.fetch(new Request(new URL("/data/ids.json", url)));
  if (!res.ok) throw new Error(`ids.json ${res.status}`);
  idsCache = new Set(await res.json());
  return idsCache;
}

export class VotesDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    // voter 로 찾는 일이 많아 기본 키를 (voter, ep) 로 둔다.
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS votes (voter TEXT NOT NULL, ep TEXT NOT NULL, ipk TEXT NOT NULL, PRIMARY KEY (voter, ep))",
    );
    this.sql.exec("CREATE TABLE IF NOT EXISTS counts (ep TEXT PRIMARY KEY, n INTEGER NOT NULL)");
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS ipvotes (ep TEXT NOT NULL, ipk TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (ep, ipk))",
    );
    this.sql.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
    this.recent = new Map();
    this.saltValue = null;
    this.counts = null; // 메모리에 들고 있는 추천 수(처음 한 번만 읽음)
  }

  salt() {
    if (this.saltValue) return this.saltValue;
    const rows = this.sql.exec("SELECT v FROM meta WHERE k = 'salt'").toArray();
    if (rows.length) {
      this.saltValue = rows[0].v;
    } else {
      this.saltValue = hex(crypto.getRandomValues(new Uint8Array(32)));
      this.sql.exec("INSERT INTO meta (k, v) VALUES ('salt', ?)", this.saltValue);
    }
    return this.saltValue;
  }

  async hash(kind, value) {
    const data = new TextEncoder().encode(`${this.salt()}|${kind}|${value}`);
    const digest = await crypto.subtle.digest("SHA-256", data);
    return hex(new Uint8Array(digest).slice(0, 16));
  }

  loadCounts() {
    if (this.counts) return this.counts;
    this.counts = new Map();
    for (const row of this.sql.exec("SELECT ep, n FROM counts WHERE n > 0")) this.counts.set(row.ep, row.n);
    return this.counts;
  }

  limited(key, perMin) {
    const now = Date.now();
    const recent = (this.recent.get(key) || []).filter((t) => now - t < 60_000);
    const over = recent.length >= perMin;
    if (!over) recent.push(now);
    this.recent.delete(key);
    this.recent.set(key, recent);
    if (this.recent.size > 5000) {
      // 1분 넘게 지난 기록만 지우고, 그래도 많으면 오래된 것부터 절반
      for (const [k, ts] of this.recent) if (!ts.length || now - ts[ts.length - 1] >= 60_000) this.recent.delete(k);
      if (this.recent.size > 5000) {
        let drop = Math.floor(this.recent.size / 2);
        for (const k of this.recent.keys()) {
          if (drop-- <= 0) break;
          this.recent.delete(k);
        }
      }
    }
    return over;
  }

  async voter(token, ip) {
    return token ? `c${await this.hash("cookie", token)}` : `i${await this.hash("ip", ip)}`;
  }

  async summary(token, ip) {
    const ipk = await this.hash("ip", ip);
    if (this.limited(`r:${ipk}`, RATE.read)) return { error: "rate", status: 429 };
    const voter = await this.voter(token, ip);
    const counts = Object.fromEntries(this.loadCounts());
    const mine = this.sql
      .exec("SELECT ep FROM votes WHERE voter = ?", voter)
      .toArray()
      .map((row) => row.ep);
    return { counts, mine };
  }

  async vote(token, ip, ep, on) {
    const ipk = await this.hash("ip", ip);
    if (this.limited(`v:${ipk}`, RATE.vote)) return { error: "rate", status: 429 };
    const voter = await this.voter(token, ip);
    const counts = this.loadCounts();
    // 아래는 await 없이 이어서 실행된다 — 확인과 쓰기 사이에 다른 요청이 끼지 않는다.
    const had = this.sql.exec("SELECT ipk FROM votes WHERE voter = ? AND ep = ?", voter, ep).toArray();
    if (on && !had.length) {
      const used = this.sql.exec("SELECT n FROM ipvotes WHERE ep = ? AND ipk = ?", ep, ipk).toArray();
      if (used.length && used[0].n >= PER_IP_PER_EP) return { error: "ip-limit", status: 429 };
      this.sql.exec("INSERT INTO votes (voter, ep, ipk) VALUES (?, ?, ?)", voter, ep, ipk);
      this.sql.exec(
        "INSERT INTO ipvotes (ep, ipk, n) VALUES (?, ?, 1) ON CONFLICT(ep, ipk) DO UPDATE SET n = n + 1",
        ep,
        ipk,
      );
      this.sql.exec("INSERT INTO counts (ep, n) VALUES (?, 1) ON CONFLICT(ep) DO UPDATE SET n = n + 1", ep);
      counts.set(ep, (counts.get(ep) || 0) + 1);
    } else if (!on && had.length) {
      this.sql.exec("DELETE FROM votes WHERE voter = ? AND ep = ?", voter, ep);
      this.sql.exec("UPDATE ipvotes SET n = MAX(n - 1, 0) WHERE ep = ? AND ipk = ?", ep, had[0].ipk);
      this.sql.exec("UPDATE counts SET n = MAX(n - 1, 0) WHERE ep = ?", ep);
      const n = Math.max((counts.get(ep) || 0) - 1, 0);
      if (n) counts.set(ep, n);
      else counts.delete(ep);
    }
    return { n: counts.get(ep) || 0, mine: on };
  }
}

// 이 저장소가 예전에 쓰던 Durable Object 클래스. 저장돼 있던 데이터를 지우지 않으려고 이름만 남겨 둔다(쓰지 않음).
export class SiteDO extends DurableObject {
  async fetch() {
    return new Response("gone", { status: 410 });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);

    const origin = request.headers.get("origin");
    if (origin && origin !== url.origin) return json({ error: "origin" }, 403);
    const ip = ipKey(request.headers.get("cf-connecting-ip") || "unknown");
    let token = readCookie(request, COOKIE);
    if (!TOKEN_RE.test(token)) token = "";
    const stub = env.VOTES.get(env.VOTES.idFromName("main"));

    try {
      if (url.pathname === "/api/votes" && request.method === "GET") {
        let setCookie = {};
        if (!token) {
          token = crypto.randomUUID();
          setCookie = {
            "set-cookie": `${COOKIE}=${token}; Path=/api; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax`,
          };
        }
        const result = await stub.summary(token, ip);
        if (result.error) return json({ error: result.error }, result.status || 400, setCookie);
        return json(result, 200, setCookie);
      }
      if (url.pathname === "/api/vote" && request.method === "POST") {
        if (!(request.headers.get("content-type") || "").includes("application/json")) {
          return json({ error: "json only" }, 415);
        }
        const raw = await readSmallBody(request);
        if (raw === null) return json({ error: "too large" }, 413);
        let body;
        try {
          body = JSON.parse(raw);
        } catch {
          return json({ error: "bad json" }, 400);
        }
        const id = typeof body?.id === "string" ? body.id : "";
        if (!ID_RE.test(id)) return json({ error: "bad id" }, 400);
        if (!(await knownIds(env, url)).has(id)) return json({ error: "unknown id" }, 404);
        const result = await stub.vote(token, ip, id, body.on !== false);
        if (result.error) return json({ error: result.error }, result.status || 400);
        return json(result);
      }
      return json({ error: "not found" }, 404);
    } catch (err) {
      console.error("api", url.pathname, err?.message || String(err));
      return json({ error: "server" }, 500);
    }
  },
};
