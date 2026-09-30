/**
 * Builds the static catalog used by the app (lib/mediaCache.js):
 * the TARGET most popular Japanese manga and anime from AniList.
 *
 * Canonical copy lives in the jeremy-hb/kinetic_data repo, where a weekly
 * GitHub Action regenerates and publishes manga.json / anime.json.
 *
 *   node scripts/fetch-anilist.js            # writes scripts/output/*.json
 *   OUTPUT_DIR=. TARGET=5000 node fetch-anilist.js
 *
 * Requires Node 18+ (global fetch).
 */
const fs = require('fs');
const path = require('path');

const TARGET = Number(process.env.TARGET ?? 5000);
const OUTPUT_DIR = process.env.OUTPUT_DIR ?? path.join(__dirname, 'output');
// AniList allows 90 req/min but drops to 30 when degraded: stay under that.
const DELAY = 2100;
const MAX_DESCRIPTION = 600;
const MAX_TAGS = 10;

const QUERY = `
  query ($page: Int, $type: MediaType) {
    Page(page: $page, perPage: 50) {
      pageInfo { hasNextPage }
      media(
        type: $type,
        sort: POPULARITY_DESC,
        isAdult: false,
        countryOfOrigin: "JP"
      ) {
        id
        title { romaji english }
        coverImage { extraLarge large }
        genres
        startDate { year month day }
        status
        averageScore
        popularity
        description(asHtml: false)
        chapters
        volumes
        episodes
        duration
        tags { name rank isMediaSpoiler }
      }
    }
  }
`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Cut at a sentence end when possible so synopses don't stop mid-word. */
function shorten(text) {
  if (!text || text.length <= MAX_DESCRIPTION) return text;
  const cut = text.slice(0, MAX_DESCRIPTION);
  const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('.<br>'), cut.lastIndexOf('.\n'));
  return lastStop > MAX_DESCRIPTION * 0.5 ? cut.slice(0, lastStop + 1) : `${cut.trimEnd()}…`;
}

/** Keep only what the app reads: spoiler tags dropped, top tags by rank. */
function slim(media) {
  return {
    ...media,
    description: shorten(media.description),
    tags: (media.tags ?? [])
      .filter((t) => !t.isMediaSpoiler)
      .sort((a, b) => (b.rank ?? 0) - (a.rank ?? 0))
      .slice(0, MAX_TAGS)
      .map(({ name, rank }) => ({ name, rank })),
  };
}

async function fetchPage(page, type) {
  for (let attempt = 1; attempt <= 8; attempt++) {
    const res = await fetch('https://graphql.anilist.co', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query: QUERY, variables: { page, type } }),
    });

    if (res.status === 429) {
      const wait = Number(res.headers.get('retry-after') ?? 60);
      console.warn(`Rate limited on page ${page}, waiting ${wait}s...`);
      await sleep(wait * 1000 + 500);
      continue;
    }

    const json = await res.json().catch(() => null);
    if (res.ok && json && !json.errors) return json.data.Page;

    console.warn(`Error on page ${page} (attempt ${attempt}):`, json?.errors ?? res.status);
    await sleep(5000 * attempt);
  }
  throw new Error(`Page ${page} of ${type} failed after 8 attempts`);
}

async function fetchType(type) {
  const byId = new Map();
  let page = 1;
  let hasNextPage = true;
  const totalPages = Math.ceil(TARGET / 50);

  while (byId.size < TARGET && hasNextPage) {
    console.log(`${type} page ${page}/${totalPages} (${byId.size}/${TARGET})`);
    const { media, pageInfo } = await fetchPage(page, type);
    // Popularity shifts during a long run: dedupe by id
    for (const m of media) if (!byId.has(m.id)) byId.set(m.id, slim(m));
    hasNextPage = pageInfo?.hasNextPage ?? false;
    page++;
    await sleep(DELAY);
  }

  return [...byId.values()].slice(0, TARGET);
}

async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  for (const type of ['MANGA', 'ANIME']) {
    const items = await fetchType(type);
    // Refuse to publish a truncated catalog (e.g. AniList outage)
    if (items.length < TARGET * 0.9) {
      throw new Error(`${type}: only ${items.length}/${TARGET} titles fetched, not writing`);
    }
    const file = path.join(OUTPUT_DIR, `${type.toLowerCase()}.json`);
    fs.writeFileSync(file, JSON.stringify(items));
    console.log(`✅ ${file} — ${items.length} titles, ${(fs.statSync(file).size / 1e6).toFixed(1)} MB`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
