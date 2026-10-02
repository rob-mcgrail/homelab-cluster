# Triage run — 2026-10-02T02:20:00Z

**Reviewed:** 25 torrents · 57 missing movies (30 released) · ~20 recent user prompts

## Actions taken
- **El (1953)** — applied `triage-seed-policy:minimal` (ratio=0.25, seeding-time=30m): public tracker torrent. qBit removed it shortly after (auto-culled by global max_ratio_act=1), confirming policy worked correctly.
- **My Little Pony Make Your Mark S06E03** — triggered DownloadedEpisodesScan: completed torrent stuck at Sonarr's "completed" queue for unknown reasons.
- **Civilisations 2018 S01E03** — triggered DownloadedEpisodesScan: same import-stuck issue.
- **My Little Pony Make Your Mark S06E04** — triggered DownloadedEpisodesScan: same import-stuck issue.

## Considered but rejected
- **First Light (ID=583) → RobDifficult** — on profile 7, 0 releases available across all indexers. Profile switch wouldn't create content. Left on Rob1080.
- **29 other missing+released movies already on RobDifficult** — all were evaluated in prior runs. Available releases are either zero (indexer gaps) or rejected for valid reasons (DVD quality, wrong movie matches, micro-encodes). No fresh search would change outcomes.
- **Recent user requests** — Él (ID=765), Vitalina Varela (ID=759), The Great Muppet Caper (ID=762) all already have `hasFile=True` — successfully grabbed and imported since their addition.
- **Remaining user additions** — The Muppet Christmas Carol (1992), The Muppets (2011), Verity (2026), Ordet (1955), Red Beard (1965), Damnation (1988) — monitored and searching; some are upcoming/announced releases. No action needed.
- **16 CinemaZ torrents** — all have correct `triage-seed-policy:cinemaz` with ratio=-1 and seeding_time=87840min (61d). Already compliant.

## Anomalies
- **9 private-tracker torrents tagged as `private=true` but NOT CinemaZ** — Civilisations (3 episodes), My Little Pony (4 episodes), Red Beard, The Invite. Tracker URLs (async.empirehost.me, 127.0.0.1.stackoverflow.tech, routing.bgp.technology) don't clearly identify the tracker. Unknown ratio/seed rules. Left alone per policy — no `triage-seed-policy` tag set. These use global defaults (21d seeding, auto-remove at max_ratio_act=1).
- **First Light (ID=583)** — 0 releases across any indexer, zero history. Pure indexer-coverage gap. Escalating to RobDifficult wouldn't help.
- **3 Sonarr queue items stuck at 'completed'** — torrents finished downloading but Sonarr hasn't imported. DownloadedEpisodesScan commands were manually dispatched this run but may not have resolved the root issue (possibly import loop, permissions, or hardlink failure).
- **Sucker Free City (ID=532), Redoubt (ID=455), Gaza Mon Amour (ID=510)** — 0 available releases or wrong movie matches (Gaza Mon Amour returning Dune results). Indexer-coverage gaps.
- **Fata Morgana (ID=568)** — only 2 available releases (Bluray-720p 1.2GB, Unknown 1.1GB), both rejected. Indexer quality coverage insufficient.
- **All 25 qBit torrents in stalledUP** — no active downloads in progress anywhere. Torrent queue is fully settled — all completed seeding, nothing in download.

## Summary
- Paused: 0
- Resumed: 0
- Removed + blocklisted: 0
- Priority-boosted: 0
- MissingFiles cleaned: 0
- Sonarr import scans triggered: 3
- Radarr profile switches (→ RobDifficult): 0
- Per-movie searches triggered: 0
- Override-grabs: 0
- Seed-policy set (CinemaZ, 61d protected): 0 (all 16 already compliant)
- Seed-policy set (minimal, reaped): 1 (El, since removed by global policy)
- Reaped from qBit (deleteFiles=false): 0