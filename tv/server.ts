import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

const DB_PATH = process.env.TV_DB_PATH || "/app/data/tv.db";
const PORT = parseInt(process.env.PORT || "8000", 10);
const PUBLIC_DIR = `${import.meta.dir}/public`;
// Public base URL used in the M3U url-tvg attribute. The reverse proxy
// (Caddy) is what actually serves /epg.xml.gz to consumers; this just
// needs to resolve from wherever a TV reads the M3U from.
const PUBLIC_BASE = process.env.PUBLIC_BASE || (process.env.DOMAIN ? `https://tv.${process.env.DOMAIN}` : "");

mkdirSync(dirname(DB_PATH), { recursive: true });

// EXTVLCOPT user-agent options. `none` means: emit no EXTVLCOPT line at all
// (the channel's stream serves any client). `blank` emits the header with an
// empty value (some upstreams use that as a signal to skip UA-sniffing).
const USER_AGENTS: Record<string, string | null> = {
  chrome: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  appletv: "otg/1.5.1 (AppleTv Apple TV 4; tvOS16.0; appletv.client) libcurl/7.58.0 OpenSSL/1.0.2o zlib/1.2.11 clib/1.8.56",
  blank: "",
  none: null,
};
const VALID_UA_KEYS = new Set(Object.keys(USER_AGENTS));

const db = new Database(DB_PATH, { create: true });
// Single-writer single-reader app. DELETE mode (the SQLite default) keeps
// every write inside the single tv.db file — no -wal / -shm sidecars. This
// matters because we commit tv.db to git as a soft backup; otherwise a
// significant chunk of state would live in the unwritten WAL.
db.exec("PRAGMA journal_mode = DELETE");
db.exec("PRAGMA synchronous = NORMAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id TEXT,
    tvg_id TEXT,
    tvg_logo TEXT,
    group_title TEXT,
    display_name TEXT NOT NULL,
    original_name TEXT,
    stream_url TEXT NOT NULL UNIQUE,
    user_agent TEXT NOT NULL DEFAULT 'chrome',
    enabled INTEGER NOT NULL DEFAULT 1,
    position INTEGER NOT NULL DEFAULT 0,
    source_url TEXT,
    imported_at INTEGER
  );
`);
db.exec("CREATE INDEX IF NOT EXISTS idx_channels_position ON channels(position)");

type Channel = {
  id: number;
  channel_id: string | null;
  tvg_id: string | null;
  tvg_logo: string | null;
  group_title: string | null;
  display_name: string;
  original_name: string | null;
  stream_url: string;
  user_agent: string;
  enabled: number;
  position: number;
  source_url: string | null;
  imported_at: number | null;
};

type ParsedChannel = {
  channel_id?: string;
  tvg_id?: string;
  tvg_logo?: string;
  group_title?: string;
  display_name: string;
  original_name: string;
  stream_url: string;
  user_agent: string;
};

// ──────────────────────────────────────────────────────────────
// M3U parsing / rendering
// ──────────────────────────────────────────────────────────────

// Find the separator comma in an EXTINF body: everything up to that comma is
// attributes, everything after is the display name. The comma we want is the
// first one *after* the last quoted attribute, because names can contain
// commas of their own.
function findNameSeparator(s: string): number {
  let endOfAttrs = 0;
  for (const m of s.matchAll(/[\w-]+="[^"]*"/g)) {
    endOfAttrs = (m.index ?? 0) + m[0].length;
  }
  return s.indexOf(",", endOfAttrs);
}

function inferUserAgentKey(ua: string): string {
  if (ua === "") return "blank";
  if (ua === USER_AGENTS.chrome) return "chrome";
  if (ua === USER_AGENTS.appletv) return "appletv";
  // Unknown UA from the upstream playlist — record as `chrome` so the rendered
  // output stays consistent. The user can flip it in the UI.
  return "chrome";
}

function parseM3U(text: string): ParsedChannel[] {
  const lines = text.split(/\r?\n/);
  const out: ParsedChannel[] = [];
  let cur: Partial<ParsedChannel> | null = null;
  // If we see EXTINF but no EXTVLCOPT before the URL, default to `chrome`
  // (matches the current vercel playlist convention).
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#EXTINF:")) {
      cur = { user_agent: "chrome" };
      const body = line.slice("#EXTINF:".length);
      const commaIdx = findNameSeparator(body);
      const meta = commaIdx >= 0 ? body.slice(0, commaIdx) : body;
      const name = (commaIdx >= 0 ? body.slice(commaIdx + 1) : "").trim();
      cur.display_name = name;
      cur.original_name = name;
      for (const m of meta.matchAll(/([\w-]+)="([^"]*)"/g)) {
        const k = m[1].toLowerCase();
        const v = m[2];
        if (k === "channel-id") cur.channel_id = v;
        else if (k === "tvg-id") cur.tvg_id = v;
        else if (k === "tvg-logo") cur.tvg_logo = v;
        else if (k === "group-title") cur.group_title = v;
      }
    } else if (line.startsWith("#EXTVLCOPT:") && cur) {
      const m = line.match(/http-user-agent\s*=\s*(.*)$/i);
      if (m) cur.user_agent = inferUserAgentKey(m[1].trim());
    } else if (line.startsWith("#")) {
      // ignore other directives (#EXTM3U, #EXTGRP, etc.)
    } else if (cur && cur.display_name !== undefined) {
      cur.stream_url = line;
      out.push(cur as ParsedChannel);
      cur = null;
    }
  }
  return out;
}

// XMLTV EPG sources advertised in the M3U header. TViRL, TiviMate, IPTV
// Smarters, etc. all read `url-tvg` and merge the listed XMLTVs by tvg-id.
// Programme data only appears for a channel if its M3U tvg-id matches an
// `<channel id="…">` in one of these XMLTVs.
//
//   i.mjh.nz  → covers our NZ block (the original source)
//   epgshare01.online → community aggregator with FR/DE/HK/JP/KR/TR coverage
//
// No public EPG exists for our China, Taiwan, or Russia picks — those will
// appear in the channel list without programme guides.
const EPG_URLS = [
  "https://i.mjh.nz/nz/epg.xml.gz",
  "https://i.mjh.nz/au/all/epg.xml.gz",
  "https://epgshare01.online/epgshare01/epg_ripper_FR1.xml.gz",
  "https://epgshare01.online/epgshare01/epg_ripper_DE1.xml.gz",
  "https://epgshare01.online/epgshare01/epg_ripper_HK1.xml.gz",
  "https://epgshare01.online/epgshare01/epg_ripper_JP1.xml.gz",
  "https://epgshare01.online/epgshare01/epg_ripper_KR1.xml.gz",
  "https://epgshare01.online/epgshare01/epg_ripper_TR1.xml.gz",
  // Added in a second pass to cover the channels left blank after the
  // first matching round (US news + entertainment, APNA Television, etc.).
  // No public EPG exists for our TW / CN-mainland / RU picks.
  "https://epgshare01.online/epgshare01/epg_ripper_US2.xml.gz",
  "https://epgshare01.online/epgshare01/epg_ripper_IN1.xml.gz",
  "https://epgshare01.online/epgshare01/epg_ripper_NZ1.xml.gz",
];

function renderM3U(channels: Channel[]): string {
  // url-tvg points at our merged EPG endpoint, not the raw sources. That
  // way changing/adding EPG_URLS just requires a server edit — every
  // consumer keeps the same URL.
  const lines: string[] = [`#EXTM3U url-tvg="${PUBLIC_BASE}/epg.xml.gz"`];
  let chno = 1;
  for (const c of channels) {
    if (!c.enabled) continue;
    const attrs: string[] = [];
    if (c.channel_id) attrs.push(`channel-id="${c.channel_id}"`);
    if (c.tvg_id) attrs.push(`tvg-id="${c.tvg_id}"`);
    if (c.tvg_logo) attrs.push(`tvg-logo="${c.tvg_logo}"`);
    attrs.push(`tvg-chno="${chno}"`);
    if (c.group_title) attrs.push(`group-title="${c.group_title}"`);
    lines.push("");
    lines.push(`#EXTINF:-1 ${attrs.join(" ")} , ${c.display_name}`);
    const uaVal = USER_AGENTS[c.user_agent];
    if (uaVal !== null) lines.push(`#EXTVLCOPT:http-user-agent=${uaVal}`);
    lines.push(c.stream_url);
    chno++;
  }
  return lines.join("\n") + "\n";
}

// ──────────────────────────────────────────────────────────────
// Prepared statements
// ──────────────────────────────────────────────────────────────

const stmts = {
  all: db.query<Channel, []>(
    "SELECT * FROM channels ORDER BY position ASC, id ASC"
  ),
  enabled: db.query<Channel, []>(
    "SELECT * FROM channels WHERE enabled = 1 ORDER BY position ASC, id ASC"
  ),
  byId: db.query<Channel, [number]>("SELECT * FROM channels WHERE id = ?"),
  byStream: db.query<Channel, [string]>(
    "SELECT * FROM channels WHERE stream_url = ?"
  ),
  maxPos: db.query<{ p: number | null }, []>(
    "SELECT MAX(position) AS p FROM channels"
  ),
  insert: db.prepare(`
    INSERT OR IGNORE INTO channels
      (channel_id, tvg_id, tvg_logo, group_title, display_name, original_name,
       stream_url, user_agent, enabled, position, source_url, imported_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
  `),
  insertOne: db.prepare(`
    INSERT INTO channels
      (channel_id, tvg_id, tvg_logo, group_title, display_name, original_name,
       stream_url, user_agent, enabled, position, source_url, imported_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  setPosition: db.prepare("UPDATE channels SET position = ? WHERE id = ?"),
  setEnabled: db.prepare("UPDATE channels SET enabled = ? WHERE id = ?"),
  setUserAgent: db.prepare("UPDATE channels SET user_agent = ? WHERE id = ?"),
  deleteById: db.prepare("DELETE FROM channels WHERE id = ?"),
  updateFields: db.prepare(`
    UPDATE channels
       SET display_name = COALESCE(?, display_name),
           group_title  = COALESCE(?, group_title),
           tvg_logo     = COALESCE(?, tvg_logo),
           user_agent   = COALESCE(?, user_agent),
           enabled      = COALESCE(?, enabled),
           stream_url   = COALESCE(?, stream_url),
           tvg_id       = COALESCE(?, tvg_id),
           channel_id   = COALESCE(?, channel_id)
     WHERE id = ?
  `),
};

const importChannels = db.transaction((parsed: ParsedChannel[], sourceUrl: string) => {
  const now = Date.now();
  let nextPos = (stmts.maxPos.get()?.p ?? 0) + 1;
  let added = 0;
  let skipped = 0;
  for (const p of parsed) {
    const ua = VALID_UA_KEYS.has(p.user_agent) ? p.user_agent : "chrome";
    const res = stmts.insert.run(
      p.channel_id ?? null,
      p.tvg_id ?? null,
      p.tvg_logo ?? null,
      p.group_title ?? null,
      p.display_name,
      p.original_name,
      p.stream_url,
      ua,
      nextPos,
      sourceUrl,
      now
    );
    if (res.changes > 0) {
      added++;
      nextPos++;
    } else {
      skipped++;
    }
  }
  return { added, skipped };
});

const applyReorder = db.transaction((order: number[]) => {
  for (let i = 0; i < order.length; i++) {
    stmts.setPosition.run(i + 1, order[i]);
  }
});

const applyBulk = db.transaction(
  (ids: number[], action: string, value: string | null) => {
    let count = 0;
    for (const id of ids) {
      if (action === "enable") count += stmts.setEnabled.run(1, id).changes;
      else if (action === "disable") count += stmts.setEnabled.run(0, id).changes;
      else if (action === "delete") count += stmts.deleteById.run(id).changes;
      else if (action === "set_user_agent" && value && VALID_UA_KEYS.has(value)) {
        count += stmts.setUserAgent.run(value, id).changes;
      }
    }
    return count;
  }
);

// ──────────────────────────────────────────────────────────────
// HTTP helpers
// ──────────────────────────────────────────────────────────────

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function text(s: string, status = 200, contentType = "text/plain; charset=utf-8"): Response {
  return new Response(s, { status, headers: { "Content-Type": contentType } });
}

// Static file server scoped to PUBLIC_DIR; rejects traversal.
async function serveStatic(pathname: string): Promise<Response | null> {
  const rel = pathname === "/" ? "/index.html" : pathname;
  const resolved = normalize(join(PUBLIC_DIR, rel));
  if (!resolved.startsWith(PUBLIC_DIR)) return null;
  const file = Bun.file(resolved);
  if (!(await file.exists())) return null;
  return new Response(file);
}

async function readJson(req: Request): Promise<any> {
  try { return await req.json(); } catch { return null; }
}

// ──────────────────────────────────────────────────────────────
// Routes
// ──────────────────────────────────────────────────────────────

Bun.serve({
  port: PORT,
  // Allow time for upstream playlist fetches (Vercel cold start, large files).
  idleTimeout: 60,
  async fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname;
    // Treat HEAD like GET — Bun's fetch handler ships the body either way and
    // the runtime drops it for HEAD, so we get correct status/headers without
    // a separate branch.
    const method = req.method === "HEAD" ? "GET" : req.method;

    // Public: the playlist itself. IPTV clients can't carry cookies, so this
    // endpoint is always reachable. The container has no host port — Caddy
    // gates inbound access to LAN range anyway.
    if (p === "/playlist.m3u" && method === "GET") {
      const channels = stmts.enabled.all();
      return text(renderM3U(channels), 200, "application/vnd.apple.mpegurl; charset=utf-8");
    }

    // Plain-text view of the same rendered playlist. Same bytes, but served
    // as text/plain so a browser renders inline instead of handing off to a
    // media player or downloading.
    if (p === "/playlist.txt" && method === "GET") {
      const channels = stmts.enabled.all();
      return text(renderM3U(channels), 200, "text/plain; charset=utf-8");
    }

    // API: list everything (including disabled)
    if (p === "/api/channels" && method === "GET") {
      return json({ channels: stmts.all.all(), user_agents: Object.keys(USER_AGENTS) });
    }

    // API: create one channel from primitives. The bulk path is /api/import
    // (M3U URL or pasted text). This route is the cleaner shape when an
    // operator (or Claude Code) wants to drop in a single channel.
    if (p === "/api/channels" && method === "POST") {
      const body = await readJson(req);
      if (!body) return json({ error: "invalid json" }, 400);
      if (typeof body.display_name !== "string" || !body.display_name.trim())
        return json({ error: "display_name required" }, 400);
      if (typeof body.stream_url !== "string" || !body.stream_url.trim())
        return json({ error: "stream_url required" }, 400);
      const ua = body.user_agent ?? "chrome";
      if (!VALID_UA_KEYS.has(ua))
        return json({ error: `user_agent must be one of ${[...VALID_UA_KEYS].join(", ")}` }, 400);
      const enabled = body.enabled === false ? 0 : 1;
      const position = Number.isFinite(body.position)
        ? Number(body.position)
        : (stmts.maxPos.get()?.p ?? 0) + 1;
      const now = Date.now();
      try {
        const res = stmts.insertOne.run(
          body.channel_id ?? null,
          body.tvg_id ?? null,
          body.tvg_logo ?? null,
          body.group_title ?? null,
          body.display_name.trim(),
          body.display_name.trim(),
          body.stream_url.trim(),
          ua,
          enabled,
          position,
          body.source_url ?? "manual",
          now
        );
        const row = stmts.byId.get(Number(res.lastInsertRowid));
        return json(row, 201);
      } catch (e: any) {
        if (String(e?.message || "").includes("UNIQUE")) {
          const existing = stmts.byStream.get(body.stream_url.trim());
          return json({ error: "stream_url already exists", existing }, 409);
        }
        return json({ error: `insert failed: ${e?.message || e}` }, 500);
      }
    }

    // API: update one channel (partial)
    const idMatch = p.match(/^\/api\/channels\/(\d+)$/);
    if (idMatch) {
      const id = parseInt(idMatch[1], 10);
      if (method === "PATCH") {
        const body = await readJson(req);
        if (!body) return json({ error: "invalid json" }, 400);
        const ua = body.user_agent;
        if (ua !== undefined && !VALID_UA_KEYS.has(ua))
          return json({ error: "invalid user_agent" }, 400);
        const enabled =
          body.enabled === undefined ? null : body.enabled ? 1 : 0;
        stmts.updateFields.run(
          body.display_name ?? null,
          body.group_title ?? null,
          body.tvg_logo ?? null,
          ua ?? null,
          enabled,
          body.stream_url ?? null,
          body.tvg_id ?? null,
          body.channel_id ?? null,
          id
        );
        const row = stmts.byId.get(id);
        if (!row) return json({ error: "not found" }, 404);
        return json(row);
      }
      if (method === "DELETE") {
        const res = stmts.deleteById.run(id);
        return json({ deleted: res.changes });
      }
    }

    // API: reorder. Body { order: [id, id, ...] } — rewrites positions 1..N.
    if (p === "/api/channels/reorder" && method === "POST") {
      const body = await readJson(req);
      if (!body || !Array.isArray(body.order))
        return json({ error: "order must be an array of ids" }, 400);
      applyReorder(body.order.map((x: any) => Number(x)).filter(Number.isFinite));
      return json({ ok: true });
    }

    // API: bulk action. Body { ids: [...], action: 'enable'|'disable'|'delete'|'set_user_agent', value?: 'chrome'|... }
    if (p === "/api/channels/bulk" && method === "POST") {
      const body = await readJson(req);
      if (!body || !Array.isArray(body.ids) || typeof body.action !== "string")
        return json({ error: "ids[] and action required" }, 400);
      const ids = body.ids.map((x: any) => Number(x)).filter(Number.isFinite);
      const count = applyBulk(ids, body.action, body.value ?? null);
      return json({ changed: count });
    }

    // API: import. Body { url } or { m3u: "..." }.
    if (p === "/api/import" && method === "POST") {
      const body = await readJson(req);
      if (!body) return json({ error: "invalid json" }, 400);
      let m3u: string;
      let source = "";
      try {
        if (typeof body.url === "string" && body.url) {
          source = body.url;
          const res = await fetch(body.url);
          if (!res.ok)
            return json({ error: `fetch failed: ${res.status}` }, 502);
          m3u = await res.text();
        } else if (typeof body.m3u === "string") {
          source = body.source || "pasted";
          m3u = body.m3u;
        } else {
          return json({ error: "provide url or m3u" }, 400);
        }
      } catch (e: any) {
        return json({ error: `fetch error: ${e?.message || e}` }, 502);
      }
      const parsed = parseM3U(m3u);
      const { added, skipped } = importChannels(parsed, source);
      return json({ parsed: parsed.length, added, skipped });
    }

    // Merged EPG: a single XMLTV file built from EPG_URLS. The first request
    // after the cache expires takes several seconds (parallel fetches of
    // ~15MB of gzipped XML); subsequent requests are instant. TViRL stores
    // one EPG URL per channel source and ignores M3U-side url-tvg updates,
    // so pointing TViRL at this endpoint once gives it access to every EPG
    // source we add later without re-touching TViRL settings.
    if ((p === "/epg.xml.gz" || p === "/epg.xml") && method === "GET") {
      const now = Date.now();
      if (!epgCache || epgCache.expiresAt < now) {
        try {
          epgCache = {
            gz: await buildMergedEpg(),
            expiresAt: now + EPG_CACHE_TTL_MS,
          };
        } catch (e: any) {
          return text(`epg build failed: ${e?.message || e}`, 502);
        }
      }
      if (p === "/epg.xml.gz") {
        return new Response(epgCache.gz, {
          headers: { "Content-Type": "application/gzip" },
        });
      }
      // Uncompressed variant for clients that don't transparently gunzip.
      const xml = gunzipSync(epgCache.gz);
      return new Response(xml, {
        headers: { "Content-Type": "application/xml; charset=utf-8" },
      });
    }

    // Test player: hls.js page that plays a stream URL given in ?url=.
    if (p === "/play" && method === "GET") {
      const streamUrl = url.searchParams.get("url") || "";
      const name = url.searchParams.get("name") || "Stream test";
      return text(playerHtml(streamUrl, name), 200, "text/html; charset=utf-8");
    }

    if (method === "GET") {
      const s = await serveStatic(p);
      if (s) return s;
    }

    return text("not found", 404);
  },
});

// ──────────────────────────────────────────────────────────────
// Inline /play page (hls.js from jsDelivr)
// ──────────────────────────────────────────────────────────────

function playerHtml(streamUrl: string, name: string): string {
  // Escape for embedding in HTML attribute / text. Keep cheap and explicit.
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(name)} — test</title>
<style>
  html,body { background:#000; margin:0; height:100%; color:#ddd; font-family: system-ui, sans-serif; }
  header { padding:10px 14px; background:#111; border-bottom:1px solid #222; display:flex; gap:1rem; align-items:center; }
  header b { color:#fff; font-weight:600; }
  header .url { color:#888; font-size:.85rem; word-break:break-all; }
  video { width:100%; height:calc(100% - 50px); background:#000; }
  .err { padding:1rem; color:#f77; }
</style>
</head>
<body>
<header><b>${esc(name)}</b><span class="url">${esc(streamUrl)}</span></header>
<video id="v" controls autoplay playsinline muted></video>
<div id="err" class="err" hidden></div>
<script src="https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js"></script>
<script>
  const url = ${JSON.stringify(streamUrl)};
  const v = document.getElementById('v');
  const err = document.getElementById('err');
  function fail(msg) { err.textContent = msg; err.hidden = false; }
  if (!url) { fail('No url= query parameter'); }
  else if (window.Hls && window.Hls.isSupported()) {
    const hls = new Hls({ enableWorker: true });
    hls.loadSource(url);
    hls.attachMedia(v);
    hls.on(Hls.Events.ERROR, (_e, d) => { if (d.fatal) fail('hls error: ' + d.type + ' / ' + d.details); });
  } else if (v.canPlayType('application/vnd.apple.mpegurl')) {
    v.src = url;
  } else {
    fail('Browser cannot play HLS');
  }
  // Note: browsers cannot send custom User-Agent headers on media requests.
  // If the upstream gates on UA, this page will fail even if a real IPTV
  // client (VLC, AppleTV) can play the same URL fine.
</script>
</body>
</html>`;
}

// ──────────────────────────────────────────────────────────────
// EPG merge — fetch every EPG_URLS source, concatenate the XMLTV bodies
// inside one <tv> wrapper, gzip, cache. No XML parsing: XMLTV files are
// flat (channel + programme siblings under <tv>), so a regex-bounded
// slice between the opening <tv …> and closing </tv> is enough.
// ──────────────────────────────────────────────────────────────

const EPG_CACHE_TTL_MS = 4 * 60 * 60 * 1000; // 4h — upstream regenerates daily
let epgCache: { gz: Buffer; expiresAt: number } | null = null;

async function fetchOneEpg(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const text = url.endsWith(".gz") ? gunzipSync(buf).toString("utf8") : buf.toString("utf8");
  const open = text.match(/<tv\b[^>]*>/);
  const closeIdx = text.lastIndexOf("</tv>");
  if (!open || closeIdx < 0) throw new Error(`malformed XMLTV from ${url}`);
  return text.slice((open.index ?? 0) + open[0].length, closeIdx);
}

async function buildMergedEpg(): Promise<Buffer> {
  const results = await Promise.allSettled(EPG_URLS.map(fetchOneEpg));
  const bodies: string[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === "fulfilled") bodies.push(r.value);
    else console.error(`[epg] skip ${EPG_URLS[i]}: ${r.reason}`);
  }
  if (!bodies.length) throw new Error("all EPG sources failed");
  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<tv generator-info-name="tv-merge" generator-info-url="https://tv.${process.env.DOMAIN || "local"}/epg.xml.gz">\n` +
    bodies.join("\n") +
    `\n</tv>\n`;
  return gzipSync(Buffer.from(xml, "utf8"));
}

console.log(`tv listening on :${PORT}  db=${DB_PATH}`);
