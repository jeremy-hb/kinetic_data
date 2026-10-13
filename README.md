# kinetic_data

Static catalog for the Kinetic app, one JSON array per type (`manga.json`, `anime.json`), built from [AniList](https://anilist.co) (no adult content):

1. the 5,000 most popular Japanese titles,
2. then, appended after them: the 300 trending titles, the 500 most popular titles started in the last two years, 500 "gems" (average score above 70 but less popular than the 5,000th title) and, in `manga.json` only, the 1,000 most popular Korean comics (manhwa). Titles already in the catalog are skipped. Each title carries its `countryOfOrigin` (`JP`, `KR`).

- `manga.json`, `anime.json` — read by the app from `raw.githubusercontent.com` kept on the device, which checks every 2 days whether the file changed (ETag).
- `fetch-anilist.js` — generator (Node 18+). `OUTPUT_DIR=. TARGET=5000 node fetch-anilist.js`
- `.github/workflows/refresh-catalog.yml` — regenerates and commits the files every Monday at 04:17 UTC (or manually via *Run workflow*).
- `translate_fr.py` — adds `description_fr` (French synopsis) to every title with [Opus-MT en→fr](https://huggingface.co/Helsinki-NLP/opus-mt-en-fr), a free open-source model run on the GitHub runner's CPU (no API key, no cost). Only new or changed synopses are translated; results are cached in `translations_fr.json` (AniList id → hash of the English text + French text). A run stops after `MAX_MINUTES` and saves its progress, most popular titles first. `python translate_fr.py --sample 5` prints 5 translations without writing anything.

To keep the files small: descriptions are shortened to ~600 characters, tags reduced to the 10 best-ranked non-spoiler ones, only one cover size is kept (`coverImage.extraLarge`), and the English `description` is removed once `description_fr` is there (it stays on titles without a translation).

## When something fails

A run never publishes less than it had:

- an AniList page that keeps failing (8 attempts with backoff) is skipped, and the titles it held are taken back from the previous catalog;
- after 3 failed pages in a row, more than 10% of failed pages, or fewer than 90% of the target titles, the previous file of that type is kept as it is;
- if the translation model can't run, the translations already cached are still applied.

What succeeded is committed, then the run is marked failed so GitHub sends an email. The next week's run starts over (or start one by hand with *Run workflow*).

Data © AniList contributors, used under the [AniList API terms](https://anilist.gitbook.io/anilist-apiv2-docs/overview/api-terms-of-use).
