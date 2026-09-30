# kinetic_data

Static catalog for the AniSwipe app: the 5,000 most popular Japanese manga and anime on [AniList](https://anilist.co), one JSON array per type.

- `manga.json`, `anime.json` — read by the app from `raw.githubusercontent.com` and cached on the device for 7 days.
- `fetch-anilist.js` — generator (Node 18+). `OUTPUT_DIR=. TARGET=5000 node fetch-anilist.js`
- `.github/workflows/refresh-catalog.yml` — regenerates and commits the files every Monday at 04:00 UTC (or manually via *Run workflow*).

Descriptions are shortened to ~600 characters and tags reduced to the 10 best-ranked non-spoiler ones to keep the files small. The script refuses to write a catalog with fewer than 90% of the target titles.

Data © AniList contributors, used under the [AniList API terms](https://anilist.gitbook.io/anilist-apiv2-docs/overview/api-terms-of-use).
