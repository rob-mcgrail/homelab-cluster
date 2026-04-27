import { readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { loadavg, totalmem, freemem, cpus } from "node:os";
import { statfsSync } from "node:fs";
import webpush from "web-push";

const DATA_DIR = "/movie-bot-data";
const PENDING_DIR = `${DATA_DIR}/pending`;
const COMPLETED_REQUESTS_DIR = `${DATA_DIR}/completed-requests`;
const COMPLETED_TRIAGE_DIR = `${DATA_DIR}/completed-triage-runs`;
const COMPLETED_RECS_DIR = `${DATA_DIR}/completed-recs-runs`;
const RECS_FILE = `${DATA_DIR}/recommendations.jsonl`;
const THOUGHTS_FILE = `${DATA_DIR}/movie-thoughts.jsonl`;
const DOUBLE_FEATURES_DIR = `${DATA_DIR}/double-features`;
const DISMISSED_DOUBLE_FEATURES_DIR = `${DATA_DIR}/dismissed-double-features`;
const QB_URL = "http://qbittorrent:8080";
const JELLYFIN_URL = "http://jellyfin:8096";
const PIHOLE_URL = "http://host.docker.internal:7001";
const JELLYFIN_API_KEY = process.env.JELLYFIN_API_KEY || "";
const PIHOLE_PASSWORD = process.env.FTLCONF_webserver_api_password || "";
const PIHOLE_PANEL_RAW = (process.env.PIHOLE_PANEL || "off").toLowerCase();
const PIHOLE_PANEL: "off" | "blocks" | "clients" =
  PIHOLE_PANEL_RAW === "blocks" || PIHOLE_PANEL_RAW === "clients" ? PIHOLE_PANEL_RAW : "off";
const HASS_URL = process.env.HASS_URL || "http://homeassistant:8123";
const HASS_TOKEN = process.env.HASS_TOKEN || "";

// Web Push (VAPID). Public key is shipped to the browser on subscribe;
// private key signs each push. Generated once via
// `bun -e 'import wp from "web-push"; console.log(wp.generateVAPIDKeys())'`
// — see .api_keys. If missing, push endpoints all return 503.
const VAPID_PUBLIC = process.env.VAPID_PUBLIC || "";
const VAPID_PRIVATE = process.env.VAPID_PRIVATE || "";
const VAPID_CONTACT = process.env.VAPID_CONTACT || "mailto:admin@example.com";
const PUSH_ENABLED = !!(VAPID_PUBLIC && VAPID_PRIVATE);
if (PUSH_ENABLED) webpush.setVapidDetails(VAPID_CONTACT, VAPID_PUBLIC, VAPID_PRIVATE);

// Subscriptions live in a single JSON file in the persisted data dir.
// One entry per (browser, device) — the endpoint URL is unique enough
// to dedupe. Pruned automatically on 410 Gone (subscription expired).
const SUBS_FILE = `${DATA_DIR}/push-subscriptions.json`;
type PushSub = { endpoint: string; keys: { p256dh: string; auth: string }; createdAt: number };
async function loadSubs(): Promise<PushSub[]> {
  try {
    const txt = await readFile(SUBS_FILE, "utf-8");
    return JSON.parse(txt);
  } catch { return []; }
}
async function saveSubs(subs: PushSub[]): Promise<void> {
  await writeFile(SUBS_FILE, JSON.stringify(subs, null, 2));
}
// Send a push to every subscriber. 410/404 from the push service means
// the subscription is permanently dead (uninstalled, lapsed); we drop
// those. Other errors are logged and the subscription is kept.
async function pushToAll(payload: { title: string; body?: string; url?: string; icon?: string; tag?: string }): Promise<{ sent: number; pruned: number; failed: number }> {
  if (!PUSH_ENABLED) return { sent: 0, pruned: 0, failed: 0 };
  const subs = await loadSubs();
  const body = JSON.stringify(payload);
  let sent = 0, pruned = 0, failed = 0;
  const survivors: PushSub[] = [];
  for (const s of subs) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, body);
      sent++;
      survivors.push(s);
    } catch (e: any) {
      if (e?.statusCode === 410 || e?.statusCode === 404) {
        pruned++;
      } else {
        failed++;
        survivors.push(s); // transient — retry next time
        console.error("push send failed:", s.endpoint, e?.statusCode, e?.body);
      }
    }
  }
  if (pruned > 0) await saveSubs(survivors);
  return { sent, pruned, failed };
}

// Entities surfaced + togglable from the dashboard's Floodlights panel.
// Mixed-domain: lights for the on/off control rows, the input_boolean
// for the "Skip daytime recordings" preference toggle. The /toggle
// endpoint dispatches to the correct HA service based on entity domain.
const FLOODLIGHT_ENTITIES = [
  "light.all_floodlights",
  "light.front_door_floodlight_cam_floodlight",
  "light.deck_floodlight_cam_floodlight",
  "input_boolean.skip_daytime_recordings",
];

async function hassFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${HASS_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${HASS_TOKEN}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
}

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

function parseDoubleFeature(content: string, filename: string) {
  const m = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n+([\s\S]*)$/);
  if (!m) return null;
  const fm: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2].trim();
  }
  return {
    id: fm.id || filename.replace(/\.md$/, ""),
    filmA: fm.filmA || "",
    filmB: fm.filmB || "",
    filmAId: fm.filmAId || null,
    filmBId: fm.filmBId || null,
    createdAt: fm.createdAt || null,
    runId: fm.runId || "",
    reason: m[2].trim(),
  };
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

type TriageStatus = "paused" | "resumed" | null;

function triageFromTags(tagsStr: string): { status: TriageStatus; since: number | null } {
  const byPrefix: Record<string, number | null> = {};
  for (const raw of (tagsStr || "").split(",")) {
    const tag = raw.trim();
    if (!tag.startsWith("triage-")) continue;
    const [prefix, epochStr] = tag.split(":");
    const epoch = epochStr ? Number(epochStr) : null;
    if (!(prefix in byPrefix)) byPrefix[prefix] = isNaN(epoch as number) ? null : epoch;
  }
  // Current schema: triage-paused / triage-resumed (most recent wins).
  // Legacy schema still seen during transition:
  //   triage-retry          → resumed
  //   triage-early-stall    → paused
  //   triage-first-parked   → paused (only as a fallback — triage-first-seen
  //                          is the new permanent marker and carries no status)
  const resumed = byPrefix["triage-resumed"] ?? byPrefix["triage-retry"];
  const paused  = byPrefix["triage-paused"]
                ?? byPrefix["triage-early-stall"]
                ?? byPrefix["triage-first-parked"];
  if (resumed != null && (paused == null || resumed > (paused ?? 0))) {
    return { status: "resumed", since: resumed };
  }
  if (paused != null) return { status: "paused", since: paused };
  return { status: null, since: null };
}

function categorise(state: string, triageStatus: TriageStatus): string {
  if (triageStatus) return "triaged";
  // Actively attempting a download (even if stuck): qBit has given it a slot.
  if (state === "downloading" || state === "forcedDL" || state === "stalledDL" || state === "metaDL" || state === "allocating" || state === "checkingDL") return "downloading";
  // Done / sharing / waiting-to-share.
  if (state === "uploading" || state === "forcedUP" || state === "stalledUP" || state === "queuedUP" || state === "checkingUP") return "seeding";
  // Everything else — queuedDL (in qBit queue, never active yet), stopped/paused
  // without a triage tag, error, missingFiles, unknown. The triage bot should
  // be looking at any of these.
  return "triaged";
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
        const mapped = torrents.map((t) => {
          const triage = triageFromTags(t.tags || "");
          return {
            name: cleanTitle(t.name),
            sourceFile: t.content_path ? t.content_path.split("/").pop() : t.name,
            state: t.state,
            category: categorise(t.state),
            triage,
            progress: Math.round(t.progress * 100),
            downloaded: formatBytes(t.downloaded),
            size: formatBytes(t.size),
            eta: formatEta(t.eta),
            dlspeed: formatBytes(t.dlspeed) + "/s",
            upspeed: formatBytes(t.upspeed) + "/s",
            addedOn: t.added_on,
          };
        });
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

    if (req.method === "GET" && url.pathname === "/api/config") {
      return Response.json({ piholePanel: PIHOLE_PANEL });
    }

    if (req.method === "GET" && url.pathname === "/api/floodlights") {
      if (!HASS_TOKEN) return Response.json({ configured: false });
      try {
        const lights = await Promise.all(
          FLOODLIGHT_ENTITIES.map(async (eid) => {
            const r = await hassFetch(`/api/states/${encodeURIComponent(eid)}`);
            if (!r.ok) throw new Error(`hass ${eid} ${r.status}`);
            const s: any = await r.json();
            return { entity_id: eid, state: s.state };
          }),
        );
        return Response.json({ configured: true, lights });
      } catch {
        return Response.json({ configured: true, error: true });
      }
    }

    {
      // Live video streaming via go2rtc. Three endpoints:
      //   /api/camera-preview/<cam>  — MJPEG of the SD sub stream
      //                                (1920×576) for the always-on
      //                                dashboard tile <img>. Cheap.
      //   /api/camera-stream/<cam>   — MJPEG of the HD main stream
      //                                (5120×1552). Legacy <img>
      //                                fallback path.
      //   /api/camera-mp4/<cam>      — Fragmented H.264 MP4 of the HD
      //                                main stream for <video> + MSE.
      //                                Used by the fullscreen modal.
      //                                No per-frame JPEG re-encode —
      //                                much lighter than MJPEG.
      // All paths transcode through Intel VAAPI on the iGPU.
      const valid = new Set(["front_door", "deck"]);
      // Match /api/camera-(preview|stream)[-mobile]/<cam>. The optional
      // -mobile suffix routes to a smaller go2rtc variant (960×288,
      // ~1/4 per-frame bytes) for phones whose Chrome MJPEG handler
      // wedges on the full-rate sub-stream feed.
      const mjpeg = url.pathname.match(/^\/api\/camera-(preview|stream)(-mobile)?\/([a-z_]+)$/);
      if (mjpeg && req.method === "GET") {
        if (!valid.has(mjpeg[3])) return new Response("bad slug", { status: 404 });
        const isMobile = !!mjpeg[2];
        const cam = mjpeg[3];
        // Source mapping:
        //   preview  → <cam>_sub        (sub stream MJPEG)
        //   stream   → <cam>            (main stream MJPEG)
        //   *-mobile → <cam>_mobile     (downscaled sub stream — both
        //              tile and modal share this on phones)
        const src = isMobile ? `${cam}_mobile` : (mjpeg[1] === "preview" ? `${cam}_sub` : cam);
        try {
          const r = await fetch(`http://go2rtc:1984/api/stream.mjpeg?src=${src}`);
          if (!r.ok || !r.body) return new Response("go2rtc call failed", { status: 502 });
          return new Response(r.body, {
            headers: {
              "Content-Type": r.headers.get("content-type") || "multipart/x-mixed-replace",
              "Cache-Control": "no-store",
            },
          });
        } catch {
          return new Response("go2rtc error", { status: 502 });
        }
      }
      const mp4 = url.pathname.match(/^\/api\/camera-mp4\/([a-z_]+)$/);
      if (mp4 && req.method === "GET") {
        if (!valid.has(mp4[1])) return new Response("bad slug", { status: 404 });
        try {
          // Use the SUB stream (H.264 1920×576 25fps native — no codec
          // transcoding required, go2rtc just packages packets into
          // fragmented MP4). This dodges the VAAPI HEVC decode quirk
          // that plagues the main stream's H.264 transcode path, and
          // costs effectively zero CPU.
          const r = await fetch(`http://go2rtc:1984/api/stream.mp4?src=${mp4[1]}_sub`);
          if (!r.ok || !r.body) return new Response("go2rtc call failed", { status: 502 });
          return new Response(r.body, {
            headers: {
              "Content-Type": r.headers.get("content-type") || "video/mp4",
              "Cache-Control": "no-store",
            },
          });
        } catch {
          return new Response("go2rtc error", { status: 502 });
        }
      }
    }

    {
      // HD snapshot from go2rtc (single frame extracted from the
      // ongoing transcoded stream). Same source as /api/camera-stream
      // so the snapshot matches what's live.
      const m = url.pathname.match(/^\/api\/camera-snapshot\/([a-z_]+)$/);
      if (m && req.method === "GET") {
        const valid = new Set(["front_door", "deck"]);
        if (!valid.has(m[1])) return new Response("bad slug", { status: 404 });
        try {
          const r = await fetch(`http://go2rtc:1984/api/frame.jpeg?src=${m[1]}`);
          if (!r.ok || !r.body) return new Response("go2rtc call failed", { status: 502 });
          return new Response(r.body, {
            headers: {
              "Content-Type": r.headers.get("content-type") || "image/jpeg",
              "Cache-Control": "no-store",
            },
          });
        } catch {
          return new Response("go2rtc error", { status: 502 });
        }
      }
    }

    if (req.method === "GET" && url.pathname === "/api/cam-recordings") {
      const cams = ["front_door", "deck"] as const;
      const out: { cam: string; filename: string; mtimeMs: number; sizeBytes: number }[] = [];
      for (const cam of cams) {
        try {
          const files = await readdir(`/cam-recordings/${cam}`);
          for (const fn of files) {
            if (!fn.endsWith(".mp4")) continue;
            try {
              const s = await stat(`/cam-recordings/${cam}/${fn}`);
              out.push({ cam, filename: fn, mtimeMs: s.mtimeMs, sizeBytes: s.size });
            } catch { /* file vanished mid-read */ }
          }
        } catch { /* dir missing — fine, return empty for that cam */ }
      }
      out.sort((a, b) => b.mtimeMs - a.mtimeMs);
      return Response.json(out.slice(0, 20));
    }

    {
      // Serve a single clip — Bun.file responses handle Range requests
      // automatically, so the browser can scrub through the video without
      // downloading the whole file.
      const m = url.pathname.match(/^\/api\/cam-recording\/(front_door|deck)\/([\w.-]+\.mp4)$/);
      if (m && req.method === "GET") {
        const path = `/cam-recordings/${m[1]}/${m[2]}`;
        const file = Bun.file(path);
        if (!(await file.exists())) return new Response("not found", { status: 404 });
        return new Response(file, { headers: { "Content-Type": "video/mp4" } });
      }
    }

    if (req.method === "POST" && url.pathname === "/api/floodlights/panic") {
      if (!HASS_TOKEN) return new Response("not configured", { status: 503 });
      try {
        const r = await hassFetch("/api/services/script/turn_on", {
          method: "POST",
          body: JSON.stringify({ entity_id: "script.panic_floodlights_and_sirens" }),
        });
        if (!r.ok) return new Response("hass call failed", { status: 502 });
        return Response.json({ ok: true });
      } catch {
        return new Response("error", { status: 500 });
      }
    }

    if (req.method === "POST" && url.pathname === "/api/floodlights/sirens-off") {
      if (!HASS_TOKEN) return new Response("not configured", { status: 503 });
      try {
        const r = await hassFetch("/api/services/siren/turn_off", {
          method: "POST",
          body: JSON.stringify({
            entity_id: [
              "siren.front_door_floodlight_cam_siren",
              "siren.deck_floodlight_cam_siren",
            ],
          }),
        });
        if (!r.ok) return new Response("hass call failed", { status: 502 });
        return Response.json({ ok: true });
      } catch {
        return new Response("error", { status: 500 });
      }
    }

    // ---- Web Push endpoints ---------------------------------------
    if (req.method === "GET" && url.pathname === "/api/push/vapid-public") {
      if (!PUSH_ENABLED) return new Response("not configured", { status: 503 });
      return Response.json({ key: VAPID_PUBLIC });
    }

    if (req.method === "POST" && url.pathname === "/api/push/subscribe") {
      if (!PUSH_ENABLED) return new Response("not configured", { status: 503 });
      try {
        const body: any = await req.json();
        if (!body?.endpoint || !body?.keys?.p256dh || !body?.keys?.auth) {
          return new Response("bad subscription", { status: 400 });
        }
        const subs = await loadSubs();
        // Dedupe by endpoint — same browser re-subscribing replaces the
        // older entry rather than accumulating duplicates.
        const filtered = subs.filter(s => s.endpoint !== body.endpoint);
        filtered.push({
          endpoint: body.endpoint,
          keys: { p256dh: body.keys.p256dh, auth: body.keys.auth },
          createdAt: Date.now(),
        });
        await saveSubs(filtered);
        return Response.json({ ok: true, total: filtered.length });
      } catch {
        return new Response("bad request", { status: 400 });
      }
    }

    if (req.method === "POST" && url.pathname === "/api/push/unsubscribe") {
      try {
        const body: any = await req.json();
        if (!body?.endpoint) return new Response("bad request", { status: 400 });
        const subs = await loadSubs();
        const filtered = subs.filter(s => s.endpoint !== body.endpoint);
        await saveSubs(filtered);
        return Response.json({ ok: true, total: filtered.length });
      } catch {
        return new Response("bad request", { status: 400 });
      }
    }

    if (req.method === "POST" && url.pathname === "/api/push/test") {
      const result = await pushToAll({
        title: "Dashboard test",
        body: "Push is working — alerts will arrive here.",
        tag: "dashboard-test",
        url: "/",
      });
      return Response.json(result);
    }

    // Webhook receiver. HA (or any local script) POSTs here when an
    // event worth notifying about happens. Body: {title, body?, url?,
    // icon?, tag?}. Auth is a shared token in the Authorization header
    // — token comes from .api_keys, must match X-Push-Token. Local-
    // network only because we never expose dashboard:8000 publicly,
    // but token-gated as defense in depth in case that changes.
    if (req.method === "POST" && url.pathname === "/api/event") {
      const want = process.env.PUSH_EVENT_TOKEN || "";
      const got = req.headers.get("x-push-token") || "";
      if (!want || got !== want) return new Response("unauthorized", { status: 401 });
      try {
        const body: any = await req.json();
        if (typeof body?.title !== "string") return new Response("bad payload", { status: 400 });
        const result = await pushToAll({
          title: body.title,
          body: body.body,
          url: body.url,
          icon: body.icon,
          tag: body.tag,
        });
        return Response.json(result);
      } catch {
        return new Response("bad request", { status: 400 });
      }
    }

    if (req.method === "POST" && url.pathname === "/api/floodlights/toggle") {
      if (!HASS_TOKEN) return new Response("not configured", { status: 503 });
      try {
        const body: any = await req.json();
        const eid = body?.entity_id;
        if (typeof eid !== "string" || !FLOODLIGHT_ENTITIES.includes(eid)) {
          return new Response("bad entity_id", { status: 400 });
        }
        // Dispatch to the entity's domain — light.toggle for lights,
        // input_boolean.toggle for the skip-daytime preference.
        const domain = eid.split(".", 1)[0];
        const r = await hassFetch(`/api/services/${domain}/toggle`, {
          method: "POST",
          body: JSON.stringify({ entity_id: eid }),
        });
        if (!r.ok) return new Response("hass call failed", { status: 502 });
        return Response.json({ ok: true });
      } catch {
        return new Response("bad request", { status: 400 });
      }
    }

    if (req.method === "GET" && url.pathname === "/api/pihole-top-blocked") {
      try {
        const from = Math.floor(Date.now() / 1000) - 86400;
        const data = await piholeGet(`/api/stats/top_domains?blocked=true&count=20&from=${from}`);
        const rows = (data?.domains || []).map((d: any) => ({
          domain: d.domain || "",
          count: d.count || 0,
        }));
        return Response.json(rows);
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

    if (req.method === "GET" && url.pathname === "/api/double-features") {
      try {
        const files = (await readdir(DOUBLE_FEATURES_DIR))
          .filter((f) => f.endsWith(".md"))
          .sort();
        const items: any[] = [];
        for (const f of files) {
          const content = await Bun.file(`${DOUBLE_FEATURES_DIR}/${f}`).text();
          const parsed = parseDoubleFeature(content, f);
          if (parsed) items.push(parsed);
        }
        // Newest first by createdAt (string ISO sorts lexically)
        items.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
        return Response.json(items);
      } catch {
        return Response.json([]);
      }
    }

    {
      const m = url.pathname.match(/^\/api\/double-features\/([^/]+)\/dismiss$/);
      if (m && req.method === "POST") {
        const id = m[1];
        // Slug whitelist — prevent path traversal via ../ or absolute paths
        if (!/^[a-zA-Z0-9-]+$/.test(id)) {
          return new Response("bad id", { status: 400 });
        }
        const src = `${DOUBLE_FEATURES_DIR}/${id}.md`;
        const dst = `${DISMISSED_DOUBLE_FEATURES_DIR}/${id}.md`;
        if (!(await Bun.file(src).exists())) {
          return new Response("not found", { status: 404 });
        }
        try {
          await rename(src, dst);
          return Response.json({ ok: true });
        } catch {
          return new Response("dismiss failed", { status: 500 });
        }
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
