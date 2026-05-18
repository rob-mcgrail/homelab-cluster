import { createHmac, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";

const SECRET = process.env.AUTH_SECRET || "";
const LIFETIME_DAYS = parseInt(process.env.AUTH_COOKIE_LIFETIME_DAYS || "21", 10);
const DOMAIN = process.env.DOMAIN || "";

if (!SECRET) { console.error("AUTH_SECRET not set"); process.exit(1); }
if (!DOMAIN) { console.error("DOMAIN not set"); process.exit(1); }
if (!Number.isFinite(LIFETIME_DAYS) || LIFETIME_DAYS <= 0) {
  console.error("AUTH_COOKIE_LIFETIME_DAYS must be a positive integer");
  process.exit(1);
}

const COOKIE_NAME = "homelab_auth";
// Domain attr without leading dot. Setting it to www.{DOMAIN} makes the
// cookie valid for www.{DOMAIN} and any sub-subdomain (incl. auth.www.).
// The auth.www. origin is allowed to Set-Cookie for www.{DOMAIN} because
// www.{DOMAIN} is a parent of the request host.
const COOKIE_DOMAIN = `www.${DOMAIN}`;
const LIFETIME_SECONDS = LIFETIME_DAYS * 86400;
const PROTECTED_HOST = `www.${DOMAIN}`;
const AUTH_HOST = `auth.www.${DOMAIN}`;

function sign(payload: string): string {
  return createHmac("sha256", SECRET).update(payload).digest("base64url");
}

function mint(): string {
  const expiry = Math.floor(Date.now() / 1000) + LIFETIME_SECONDS;
  const expiryStr = String(expiry);
  return `${expiryStr}.${sign(expiryStr)}`;
}

function verifyCookie(value: string | undefined): boolean {
  if (!value) return false;
  const dot = value.indexOf(".");
  if (dot < 0) return false;
  const expiryStr = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  // Reject anything that isn't a plain decimal integer. Number() would
  // otherwise accept 0x… / 1e… / etc., which the HMAC check still rules
  // out — but a strict format check kills that surprise at the front door.
  if (!/^\d+$/.test(expiryStr)) return false;
  const expiry = Number(expiryStr);
  if (!Number.isFinite(expiry) || expiry < Math.floor(Date.now() / 1000)) return false;
  const expected = sign(expiryStr);
  if (sig.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    return false;
  }
}

function getCookie(req: Request, name: string): string | undefined {
  const header = req.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq) === name) return part.slice(eq + 1);
  }
}

// Open-redirect guard: only honor ?next= when it points back at our own
// protected host over https. Otherwise fall back to the root.
function safeNext(raw: string | null): string {
  const fallback = `https://${PROTECTED_HOST}/`;
  if (!raw) return fallback;
  try {
    const u = new URL(raw);
    if (u.protocol === "https:" && u.hostname === PROTECTED_HOST) return u.toString();
  } catch {}
  return fallback;
}

Bun.serve({
  port: 8000,
  fetch(req) {
    const url = new URL(req.url);

    // forward_auth target. Caddy sends X-Forwarded-* describing the
    // original request; we use them to round-trip the user back to the
    // exact URL they were trying to reach.
    if (url.pathname === "/verify") {
      if (verifyCookie(getCookie(req, COOKIE_NAME))) {
        return new Response(null, { status: 204 });
      }
      const xfHost = req.headers.get("x-forwarded-host") || PROTECTED_HOST;
      const xfProto = req.headers.get("x-forwarded-proto") || "https";
      const xfUri = req.headers.get("x-forwarded-uri") || "/";
      const next = encodeURIComponent(`${xfProto}://${xfHost}${xfUri}`);
      return new Response(null, {
        status: 302,
        headers: { Location: `https://${AUTH_HOST}/?next=${next}` },
      });
    }

    // User-facing mint endpoint, reached via auth.www.{DOMAIN}/.
    if (url.pathname === "/") {
      const location = safeNext(url.searchParams.get("next"));
      const cookie = [
        `${COOKIE_NAME}=${mint()}`,
        `Path=/`,
        `Domain=${COOKIE_DOMAIN}`,
        `Secure`,
        `HttpOnly`,
        `SameSite=Lax`,
        `Max-Age=${LIFETIME_SECONDS}`,
      ].join("; ");
      return new Response(null, {
        status: 302,
        headers: { "Set-Cookie": cookie, Location: location },
      });
    }

    return new Response("not found", { status: 404 });
  },
});

console.log(`auth listening on :8000 (cookie domain: ${COOKIE_DOMAIN}, lifetime: ${LIFETIME_DAYS}d)`);
