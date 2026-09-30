/**
 * Adds a French synopsis (`description_fr`) to every title of manga.json and
 * anime.json, using Claude through the Message Batches API (50% cheaper,
 * asynchronous: fine for a weekly job).
 *
 * Only new or changed synopses are sent: translations are cached in
 * translations_fr.json, keyed by AniList id with a hash of the English text.
 * A weekly run therefore only translates the handful of titles that changed.
 *
 *   node translate-descriptions.mjs              # translate what's missing, update the JSON files
 *   node translate-descriptions.mjs --sample 5   # translate 5 synopses live and print them (no file written)
 *
 * Credentials: ANTHROPIC_API_KEY (GitHub secret in the workflow).
 */
import Anthropic from '@anthropic-ai/sdk';
import { createHash } from 'node:crypto';
import fs from 'node:fs';

const MODEL = 'claude-opus-5-5';
const FILES = ['manga.json', 'anime.json'];
const CACHE_FILE = 'translations_fr.json';
const PENDING_FILE = 'pending_batch.json';
const POLL_MS = 60_000;
const MAX_WAIT_MS = 5 * 60 * 60 * 1000; // stay under the 6h GitHub Actions job limit
const STALE_BATCH_MS = 7 * 24 * 60 * 60 * 1000;

const SYSTEM = `Tu traduis des résumés de mangas et d'animes (issus de la base AniList) de l'anglais vers le français, pour une application de découverte destinée à un public francophone.

Règles :
- Français naturel et fluide, comme un résumé d'éditeur ou la quatrième de couverture d'un manga en France. Pas de calques de l'anglais.
- Garde tels quels les noms propres : personnages, lieux, organisations, titres d'œuvres, noms de techniques ou de pouvoirs. Si un terme japonais est déjà en romaji dans le texte (ex. « shinigami », « Hunter »), garde-le.
- Supprime les balises HTML (<br>, <i>…), les mentions de source (« (Source: …) ») et les notes éditoriales (« Notes: … », informations de publication, prix remportés).
- Ne rajoute rien : pas d'information absente de l'original, pas de commentaire, pas de spoiler supplémentaire.
- Si le texte se termine par « … », garde la phrase inachevée avec « … ».
- Réponds uniquement avec la traduction, en texte brut, sans guillemets ni introduction.`;

const hashOf = (text) => createHash('sha1').update(text).digest('hex').slice(0, 12);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function paramsFor(description) {
  return {
    model: MODEL,
    // Room for the translation (~300 tokens) plus adaptive thinking
    max_tokens: 4000,
    // Translation is a routine task: low effort keeps thinking (always on for this model) short
    output_config: { effort: 'low' },
    system: SYSTEM,
    messages: [{ role: 'user', content: description }],
  };
}

/** Text of a response, or null when refused / empty. */
function translationOf(message) {
  if (!message || message.stop_reason === 'refusal') return null;
  const text = message.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
  return text || null;
}

function loadJson(file, fallback) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback;
}

async function sample(client, n) {
  const titles = FILES.flatMap((f) => loadJson(f, [])).filter((m) => m.description);
  const picked = titles.sort(() => Math.random() - 0.5).slice(0, n);
  for (const m of picked) {
    const message = await client.messages.create(paramsFor(m.description));
    const fr = translationOf(message);
    console.log(`\n━━ ${m.title.english || m.title.romaji}`);
    console.log(`EN: ${m.description}`);
    console.log(`FR: ${fr ?? `(pas de traduction : ${message.stop_reason})`}`);
    console.log(`   tokens: ${message.usage.input_tokens} in / ${message.usage.output_tokens} out`);
  }
}

/**
 * Submits (or resumes) a batch and waits for it until MAX_WAIT_MS.
 * A batch can take up to 24h but a CI job is capped at 6h: past the deadline
 * its id is saved to PENDING_FILE and the next run collects its results
 * instead of paying for the same translations twice.
 * Returns Map<id, { fr, h }> where h is the hash of the English text that
 * was actually sent (it may be older than the current one on a resume),
 * or null when still running.
 */
async function runBatch(client, pending) {
  let saved = loadJson(PENDING_FILE, null);
  // Batch results are kept 29 days: an older (or stuck) batch is abandoned
  if (saved && Date.now() - Date.parse(saved.createdAt) > STALE_BATCH_MS) {
    console.log(`Abandoning stale batch ${saved.id}`);
    saved = null;
  }
  let batchId = saved?.id;
  let sentHashes = saved?.hashes ?? {};
  if (batchId) {
    console.log(`Resuming batch ${batchId} from a previous run`);
  } else {
    const batch = await client.messages.batches.create({
      requests: pending.map(({ id, description }) => ({
        custom_id: String(id),
        params: paramsFor(description),
      })),
    });
    batchId = batch.id;
    sentHashes = Object.fromEntries(pending.map(({ id, h }) => [id, h]));
    fs.writeFileSync(PENDING_FILE, JSON.stringify({ id: batchId, createdAt: new Date().toISOString(), hashes: sentHashes }));
    console.log(`Batch ${batchId}: ${pending.length} synopses submitted`);
  }

  const deadline = Date.now() + MAX_WAIT_MS;
  let status;
  try {
    status = await client.messages.batches.retrieve(batchId);
  } catch (e) {
    // Saved batch unknown to the API: forget it so the next run starts fresh
    if (e instanceof Anthropic.NotFoundError) fs.rmSync(PENDING_FILE, { force: true });
    throw e;
  }
  while (status.processing_status !== 'ended') {
    if (Date.now() > deadline) {
      console.log(`Batch ${batchId} still running: results will be collected next run`);
      return null;
    }
    await sleep(POLL_MS);
    status = await client.messages.batches.retrieve(batchId);
    const c = status.request_counts;
    console.log(`  ${status.processing_status} — processing ${c.processing}, ok ${c.succeeded}, errors ${c.errored}`);
  }

  // Results come back in any order: key them by custom_id
  const translations = new Map();
  const failures = {};
  for await (const result of await client.messages.batches.results(batchId)) {
    if (result.result.type === 'succeeded') {
      const message = result.result.message;
      const fr = translationOf(message);
      const h = sentHashes[result.custom_id];
      if (fr && h) {
        translations.set(Number(result.custom_id), { fr, h });
      } else if (message.stop_reason === 'refusal' && h) {
        // Same text, same answer: remember it instead of paying again every week
        translations.set(Number(result.custom_id), { fr: null, h });
        failures.refused = (failures.refused ?? 0) + 1;
      } else {
        failures.empty = (failures.empty ?? 0) + 1;
      }
    } else {
      failures[result.result.type] = (failures[result.result.type] ?? 0) + 1;
    }
  }
  if (Object.keys(failures).length) {
    // Refusals stay in English until the text changes; the rest is retried next run
    console.log('Not translated (kept in English):', failures);
  }
  fs.rmSync(PENDING_FILE, { force: true });
  return translations;
}

async function main() {
  const client = new Anthropic();

  const sampleIdx = process.argv.indexOf('--sample');
  if (sampleIdx !== -1) {
    await sample(client, Number(process.argv[sampleIdx + 1] ?? 5));
    return;
  }

  const catalogs = Object.fromEntries(FILES.map((f) => [f, loadJson(f, [])]));
  const cache = loadJson(CACHE_FILE, {});

  // Synopses with no translation for their current English text
  const pending = new Map();
  for (const items of Object.values(catalogs)) {
    for (const m of items) {
      if (!m.description) continue;
      const h = hashOf(m.description);
      if (cache[m.id]?.h !== h) pending.set(m.id, { id: m.id, description: m.description, h });
    }
  }
  console.log(`${pending.size} synopses to translate`);

  // A failed batch must not cost last week's translations: the freshly
  // fetched catalog has none, so the cache is applied whatever happens here.
  let failed = false;
  if (pending.size > 0) {
    try {
      const translations = await runBatch(client, [...pending.values()]);
      if (translations) {
        // Cached under the hash of the text that was sent: if the synopsis
        // changed since (resumed batch), the apply step skips it and the
        // next run retranslates the new text
        const currentHash = new Map([...pending.values()].map((p) => [p.id, p.h]));
        for (const [id, entry] of translations) {
          // Never replace a translation that matches the current text
          if (cache[id] && cache[id].h !== entry.h && !currentHash.has(id)) continue;
          cache[id] = entry;
        }
        console.log(`${translations.size} translated`);
      }
    } catch (e) {
      failed = true;
      reportError(e);
      console.error('Translation skipped this run; applying cached translations only.');
    }
  }

  // Apply, and drop cache entries for titles no longer in the catalog
  const live = new Set();
  let applied = 0;
  for (const [file, items] of Object.entries(catalogs)) {
    for (const m of items) {
      live.add(String(m.id));
      const entry = m.description && cache[m.id];
      if (entry?.fr && entry.h === hashOf(m.description)) {
        m.description_fr = entry.fr;
        applied++;
      } else {
        delete m.description_fr;
      }
    }
    fs.writeFileSync(file, JSON.stringify(items));
  }
  for (const id of Object.keys(cache)) if (!live.has(id)) delete cache[id];
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));

  console.log(`✅ ${applied} titles now have a French synopsis`);
  // Files are consistent either way; a non-zero exit flags the run in GitHub Actions
  if (failed) process.exitCode = 1;
}

function reportError(e) {
  if (e instanceof Anthropic.AuthenticationError) {
    console.error('Invalid or missing ANTHROPIC_API_KEY');
  } else if (e instanceof Anthropic.RateLimitError) {
    console.error('Rate limited by the Anthropic API, try again later');
  } else if (e instanceof Anthropic.APIError) {
    console.error(`Anthropic API error ${e.status}:`, e.message);
  } else {
    console.error(e);
  }
}

main().catch((e) => {
  reportError(e);
  process.exit(1);
});
