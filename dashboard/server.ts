import { readdir, readFile } from "node:fs/promises";
import { loadavg, totalmem, freemem, cpus } from "node:os";
import { statfsSync } from "node:fs";

const PROMPTS_DIR = "/prompts";
const QB_URL = "http://qbittorrent:8080";

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
        const pendingFiles = (await readdir(PROMPTS_DIR))
          .filter((f) => f.endsWith(".txt"))
          .sort()
          .reverse();

        const pending = await Promise.all(
          pendingFiles.map(async (f) => {
            const base = f.replace(/\.txt$/, "");
            const prompt = await Bun.file(`${PROMPTS_DIR}/${f}`).text();
            return { id: base, prompt, result: null, pending: true };
          })
        );

        // completed prompts
        const doneDir = `${PROMPTS_DIR}/done`;
        let done: any[] = [];
        try {
          const doneFiles = (await readdir(doneDir))
            .filter((f) => f.endsWith(".txt"))
            .sort()
            .reverse();

          done = await Promise.all(
            doneFiles.map(async (f) => {
              const base = f.replace(/\.txt$/, "");
              const prompt = await Bun.file(`${doneDir}/${f}`).text();
              const outFile = Bun.file(`${doneDir}/${base}.out`);
              const result = (await outFile.exists())
                ? await outFile.text()
                : null;
              return { id: base, prompt, result, pending: false };
            })
          );
        } catch {}

        const all = [...pending, ...done].slice(0, 10);
        return Response.json(all);
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
        });
      } catch {
        return Response.json({ error: true });
      }
    }

    if (req.method === "POST" && url.pathname === "/api/prompt") {
      try {
        const body = await req.json();
        const prompt = body.prompt?.trim();
        if (!prompt) return new Response("No prompt provided", { status: 400 });

        const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        await Bun.write(`${PROMPTS_DIR}/${id}.txt`, prompt);

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
