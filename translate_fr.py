"""
Adds a French synopsis (`description_fr`) to every title of manga.json and
anime.json with Opus-MT (Helsinki-NLP/opus-mt-en-fr), an open-source
translation model that runs locally on CPU: free, no API key.

Only new or changed synopses are translated: results are cached in
translations_fr.json, keyed by AniList id with a hash of the English text,
so a weekly run only handles the few titles that changed.

Long runs are safe to interrupt: the cache is saved every CHECKPOINT titles
and the run stops after MAX_MINUTES; the next run picks up where it left off.
Titles are handled in catalog order (most popular first).

    python translate_fr.py              # translate what's missing, update the JSON files
    python translate_fr.py --sample 5   # print 5 translations, write nothing

Requires: torch (CPU), transformers, sentencepiece, sacremoses.
"""
import hashlib
import html
import json
import os
import random
import re
import sys
import time

MODEL = "Helsinki-NLP/opus-mt-en-fr"
FILES = ["manga.json", "anime.json"]
CACHE_FILE = "translations_fr.json"
BATCH_SIZE = 16          # sentences per forward pass
CHECKPOINT = 200         # titles between cache saves
MAX_MINUTES = float(os.environ.get("MAX_MINUTES", 300))  # stay under the 6h CI job limit


def hash_of(text):
    """Same scheme as before (sha1, 12 hex chars) so existing caches stay valid."""
    return hashlib.sha1(text.encode("utf-8")).hexdigest()[:12]


def clean(text):
    """AniList synopsis → plain paragraphs, without source credits or notes."""
    text = re.sub(r"<br\s*/?>", "\n", text, flags=re.I)
    text = re.sub(r"<[^>]+>", "", text)
    text = html.unescape(text)
    text = re.sub(r"\((Source|Sources)\s*:[^)]*\)", "", text, flags=re.I)
    text = re.sub(r"\[(Written by|Source)[^\]]*\]", "", text, flags=re.I)
    text = re.split(r"\n\s*(Notes?|Note from|Source)\s*:", text, flags=re.I)[0]
    paragraphs = [re.sub(r"\s+", " ", p).strip() for p in text.split("\n")]
    return [p for p in paragraphs if p]


# Split after . ! ? … when the next sentence starts with a capital or a quote
SENTENCE_END = re.compile(r"(?<=[.!?…])\s+(?=[\"“'(\[A-Z0-9])")


def split_sentences(paragraph):
    return [s for s in SENTENCE_END.split(paragraph) if s.strip()]


def fix_typography(text):
    """
    French spacing: an existing space before ; : ! ? » (and after «) becomes a
    narrow no-break space so the punctuation never wraps alone. Never adds
    one where there was none ("Re:ZERO", "10:30" stay intact).
    """
    text = re.sub(r" ([;:!?»])", " \\1", text)
    text = text.replace("« ", "« ")
    return text.replace("...", "…")


class Translator:
    def __init__(self):
        import torch
        from transformers import MarianMTModel, MarianTokenizer

        torch.set_num_threads(os.cpu_count() or 4)
        self.torch = torch
        self.tokenizer = MarianTokenizer.from_pretrained(MODEL)
        self.model = MarianMTModel.from_pretrained(MODEL).eval()

    def sentences(self, sentences):
        out = []
        for i in range(0, len(sentences), BATCH_SIZE):
            chunk = sentences[i:i + BATCH_SIZE]
            batch = self.tokenizer(chunk, return_tensors="pt", padding=True, truncation=True, max_length=512)
            with self.torch.inference_mode():
                generated = self.model.generate(**batch, num_beams=4, max_new_tokens=400)
            out.extend(self.tokenizer.batch_decode(generated, skip_special_tokens=True))
        return out

    def synopsis(self, description):
        paragraphs = clean(description)
        if not paragraphs:
            return None
        # One pass over every sentence of the synopsis, then reassemble paragraphs
        split = [split_sentences(p) for p in paragraphs]
        flat = self.sentences([s for sentences in split for s in sentences])
        result, k = [], 0
        for sentences in split:
            result.append(" ".join(flat[k:k + len(sentences)]))
            k += len(sentences)
        fr = fix_typography("\n\n".join(result)).strip()
        # The catalog cuts long synopses with "…": keep that visible
        if description.rstrip().endswith("…") and not fr.endswith("…"):
            fr = fr.rstrip(".") + "…"
        return fr or None


def load_json(path, fallback):
    if not os.path.exists(path):
        return fallback
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def save_json(path, data):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))


def sample(n):
    titles = [m for f in FILES for m in load_json(f, []) if m.get("description")]
    translator = Translator()
    for m in random.sample(titles, n):
        start = time.time()
        fr = translator.synopsis(m["description"])
        print(f"\n━━ {m['title'].get('english') or m['title'].get('romaji')}  ({time.time() - start:.1f}s)")
        print("EN:", " ".join(clean(m["description"])))
        print("FR:", fr)


def main():
    if "--sample" in sys.argv:
        idx = sys.argv.index("--sample")
        sample(int(sys.argv[idx + 1]) if idx + 1 < len(sys.argv) else 5)
        return

    catalogs = {f: load_json(f, []) for f in FILES}
    cache = load_json(CACHE_FILE, {})

    # Synopses with no translation for their current English text, most popular first
    ordered = sorted(
        (m for items in catalogs.values() for m in items if m.get("description")),
        key=lambda m: -(m.get("popularity") or 0),
    )
    pending = [m for m in ordered if cache.get(str(m["id"]), {}).get("h") != hash_of(m["description"])]
    print(f"{len(pending)} synopses to translate")

    translated = 0
    if pending:
        translator = Translator()
        deadline = time.time() + MAX_MINUTES * 60
        started = time.time()
        for i, m in enumerate(pending, 1):
            if time.time() > deadline:
                print(f"Time budget reached: {len(pending) - i + 1} left for the next run")
                break
            try:
                fr = translator.synopsis(m["description"])
            except Exception as e:  # one bad synopsis must not stop the run
                print(f"  skipped {m['id']}: {e}")
                continue
            cache[str(m["id"])] = {"h": hash_of(m["description"]), "fr": fr}
            translated += 1
            if i % CHECKPOINT == 0:
                save_json(CACHE_FILE, cache)
                rate = i / (time.time() - started)
                print(f"  {i}/{len(pending)} — {rate:.1f}/s, ~{(len(pending) - i) / rate / 60:.0f} min left")
        save_json(CACHE_FILE, cache)
    print(f"{translated} translated")

    # Apply, and drop cache entries for titles no longer in the catalog
    live, applied = set(), 0
    for path, items in catalogs.items():
        for m in items:
            live.add(str(m["id"]))
            entry = cache.get(str(m["id"])) if m.get("description") else None
            if entry and entry.get("fr") and entry["h"] == hash_of(m["description"]):
                m["description_fr"] = entry["fr"]
                applied += 1
            else:
                m.pop("description_fr", None)
        save_json(path, items)
    for key in [k for k in cache if k not in live]:
        del cache[key]
    save_json(CACHE_FILE, cache)

    print(f"✅ {applied} titles now have a French synopsis")


if __name__ == "__main__":
    main()
