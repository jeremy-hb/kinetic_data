/**
 * Builds the static catalog used by the app (lib/mediaCache.js), per type:
 *   1. the TARGET most popular Japanese titles on AniList (main pool),
 *   2. then extra pools, appended after it (deduped by id):
 *      - trending: what's hot right now (TRENDING_DESC)
 *      - recent:   titles started in the last two years, most popular first
 *      - gems:     well rated but below the main pool's popularity floor
 *
 * Canonical copy lives in the jeremy-hb/kinetic_data repo, where a daily
 * GitHub Action regenerates and publishes manga.json / anime.json.
 *
 *   OUTPUT_DIR=. TARGET=5000 node fetch-anilist.js
 *
 * Resilience: a page that keeps failing is skipped rather than aborting the
 * run, and the titles it held are taken back from the previous catalog. A
 * type that can't be fetched properly keeps its previous file untouched.
 * Either way the process exits with code 1 so the workflow is marked failed
 * (and GitHub emails the owner), but whatever succeeded is still written.
 *
 * Requires Node 18+ (global fetch).
 */
const fs = require('fs');
const path = require('path');

const TARGET = Number(process.env.TARGET ?? 5000);
const OUTPUT_DIR = process.env.OUTPUT_DIR ?? path.join(__dirname, 'output');
// AniList allows 90 req/min but drops to 30 when degraded: stay under that.
const DELAY = Number(process.env.FETCH_DELAY_MS ?? 2100);
const RETRY_BASE = Number(process.env.RETRY_BASE_MS ?? 5000);
const MAX_ATTEMPTS = 8;
const PER_PAGE = 50;
const MAX_DESCRIPTION = 600;
const MAX_TAGS = 10;

// Extra pools appended after the main one. `limit` is the number of titles
// requested from AniList; titles already in the catalog are skipped.
const EXTRA_POOLS = [
  { name: 'trending', limit: 300, sort: 'TRENDING_DESC' },
  {
    name: 'recent',
    limit: 500,
    sort: 'POPULARITY_DESC',
    // FuzzyDateInt: YYYYMMDD
    filters: { startDate_greater: (new Date().getUTCFullYear() - 2) * 10000, popularity_greater: 300 },
  },
  {
    name: 'gems',
    limit: 500,
    sort: 'SCORE_DESC',
    // popularity_lesser is set to the main pool's floor at run time
    filters: { averageScore_greater: 74, popularity_greater: 300 },
  },
];

const FIELDS = `
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
`;

function buildQuery(filters = {}) {
  const extra = Object.entries(filters)
    .map(([key, value]) => `${key}: ${value}`)
    .join(', ');
  return `
    query ($page: Int, $type: MediaType, $sort: [MediaSort]) {
      Page(page: $page, perPage: ${PER_PAGE}) {
        pageInfo { hasNextPage }
        media(type: $type, sort: $sort, isAdult: false, countryOfOrigin: "JP"${extra ? `, ${extra}` : ''}) {
          ${FIELDS}
        }
      }
    }
  `;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Cut at a sentence end when possible so synopses don't stop mid-word. */
function shorten(text) {
  if (!text || text.length <= MAX_DESCRIPTION) return text;
  const cut = text.slice(0, MAX_DESCRIPTION);
  const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('.<br>'), cut.lastIndexOf('.\n'));
  return lastStop > MAX_DESCRIPTION * 0.5 ? cut.slice(0, lastStop + 1) : `${cut.trimEnd()}…`;
}

/**
 * Keep only what the app reads: spoiler tags dropped, top tags by rank, one
 * cover size (the app reads extraLarge first and falls back on large).
 */
function slim(media) {
  const cover = media.coverImage?.extraLarge ?? media.coverImage?.large ?? null;
  return {
    ...media,
    coverImage: { extraLarge: cover },
    description: shorten(media.description),
    tags: (media.tags ?? [])
      .filter((t) => !t.isMediaSpoiler)
      .sort((a, b) => (b.rank ?? 0) - (a.rank ?? 0))
      .slice(0, MAX_TAGS)
      .map(({ name, rank }) => ({ name, rank })),
  };
}

/** One page, retried with backoff. Returns null (never throws) when it keeps failing. */
async function fetchPage(query, variables) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let res = null;
    let json = null;
    try {
      res = await fetch('https://graphql.anilist.co', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ query, variables }),
      });
      if (res.status === 429) {
        const wait = Number(res.headers.get('retry-after') ?? 60);
        console.warn(`Rate limited on page ${variables.page}, waiting ${wait}s...`);
        await sleep(wait * 1000 + 500);
        continue;
      }
      json = await res.json().catch(() => null);
      if (res.ok && json?.data?.Page && !json.errors) return json.data.Page;
    } catch (e) {
      // Network errors (reset, DNS, timeout) used to crash the whole run
      json = { errors: e?.message ?? String(e) };
    }
    console.warn(`Error on page ${variables.page} (attempt ${attempt}):`, json?.errors ?? res?.status);
    await sleep(Math.min(RETRY_BASE * 2 ** (attempt - 1), 60000));
  }
  return null;
}

/** Up to `limit` titles of one pool. Failed pages are counted and skipped. */
async function fetchPool(type, { name, limit, sort, filters }) {
  const query = buildQuery(filters);
  const byId = new Map();
  const totalPages = Math.ceil(limit / PER_PAGE);
  // A few pages of slack: popularity shifts during a long run (duplicates)
  const maxPages = totalPages + 5;
  let failedPages = 0;
  let consecutiveFails = 0;
  let aborted = false;
  let page = 1;
  let hasNextPage = true;

  while (byId.size < limit && hasNextPage && page <= maxPages) {
    // Several pages in a row failing means AniList is down: no point waiting
    // ~5 min of retries on each remaining page
    if (consecutiveFails >= 3) {
      console.warn(`${type} ${name}: ${consecutiveFails} pages failed in a row, giving up`);
      aborted = true;
      break;
    }
    console.log(`${type} ${name} page ${page}/${totalPages} (${byId.size}/${limit})`);
    const result = await fetchPage(query, { page, type, sort: [sort] });
    if (result) {
      for (const m of result.media) if (!byId.has(m.id)) byId.set(m.id, slim(m));
      hasNextPage = result.pageInfo?.hasNextPage ?? false;
      consecutiveFails = 0;
    } else {
      failedPages++;
      consecutiveFails++;
      console.warn(`${type} ${name}: page ${page} skipped after ${MAX_ATTEMPTS} attempts`);
    }
    page++;
    await sleep(DELAY);
  }

  return { items: [...byId.values()].slice(0, limit), failedPages, totalPages, aborted };
}

function readPrevious(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

/**
 * Main pool, completed from the previous catalog when pages were skipped.
 * Returns null when the result isn't trustworthy (keep the previous file).
 */
async function fetchMain(type, previous) {
  const { items, failedPages, totalPages, aborted } = await fetchPool(type, {
    name: 'main',
    limit: TARGET,
    sort: 'POPULARITY_DESC',
  });
  if (aborted || failedPages > totalPages * 0.1) {
    console.error(`${type}: ${failedPages}/${totalPages} pages failed`);
    return null;
  }

  let result = items;
  if (failedPages > 0 && previous.length > 0) {
    // The skipped pages held titles of the same popularity band: take them
    // back from the previous catalog (stale numbers, but better than a gap)
    const ids = new Set(items.map((m) => m.id));
    const floor = Math.min(...items.map((m) => m.popularity ?? Infinity));
    const restored = previous.filter((m) => !ids.has(m.id) && (m.popularity ?? 0) >= floor);
    console.warn(`${type}: ${restored.length} titles restored from the previous catalog`);
    result = items.concat(restored)
      .sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0))
      .slice(0, TARGET);
  }

  // Refuse to publish a truncated catalog (e.g. AniList outage)
  if (result.length < TARGET * 0.9) {
    console.error(`${type}: only ${result.length}/${TARGET} titles fetched`);
    return null;
  }
  return { items: result, degraded: failedPages > 0 };
}

async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const problems = [];

  for (const type of ['MANGA', 'ANIME']) {
    const file = path.join(OUTPUT_DIR, `${type.toLowerCase()}.json`);
    const previous = readPrevious(file);

    const main = await fetchMain(type, previous);
    if (!main) {
      problems.push(`${type}: main pool failed, previous catalog kept`);
      continue;
    }
    if (main.degraded) problems.push(`${type}: some main pages skipped`);

    const catalog = main.items;
    const ids = new Set(catalog.map((m) => m.id));
    const floor = Math.min(...catalog.map((m) => m.popularity ?? Infinity));

    for (const pool of EXTRA_POOLS) {
      const filters = pool.name === 'gems' ? { ...pool.filters, popularity_lesser: floor } : pool.filters;
      const { items, failedPages } = await fetchPool(type, { ...pool, filters });
      if (failedPages > 0) problems.push(`${type} ${pool.name}: ${failedPages} pages skipped`);
      let added = 0;
      for (const m of items) {
        if (ids.has(m.id)) continue;
        ids.add(m.id);
        catalog.push(m);
        added++;
      }
      console.log(`${type} ${pool.name}: +${added} titles`);
    }

    fs.writeFileSync(file, JSON.stringify(catalog));
    console.log(`✅ ${file} — ${catalog.length} titles, ${(fs.statSync(file).size / 1e6).toFixed(1)} MB`);
  }

  if (problems.length > 0) {
    console.error(`\n⚠️  Completed with problems:\n- ${problems.join('\n- ')}`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
