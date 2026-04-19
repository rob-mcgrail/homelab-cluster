import { readdir, readFile } from "node:fs/promises";
import { loadavg, totalmem, freemem, cpus } from "node:os";
import { statfsSync } from "node:fs";

const DATA_DIR = "/movie-bot-data";
const PENDING_DIR = `${DATA_DIR}/pending`;
const COMPLETED_REQUESTS_DIR = `${DATA_DIR}/completed-requests`;
const COMPLETED_TRIAGE_DIR = `${DATA_DIR}/completed-triage-runs`;
const COMPLETED_RECS_DIR = `${DATA_DIR}/completed-recs-runs`;
const RECS_FILE = `${DATA_DIR}/recommendations.jsonl`;
const THOUGHTS_FILE = `${DATA_DIR}/movie-thoughts.jsonl`;
const QB_URL = "http://qbittorrent:8080";
const JELLYFIN_URL = "http://jellyfin:8096";
const PIHOLE_URL = "http://host.docker.internal:7001";
const JELLYFIN_API_KEY = process.env.JELLYFIN_API_KEY || "";
const PIHOLE_PASSWORD = process.env.FTLCONF_webserver_api_password || "";

let piholeSID: string | null = null;

async function readJsonl(path: string): Promise<any[]> {
  const file = Bun.file(path);
  if (!(await file.exists())) return [];
  const text = await file.text();
  return text.split("\n").filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

async function appendJsonl(path: string, obj: any) {
  const line = JSON.stringify(obj) + "\n";
  const file = Bun.file(path);
  const existing = (await file.exists()) ? await file.text() : "";
  await Bun.write(path, existing + line);
}

let jellyfinMeta: { userId: string; filmsLibId: string } | null = null;
async function getJellyfinMeta() {
  if (jellyfinMeta) return jellyfinMeta;
  const users: any = await (
    await fetch(`${JELLYFIN_URL}/Users`, { headers: { "X-MediaBrowser-Token": JELLYFIN_API_KEY } })
  ).json();
  const userId = users?.[0]?.Id;
  if (!userId) throw new Error("jellyfin: no user");
  const views: any = await (
    await fetch(`${JELLYFIN_URL}/Users/${userId}/Views`, { headers: { "X-MediaBrowser-Token": JELLYFIN_API_KEY } })
  ).json();
  const filmsLibId = views?.Items?.find((v: any) => v.Name === "Films")?.Id;
  if (!filmsLibId) throw new Error("jellyfin: 'Films' library not found");
  jellyfinMeta = { userId, filmsLibId };
  return jellyfinMeta;
}

async function piholeAuth() {
  const res = await fetch(`${PIHOLE_URL}/api/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: PIHOLE_PASSWORD }),
  });
  if (!res.ok) throw new Error(`pihole auth failed: ${res.status}`);
  const data: any = await res.json();
  piholeSID = data?.session?.sid || null;
  if (!piholeSID) throw new Error("pihole auth returned no session id");
}

async function piholeGet(path: string): Promise<any> {
  if (!piholeSID) await piholeAuth();
  const doFetch = () =>
    fetch(`${PIHOLE_URL}${path}`, { headers: { "X-FTL-SID": piholeSID as string } });
  let res = await doFetch();
  if (res.status === 401) {
    await piholeAuth();
    res = await doFetch();
  }
  if (!res.ok) throw new Error(`pihole GET ${path} failed: ${res.status}`);
  return res.json();
}

function ticksToMs(t: number): number {
  return Math.max(0, Math.floor(t / 10000));
}

function formatTitle(item: any): string {
  if (!item) return "";
  if (item.Type === "Episode") {
    const s = item.ParentIndexNumber != null ? `S${String(item.ParentIndexNumber).padStart(2, "0")}` : "";
    const e = item.IndexNumber != null ? `E${String(item.IndexNumber).padStart(2, "0")}` : "";
    const se = [s, e].filter(Boolean).join("");
    const parts = [item.SeriesName, se, item.Name].filter(Boolean);
    return parts.join(" · ");
  }
  if (item.ProductionYear) return `${item.Name} (${item.ProductionYear})`;
  return item.Name || "";
}

function cleanTitle(name: string): string {
  // strip file extension
  let t = name.replace(/\.\w{2,4}$/, "");
  // replace dots/underscores with spaces
  t = t.replace(/[._]/g, " ");
  // cut at first quality/codec/group marker (require leading space to avoid mid-word matches)
  t = t.replace(/\s+(1080p|2160p|4K|720p|BluRay|BRRip|WEBRip|WEB-DL|WEBDL|HDRip|DVDRip|x264|x265|HEVC|H 264|H 265|AAC|DTS|YIFY|YTS|RARBG|NTb|SPARKS|FGT|EVO|AMZN|HDTV).*/i, "");
  t = t.replace(/\s*\[.*/, "");
  // pull out year in parens or standalone and keep it
  const yearMatch = t.match(/^(.+?)\s*\(?((?:19|20)\d{2})\)?/);
  if (yearMatch) return `${yearMatch[1].trim()} (${yearMatch[2]})`;
  return t.trim();
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " KB";
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + " MB";
  return (bytes / 1073741824).toFixed(2) + " GB";
}

function categorise(state: string): string {
  if (state.includes("download") || state === "forcedDL") return "downloading";
  if (state.includes("UP") || state === "uploading" || state === "forcedUP" || state === "stalledUP") return "seeding";
  if (state === "queuedDL" || state === "queuedUP" || state === "checkingDL" || state === "checkingUP" || state === "metaDL" || state === "allocating") return "queued";
  if (state.includes("paused")) return "paused";
  if (state === "stalledDL") return "downloading";
  return "other";
}

function formatEta(seconds: number): string {
  if (seconds <= 0 || seconds >= 8640000) return "";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

const server = Bun.serve({
  port: 8000,
  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/api/history") {
      try {
        // pending prompts (not yet processed)
        const pendingFiles = (await readdir(PENDING_DIR))
          .filter((f) => f.endsWith(".txt"))
          .sort()
          .reverse();

        const pending = await Promise.all(
          pendingFiles.map(async (f) => {
            const base = f.replace(/\.txt$/, "");
            const prompt = await Bun.file(`${PENDING_DIR}/${f}`).text();
            return { id: base, prompt, result: null, pending: true };
          })
        );

        // completed prompts
        let done: any[] = [];
        try {
          const doneFiles = (await readdir(COMPLETED_REQUESTS_DIR))
            .filter((f) => f.endsWith(".txt"))
            .sort()
            .reverse();

          done = await Promise.all(
            doneFiles.map(async (f) => {
              const base = f.replace(/\.txt$/, "");
              const prompt = await Bun.file(`${COMPLETED_REQUESTS_DIR}/${f}`).text();
              const outFile = Bun.file(`${COMPLETED_REQUESTS_DIR}/${base}.out`);
              const result = (await outFile.exists())
                ? await outFile.text()
                : null;
              return { id: base, prompt, result, pending: false };
            })
          );
        } catch {}

        const all = [...pending, ...done].slice(0, 15);
        return Response.json(all);
      } catch {
        return Response.json([]);
      }
    }

    if (req.method === "GET" && url.pathname === "/api/triage-runs") {
      try {
        const files = (await readdir(COMPLETED_TRIAGE_DIR))
          .filter((f) => f.endsWith(".md"))
          .sort()
          .reverse()
          .slice(0, 15);
        const runs = await Promise.all(
          files.map(async (f) => ({
            id: f.replace(/\.md$/, ""),
            content: await Bun.file(`${COMPLETED_TRIAGE_DIR}/${f}`).text(),
          }))
        );
        return Response.json(runs);
      } catch {
        return Response.json([]);
      }
    }

    if (req.method === "GET" && url.pathname === "/api/torrents") {
      try {
        const res = await fetch(`${QB_URL}/api/v2/torrents/info?sort=added_on&reverse=true`);
        const torrents: any[] = await res.json();
        const mapped = torrents.map((t) => ({
          name: cleanTitle(t.name),
          sourceFile: t.content_path ? t.content_path.split("/").pop() : t.name,
          state: t.state,
          category: categorise(t.state),
          progress: Math.round(t.progress * 100),
          downloaded: formatBytes(t.downloaded),
          size: formatBytes(t.size),
          eta: formatEta(t.eta),
          dlspeed: formatBytes(t.dlspeed) + "/s",
          upspeed: formatBytes(t.upspeed) + "/s",
          addedOn: t.added_on,
        }));
        return Response.json(mapped);
      } catch {
        return Response.json([]);
      }
    }

    if (req.method === "GET" && url.pathname === "/api/status") {
      try {
        const load = loadavg();
        const cores = cpus().length;
        const totalMem = totalmem();

        // os.freemem() excludes cache — read MemAvailable from /proc/meminfo instead
        let availMem = freemem();
        try {
          const meminfo = await readFile("/proc/meminfo", "utf-8");
          const ma = meminfo.match(/MemAvailable:\s+(\d+)/);
          if (ma) availMem = +ma[1] * 1024;
        } catch {}
        const usedMem = totalMem - availMem;

        // swap from /proc/meminfo
        let swapTotal = 0, swapFree = 0;
        try {
          const meminfo = await readFile("/proc/meminfo", "utf-8");
          const st = meminfo.match(/SwapTotal:\s+(\d+)/);
          const sf = meminfo.match(/SwapFree:\s+(\d+)/);
          if (st) swapTotal = +st[1] * 1024;
          if (sf) swapFree = +sf[1] * 1024;
        } catch {}

        // disk from /hostdata mount (bigint avoids int32 overflow on >8.6TB pools)
        let diskTotal = 0, diskFree = 0;
        try {
          const s = statfsSync("/hostdata", { bigint: true });
          diskTotal = Number(s.blocks * s.bsize);
          diskFree = Number(s.bavail * s.bsize);
        } catch {}

        // qBit aggregate speeds / session totals
        let qbit: any = null;
        try {
          const tr = await fetch(`${QB_URL}/api/v2/transfer/info`);
          if (tr.ok) {
            const j: any = await tr.json();
            qbit = {
              dlSpeed: j.dl_info_speed || 0,
              upSpeed: j.up_info_speed || 0,
              dlSession: j.dl_info_data || 0,
              upSession: j.up_info_data || 0,
            };
          }
        } catch {}

        return Response.json({
          load: load.map((l) => l.toFixed(2)),
          cores,
          mem: { total: totalMem, used: usedMem, pct: Math.round((usedMem / totalMem) * 100) },
          swap: {
            total: swapTotal,
            used: swapTotal - swapFree,
            pct: swapTotal ? Math.round(((swapTotal - swapFree) / swapTotal) * 100) : 0,
          },
          disk: {
            total: diskTotal,
            used: diskTotal - diskFree,
            pct: diskTotal ? Math.round(((diskTotal - diskFree) / diskTotal) * 100) : 0,
          },
          qbit,
        });
      } catch {
        return Response.json({ error: true });
      }
    }

    if (req.method === "GET" && url.pathname === "/api/jellyfin-sessions") {
      try {
        const res = await fetch(`${JELLYFIN_URL}/Sessions`, {
          headers: { "X-MediaBrowser-Token": JELLYFIN_API_KEY },
        });
        if (!res.ok) throw new Error(`jellyfin ${res.status}`);
        const sessions: any[] = await res.json();
        const active = sessions
          .filter((s) => s.NowPlayingItem)
          .map((s) => {
            const item = s.NowPlayingItem;
            const ti = s.TranscodingInfo || null;
            const streams: any[] = item?.MediaStreams || [];
            const videoSrc = streams.find((x) => x.Type === "Video");
            const audioSrc = streams.find((x) => x.Type === "Audio" && x.Index === item.DefaultAudioStreamIndex) || streams.find((x) => x.Type === "Audio");
            const subStream = item.DefaultSubtitleStreamIndex != null
              ? streams.find((x) => x.Type === "Subtitle" && x.Index === item.DefaultSubtitleStreamIndex)
              : null;
            return {
              user: s.UserName || "—",
              client: s.Client || "",
              device: s.DeviceName || "",
              title: formatTitle(item),
              type: item.Type,
              positionMs: ticksToMs(s.PlayState?.PositionTicks || 0),
              durationMs: ticksToMs(item.RunTimeTicks || 0),
              isPaused: !!s.PlayState?.IsPaused,
              playMethod: s.PlayState?.PlayMethod || (ti ? "Transcode" : "DirectPlay"),
              source: {
                container: item.Container || "",
                videoCodec: videoSrc?.Codec || "",
                audioCodec: audioSrc?.Codec || "",
                resolution: videoSrc ? (videoSrc.Height ? `${videoSrc.Height}p` : "") : "",
                audioChannels: audioSrc?.Channels || null,
                file: item.Path ? item.Path.split("/").pop() : "",
              },
              output: ti ? {
                container: ti.Container || "",
                videoCodec: ti.VideoCodec || "",
                audioCodec: ti.AudioCodec || "",
                bitrate: ti.Bitrate || 0,
                isVideoDirect: !!ti.IsVideoDirect,
                isAudioDirect: !!ti.IsAudioDirect,
                reasons: ti.TranscodeReasons || [],
              } : null,
              subtitle: subStream ? {
                language: subStream.Language || subStream.DisplayTitle || "",
                codec: subStream.Codec || "",
                isExternal: !!subStream.IsExternal,
              } : null,
            };
          });
        return Response.json(active);
      } catch {
        return Response.json([]);
      }
    }

    if (req.method === "GET" && url.pathname === "/api/pihole-clients") {
      try {
        // last 24h window (FTL's default in-memory retention is also 24h,
        // but passing from= makes the scope explicit and future-proof)
        const from = Math.floor(Date.now() / 1000) - 86400;
        const [permitted, blocked, recent] = await Promise.all([
          piholeGet(`/api/stats/top_clients?blocked=false&count=30&from=${from}`),
          piholeGet(`/api/stats/top_clients?blocked=true&count=30&from=${from}`),
          piholeGet(`/api/queries?length=2000&from=${from}`),
        ]);
        const lastSeen = new Map<string, number>();
        for (const q of (recent?.queries || [])) {
          const ip = q?.client?.ip;
          const t = q?.time;
          if (!ip || !t) continue;
          const prev = lastSeen.get(ip) || 0;
          if (t > prev) lastSeen.set(ip, t);
        }
        const leases = new Map<string, number>();
        try {
          const content = await Bun.file("/pihole/dhcp.leases").text();
          for (const line of content.split("\n")) {
            const parts = line.trim().split(/\s+/);
            if (parts.length < 3) continue;
            const expiry = +parts[0];
            const ip = parts[2];
            if (ip && !isNaN(expiry)) leases.set(ip, expiry);
          }
        } catch {}
        const map = new Map<string, { name: string; ip: string; permitted: number; blocked: number }>();
        for (const c of (permitted?.clients || [])) {
          const key = c.ip || c.name;
          map.set(key, { name: c.name || c.ip, ip: c.ip || "", permitted: c.count || 0, blocked: 0 });
        }
        for (const c of (blocked?.clients || [])) {
          const key = c.ip || c.name;
          const cur = map.get(key) || { name: c.name || c.ip, ip: c.ip || "", permitted: 0, blocked: 0 };
          cur.blocked = c.count || 0;
          map.set(key, cur);
        }
        const rows = Array.from(map.values())
          .filter((r) => r.ip !== "127.0.0.1" && r.ip !== "::1" && r.ip !== "192.168.1.1" && r.name !== "localhost")
          .map((r) => ({
            ...r,
            total: r.permitted + r.blocked,
            blockedPct: r.permitted + r.blocked > 0 ? Math.round((r.blocked / (r.permitted + r.blocked)) * 100) : 0,
            lastSeen: lastSeen.get(r.ip) || null,
            leaseExpiry: leases.get(r.ip) || null,
          }))
          .sort((a, b) => b.total - a.total);
        return Response.json(rows);
      } catch {
        return Response.json([]);
      }
    }

    if (req.method === "GET" && url.pathname === "/api/recs-runs") {
      try {
        const files = (await readdir(COMPLETED_RECS_DIR))
          .filter((f) => f.endsWith(".md"))
          .sort()
          .reverse()
          .slice(0, 15);
        const runs = await Promise.all(
          files.map(async (f) => ({
            id: f.replace(/\.md$/, ""),
            content: await Bun.file(`${COMPLETED_RECS_DIR}/${f}`).text(),
          })),
        );
        return Response.json(runs);
      } catch {
        return Response.json([]);
      }
    }

    if (req.method === "GET" && url.pathname === "/api/recs") {
      try {
        const log = await readJsonl(RECS_FILE);
        const byId = new Map<string, any>();
        let latestRunId = "";
        for (const e of log) {
          if (e.type === "rec") {
            byId.set(e.id, { ...e, status: "pending", sent: false });
            if (e.runId && e.runId > latestRunId) latestRunId = e.runId;
          } else if (e.type === "status") {
            const r = byId.get(e.recId);
            if (r) {
              r.status = e.status;
              r.statusAt = e.at;
              r.statusNotes = e.notes || "";
            }
          } else if (e.type === "sent") {
            const r = byId.get(e.recId);
            if (r) {
              r.sent = true;
              r.sentAt = e.at;
            }
          }
        }
        // Pending recs from previous runs are hidden (a fresh run blows them
        // away). Scored recs persist forever as a record of feedback.
        const all = Array.from(byId.values())
          .filter((r) => r.status !== "pending" || r.runId === latestRunId)
          .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        return Response.json(all);
      } catch {
        return Response.json([]);
      }
    }

    {
      const m = url.pathname.match(/^\/api\/recs\/([^/]+)\/send-to-moviebot$/);
      if (m && req.method === "POST") {
        try {
          const recId = m[1];
          const log = await readJsonl(RECS_FILE);
          const rec = log.filter((e: any) => e.type === "rec" && e.id === recId).pop();
          if (!rec) return new Response("rec not found", { status: 404 });
          const prompt = `Please download ${rec.title}${rec.year ? ` (${rec.year})` : ""}.`;
          const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          await Bun.write(`${PENDING_DIR}/${id}.txt`, prompt);
          await appendJsonl(RECS_FILE, {
            type: "sent",
            recId,
            promptId: id,
            at: Math.floor(Date.now() / 1000),
          });
          return Response.json({ ok: true, promptId: id });
        } catch {
          return new Response("send failed", { status: 500 });
        }
      }
    }

    {
      const m = url.pathname.match(/^\/api\/recs\/([^/]+)\/status$/);
      if (m && req.method === "POST") {
        try {
          const body: any = await req.json();
          if (!["seen-good", "seen-bad", "pending"].includes(body.status)) {
            return new Response("bad status", { status: 400 });
          }
          await appendJsonl(RECS_FILE, {
            type: "status",
            recId: m[1],
            status: body.status,
            notes: (body.notes || "").toString().slice(0, 2000),
            at: Math.floor(Date.now() / 1000),
          });
          return Response.json({ ok: true });
        } catch {
          return new Response("bad request", { status: 400 });
        }
      }
    }

    if (req.method === "GET" && url.pathname === "/api/recently-watched") {
      try {
        const { userId, filmsLibId } = await getJellyfinMeta();
        const jres = await fetch(
          `${JELLYFIN_URL}/Users/${userId}/Items?ParentId=${filmsLibId}` +
            `&IncludeItemTypes=Movie&Recursive=true&SortBy=DatePlayed&SortOrder=Descending` +
            `&Filters=IsPlayed&Limit=30&Fields=UserData,ProductionYear`,
          { headers: { "X-MediaBrowser-Token": JELLYFIN_API_KEY } },
        );
        const jdata: any = await jres.json();
        const thoughts = await readJsonl(THOUGHTS_FILE);
        const latestByMovie = new Map<string, any>();
        for (const t of thoughts) latestByMovie.set(t.movieId, t);
        const items = (jdata.Items || []).map((it: any) => ({
          movieId: it.Id,
          title: it.Name,
          year: it.ProductionYear || null,
          watchedAt: it.UserData?.LastPlayedDate || null,
          thoughts: latestByMovie.get(it.Id)?.thoughts || "",
          thoughtsAt: latestByMovie.get(it.Id)?.at || null,
        }));
        return Response.json(items);
      } catch {
        return Response.json([]);
      }
    }

    if (req.method === "GET" && url.pathname === "/api/movie-thoughts") {
      try {
        const entries = await readJsonl(THOUGHTS_FILE);
        const latest = new Map<string, any>();
        for (const e of entries) if (e.movieId) latest.set(e.movieId, e);
        return Response.json(Array.from(latest.values()));
      } catch {
        return Response.json([]);
      }
    }

    if (req.method === "POST" && url.pathname === "/api/movie-thoughts") {
      try {
        const body: any = await req.json();
        if (!body.thoughts) return new Response("bad body", { status: 400 });
        await appendJsonl(THOUGHTS_FILE, {
          movieId: body.movieId || "",
          title: body.title || "",
          year: body.year || null,
          thoughts: body.thoughts.toString().slice(0, 5000),
          at: Math.floor(Date.now() / 1000),
        });
        return Response.json({ ok: true });
      } catch {
        return new Response("bad request", { status: 400 });
      }
    }

    if (req.method === "POST" && url.pathname === "/api/prompt") {
      try {
        const body = await req.json();
        const prompt = body.prompt?.trim();
        if (!prompt) return new Response("No prompt provided", { status: 400 });

        const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        await Bun.write(`${PENDING_DIR}/${id}.txt`, prompt);

        return Response.json({ ok: true, id });
      } catch {
        return new Response("Bad request", { status: 400 });
      }
    }

    // Serve static files
    let path = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = Bun.file(`public${path}`);
    if (await file.exists()) return new Response(file);

    return new Response("Not found", { status: 404 });
  },
});

console.log(`Dashboard running on port ${server.port}`);
