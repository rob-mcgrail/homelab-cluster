#!/usr/bin/env python3
"""Fetch a handful of headlines from each RSS/Atom feed and print them as
"- [Label] Title" lines for the LED news curator prompt.

Args: one or more "Label|https://feed.url" pairs. Feeds that fail to fetch
or parse are silently skipped — a dead feed must never break the run.
"""
import sys
import urllib.request
import xml.etree.ElementTree as ET

PER_FEED = 8
UA = "Mozilla/5.0 (news-led homelab curator)"

out = []
for arg in sys.argv[1:]:
    if "|" not in arg:
        continue
    label, url = arg.split("|", 1)
    try:
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        data = urllib.request.urlopen(req, timeout=8).read()
        root = ET.fromstring(data)
    except Exception:
        continue
    # RSS uses <item>, Atom uses <entry>; {*} matches any namespace.
    items = root.findall(".//{*}item") or root.findall(".//{*}entry")
    n = 0
    for it in items:
        t = it.find("{*}title")
        title = " ".join((t.text or "").split()) if t is not None and t.text else ""
        if not title:
            continue
        out.append(f"- [{label}] {title}")
        n += 1
        if n >= PER_FEED:
            break

print("\n".join(out))
