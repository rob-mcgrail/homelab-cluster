// Minimal OPDS catalog over a folder of ebooks, for KOReader.
//
// No database, no metadata extraction: the folder tree IS the catalog.
// Subfolders become navigation entries, book files become download
// entries, and the title is the filename minus its extension. Drop files
// into ${DATA_ROOT}/media/books (any nesting, e.g. Author/Title.epub) and
// they show up on the next request.
//
//   GET /opds              → root folder
//   GET /opds?path=a/b     → a subfolder
//   GET /opds/recent       → every book, newest first (find fresh uploads)
//   GET /file/<path>       → download one book
import { readdir, stat } from "node:fs/promises";
import { resolve, relative, extname, basename } from "node:path";

const BOOKS_DIR = resolve(process.env.BOOKS_DIR || "/books");
const RECENT_LIMIT = 50;

const MIME: Record<string, string> = {
  ".epub": "application/epub+zip",
  ".pdf": "application/pdf",
  ".mobi": "application/x-mobipocket-ebook",
  ".azw3": "application/vnd.amazon.ebook",
  ".azw": "application/vnd.amazon.ebook",
  ".fb2": "application/x-fictionbook+xml",
  ".djvu": "image/vnd.djvu",
  ".cbz": "application/vnd.comicbook+zip",
  ".cbr": "application/vnd.comicbook-rar",
  ".txt": "text/plain; charset=utf-8",
};

const NAV_TYPE = "application/atom+xml;profile=opds-catalog;kind=navigation";
const ACQ_TYPE = "application/atom+xml;profile=opds-catalog;kind=acquisition";

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const encPath = (rel: string) => rel.split("/").map(encodeURIComponent).join("/");
const title = (file: string) => basename(file, extname(file)).replace(/[._]+/g, " ").trim();

// Resolve a client-supplied relative path, refusing anything that escapes
// BOOKS_DIR (../, absolute paths, encoded traversal after decoding).
function safePath(rel: string): string | null {
  const abs = resolve(BOOKS_DIR, rel.replace(/^\/+/, ""));
  const r = relative(BOOKS_DIR, abs);
  if (r.startsWith("..") || resolve(BOOKS_DIR, r) !== abs) return null;
  return abs;
}

type Book = { rel: string; mtime: Date; size: number };

function bookEntry(b: Book): string {
  const type = MIME[extname(b.rel).toLowerCase()];
  return `<entry>
  <id>urn:books:${esc(b.rel)}</id>
  <title>${esc(title(b.rel))}</title>
  <updated>${b.mtime.toISOString()}</updated>
  <link rel="http://opds-spec.org/acquisition" href="/file/${esc(encPath(b.rel))}" type="${type}" length="${b.size}"/>
</entry>`;
}

function feed(id: string, name: string, self: string, kind: string, entries: string[]): Response {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
<id>${esc(id)}</id>
<title>${esc(name)}</title>
<updated>${new Date().toISOString()}</updated>
<link rel="self" href="${esc(self)}" type="${kind}"/>
<link rel="start" href="/opds" type="${NAV_TYPE}"/>
${entries.join("\n")}
</feed>`;
  return new Response(xml, { headers: { "Content-Type": `${kind}; charset=utf-8` } });
}

async function folderFeed(rel: string): Promise<Response> {
  const abs = safePath(rel);
  if (!abs) return new Response("bad path", { status: 400 });
  let names: string[];
  try {
    names = (await readdir(abs)).filter((n) => !n.startsWith(".")).sort((a, b) => a.localeCompare(b));
  } catch {
    return new Response("not found", { status: 404 });
  }
  const dirs: string[] = [];
  const books: string[] = [];
  if (!rel) {
    dirs.push(`<entry>
  <id>urn:books:recent</id>
  <title>Recently added</title>
  <updated>${new Date().toISOString()}</updated>
  <link rel="subsection" href="/opds/recent" type="${ACQ_TYPE}"/>
</entry>`);
  }
  for (const n of names) {
    const childRel = rel ? `${rel}/${n}` : n;
    let st;
    try { st = await stat(`${abs}/${n}`); } catch { continue; }
    if (st.isDirectory()) {
      dirs.push(`<entry>
  <id>urn:books:dir:${esc(childRel)}</id>
  <title>${esc(n)}</title>
  <updated>${st.mtime.toISOString()}</updated>
  <link rel="subsection" href="/opds?path=${esc(encodeURIComponent(childRel))}" type="${NAV_TYPE}"/>
</entry>`);
    } else if (MIME[extname(n).toLowerCase()]) {
      books.push(bookEntry({ rel: childRel, mtime: st.mtime, size: st.size }));
    }
  }
  const self = rel ? `/opds?path=${encodeURIComponent(rel)}` : "/opds";
  return feed(`urn:books:dir:${rel}`, rel ? basename(rel) : "Books", self, books.length ? ACQ_TYPE : NAV_TYPE, [...dirs, ...books]);
}

async function allBooks(): Promise<Book[]> {
  const out: Book[] = [];
  const entries = await readdir(BOOKS_DIR, { recursive: true });
  for (const rel of entries) {
    if (rel.split("/").some((p) => p.startsWith("."))) continue;
    if (!MIME[extname(rel).toLowerCase()]) continue;
    try {
      const st = await stat(`${BOOKS_DIR}/${rel}`);
      if (st.isFile()) out.push({ rel, mtime: st.mtime, size: st.size });
    } catch { /* vanished mid-walk */ }
  }
  return out;
}

Bun.serve({
  port: 8000,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/") return Response.redirect("/opds", 302);

    if (url.pathname === "/opds") return folderFeed((url.searchParams.get("path") || "").replace(/^\/+|\/+$/g, ""));

    if (url.pathname === "/opds/recent") {
      const books = (await allBooks()).sort((a, b) => b.mtime.getTime() - a.mtime.getTime()).slice(0, RECENT_LIMIT);
      return feed("urn:books:recent", "Recently added", "/opds/recent", ACQ_TYPE, books.map(bookEntry));
    }

    if (url.pathname.startsWith("/file/")) {
      const rel = decodeURIComponent(url.pathname.slice("/file/".length));
      const abs = safePath(rel);
      const type = MIME[extname(rel).toLowerCase()];
      if (!abs || !type) return new Response("bad path", { status: 400 });
      const file = Bun.file(abs);
      if (!(await file.exists())) return new Response("not found", { status: 404 });
      return new Response(file, {
        headers: {
          "Content-Type": type,
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(basename(abs))}`,
        },
      });
    }

    return new Response("not found", { status: 404 });
  },
});

console.log(`books: serving ${BOOKS_DIR} on :8000`);
