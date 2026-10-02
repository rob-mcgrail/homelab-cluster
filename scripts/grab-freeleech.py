#!/usr/bin/env python3
"""Add a movie to Radarr and grab the best FREELEECH release for it.

Freeleech downloads don't count against your ratio on IPTorrents/CinemaZ, so
this is the cheap way to fill the library while keeping tracker standing. The
seed obligation is unchanged — qBittorrent's global 21-day policy covers it
(see "Seeding & private tracker standing" in CLAUDE.md).

Usage:
    scripts/grab-freeleech.py "War Dogs" 2016
    scripts/grab-freeleech.py "Okja" 2017 --4k
    scripts/grab-freeleech.py "In the Line of Fire" 1993 --dry

Profile defaults to Rob1080. Pass --4k for Rob4K: per CLAUDE.md that's for
recent releases, highly cinematic films, and anything where the visual quality
earns the disk. Rob4K is a superset (it still accepts Bluray-1080p), so it only
widens the candidate pool.

Exit codes: 0 grabbed, 1 error, 2 nothing suitable found.
"""
import argparse
import json
import os
import sys
import urllib.parse
import urllib.request

PROFILES = {"rob1080": 7, "rob4k": 8}
ROOT_FOLDER = "/data/media/movies"
FREELEECH_FLAGS = {"G_Freeleech", "freeleech"}

# The freeleech flag is ONLY meaningful on a private tracker. kickasstorrents
# and The Pirate Bay stamp G_Freeleech on 100% of their results (verified: 236
# and 248 results, every one flagged), so filtering on the flag alone silently
# grabs from a public tracker. Match the indexer name as well.
PRIVATE_INDEXERS = ("IPTorrents", "CinemaZ")


def load_keys():
    """Read RADARR_URL / RADARR_API_KEY out of the repo's .api_keys."""
    path = os.path.join(os.path.dirname(__file__), "..", ".api_keys")
    env = {}
    with open(os.path.abspath(path)) as fh:
        for line in fh:
            line = line.strip()
            if line.startswith("RADARR_") and "=" in line:
                k, v = line.split("=", 1)
                env[k] = v
    return env["RADARR_URL"], env["RADARR_API_KEY"]


URL, KEY = load_keys()


def api(path, method="GET", body=None, timeout=180):
    req = urllib.request.Request(
        URL + path,
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"X-Api-Key": KEY, "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read()
    return json.loads(raw) if raw else {}


def gb(n):
    return n / 1024 ** 3


def find_or_add(title, year, profile_id, dry):
    """Return the Radarr movie record, adding it if not already tracked."""
    for m in api("/api/v3/movie"):
        if m["title"].lower() == title.lower() and m["year"] == year:
            print(f"  already in Radarr: id={m['id']} profile={m['qualityProfileId']}")
            return m

    matches = api("/api/v3/movie/lookup?" + urllib.parse.urlencode({"term": f"{title} {year}"}))
    exact = [m for m in matches if m.get("year") == year]
    if not exact:
        print(f"  !! no TMDB match for {title!r} ({year})", file=sys.stderr)
        if matches:
            print("     closest:", ", ".join(f"{m['title']} ({m.get('year')})" for m in matches[:3]),
                  file=sys.stderr)
        return None
    cand = exact[0]
    print(f"  tmdb={cand['tmdbId']} {cand['title']} ({cand['year']}) {cand.get('runtime')}min")
    if dry:
        print("  [dry] would add to Radarr")
        return None
    m = api("/api/v3/movie", "POST", {
        "tmdbId": cand["tmdbId"],
        "title": cand["title"],
        "qualityProfileId": profile_id,
        "rootFolderPath": ROOT_FOLDER,
        "monitored": True,
        "minimumAvailability": "released",
        "addOptions": {"searchForMovie": False},
    })
    print(f"  added id={m['id']} profile={m['qualityProfileId']}")
    return m


def grab(movie, runtime, dry):
    releases = api(f"/api/v3/release?movieId={movie['id']}")
    accepted = [r for r in releases if not r.get("rejected")]
    private = [r for r in accepted
               if any(p in (r.get("indexer") or "") for p in PRIVATE_INDEXERS)]
    free = [r for r in private if FREELEECH_FLAGS & set(r.get("indexerFlags") or [])]
    print(f"  {len(releases)} releases, {len(accepted)} pass the profile, "
          f"{len(private)} on a private tracker, {len(free)} genuinely freeleech")

    if not free:
        if private:
            best = max(private, key=lambda r: (r.get("customFormatScore") or 0, r.get("seeders") or 0))
            print(f"  !! no freeleech. Best private-tracker option would be "
                  f"{gb(best['size']):.2f}GB {best['seeders']}S on {best['indexer']}")
        elif accepted:
            print(f"  !! nothing on IPTorrents/CinemaZ — only public trackers have it "
                  f"({len(accepted)} releases). Grab manually if you want it anyway.")
        return None

    # Radarr's own ranking: custom-format score first (HEVC is +10), then swarm health.
    free.sort(key=lambda r: (-(r.get("customFormatScore") or 0), -(r.get("seeders") or 0)))
    pick = free[0]
    rate = pick["size"] / 1024 / 1024 / runtime if runtime else 0
    print(f"  PICK {gb(pick['size']):.2f}GB ({rate:.0f} MB/min) {pick['seeders']}S "
          f"score={pick['customFormatScore']} {pick['quality']['quality']['name']} "
          f"[{pick['indexer']}]")
    print(f"       {pick['title'][:72]}")
    if dry:
        print("  [dry] would grab")
        return pick
    api("/api/v3/release", "POST", {"guid": pick["guid"], "indexerId": pick["indexerId"]})
    print("  grabbed -> qBittorrent")
    return pick


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("title")
    ap.add_argument("year", type=int)
    ap.add_argument("--4k", dest="fourk", action="store_true", help="use Rob4K instead of Rob1080")
    ap.add_argument("--dry", action="store_true", help="show what would happen, change nothing")
    a = ap.parse_args()

    profile = PROFILES["rob4k" if a.fourk else "rob1080"]
    print(f"{a.title} ({a.year})  ->  {'Rob4K' if a.fourk else 'Rob1080'}")
    movie = find_or_add(a.title, a.year, profile, a.dry)
    if movie is None:
        return 1 if not a.dry else 0
    if movie.get("hasFile"):
        print("  already has a file — skipping")
        return 0
    return 0 if grab(movie, movie.get("runtime") or 0, a.dry) else 2


if __name__ == "__main__":
    sys.exit(main())
