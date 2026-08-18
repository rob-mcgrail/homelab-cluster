# Triage run — 2026-07-21T02:01:00Z

**Reviewed:** 71 torrents · 23 missing movies · 9 recent prompts

## Actions taken
- **Bluey (2018) S01 FRENCH pack** — removed from Sonarr queue (52 episode entries, all at 0%) with blocklist and client deletion: French pack stalled at 0% for 21h, 0 seeders, wrong language, all 52 S01 episodes already on disk in English. Sonarr had re-grabbed this after a prior Jul 13 cleanup.
- **Grand Theft Hamlet (2024)** — triggered fresh per-movie search: 23 days monitored, never grabbed, only 1 release ever found (blocklisted VOSTFR). Search command #252972.
- **Judgment in Berlin (1988)** — triggered fresh per-movie search: 13 days monitored, 4 releases found but all rejected (DVD/SDTV/too-small). Search command #252973.
- **Scheherazade (1963)** — triggered fresh per-movie search: 10 days monitored, has a Remux-1080p (28.8GB, 13 seeds) that profile 7 blocks — RobDifficult would accept it. Worth escalating next run if still stuck. Search command #252974.
- **Wolf and Sheep (2016)** — triggered fresh per-movie search: 10 days monitored, 4 releases rejected for language/quality/seeds. Search command #252975.
- **Blind Shaft (2003)** — triggered fresh per-movie search: 10 days monitored, 153 releases found but all low-quality (DVD/480p tiers). Search command #252976.

## Considered but rejected
- **Scheherazade → RobDifficult** — at 10 days, under the 14-day threshold. The Remux-1080p would become grabbable. Flagged for next run.
- **Grand Theft Hamlet → RobDifficult** — 23 days stuck but only 1 release across all indexers (blocklisted VOSTFR), so broader quality tiers wouldn't help.
- **Judgment in Berlin → RobDifficult** — 13 days, just under 14. Available releases are DVD/SDTV — no quality tier would accept them. Worth a fresh search only.
- **The Invite / Redoubt / Rose of Nevada / The Weed Eaters** — inCinemas or zero releases across any indexer. Profile change doesn't create content that doesn't exist.
- **O.C. and Stiggs / Sucker Free City** — zero releases across all indexers at 96 and 10 days respectively. Pure indexer-coverage gaps.
- **10 already-on-RobDifficult movies** — still missing, some since April. Confirms indexer coverage is the bottleneck, not profile strictness.
- **Hotel Transylvania torrents** — all 4 at 100% complete with movies imported. Legacy `triage-first-seen` tags present but harmless. No action needed.

## Anomalies
- **7 movies with zero releases across any connected indexer** despite being released: O.C. and Stiggs, Sucker Free City, Redoubt, The Weed Eaters (inCinemas), Rose of Nevada (inCinemas), The Invite (inCinemas — only CAMs exist). Limited public-tracker and CinemaZ coverage for these titles. No path forward without additional indexers.
- **10 movies already on RobDifficult** and still missing, some since April (Atanarjuat, Black Robe, Rescue Dawn, Life Is Sweet, etc.). This reinforces that it's an indexer-coverage problem, not a profile-strictness issue, across this library.
- None of the 5 trigged searches have produced a grab yet (they were just dispatched). This may simply take time, or may confirm these titles genuinely aren't findable on connected indexers.

## Summary
- Paused: 0
- Resumed: 0
- Removed + blocklisted: 1 (52 Sonarr queue records, 1 qBit torrent)
- Priority-boosted: 0
- MissingFiles cleaned: 0
- Radarr profile switches (→ RobDifficult): 0
- Per-movie searches triggered: 5
- Override-grabs: 0