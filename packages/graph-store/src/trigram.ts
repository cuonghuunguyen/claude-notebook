/**
 * `pg_trgm`'s `word_similarity`, recomputed in JS.
 *
 * ## Why this is not FTS5's trigram tokenizer
 *
 * spec.md §25.3's table proposes `tokenize='trigram'` for this leg. That is a
 * *substring matcher*, and the leg it would replace is a *scorer* with a
 * threshold — a different function, and this one turned out to be load-bearing.
 * Measured on M17's own baseline (the same corpus and questions
 * `BENCHMARKS.md` scores, on Postgres, before any code moved): removing the
 * trigram leg from the fusion drops by-meaning MRR from **0.85 to 0.75**, and
 * it decides the top-ranked hit on three of the ten questions. It is also
 * extremely narrow — at the 0.35 threshold it returns 0 to 3 hits out of 142
 * memories per question, so it is precision, not recall, that the fused
 * ranking is buying from it.
 *
 * An FTS5 trigram leg would have returned a different (much larger, unranked
 * by similarity) candidate set, and the gate spec.md §25.5 sets is that
 * retrieval quality must not move. So the function is reproduced instead of
 * approximated, and the deviation is flagged rather than absorbed.
 *
 * ## Why a full scan is affordable
 *
 * Exactly the argument §25.1 already accepted for the vector leg: the corpus is
 * hundreds-to-thousands of memories, and the extent search below is bounded by
 * the threshold (see `wordSimilarity`), so scoring the whole corpus is a few
 * milliseconds. §25.7's scale ceiling applies here for the same reason it
 * applies there.
 *
 * ## The semantics, pinned against the real thing
 *
 * `src/__fixtures__/pgTrgmWordSimilarity.json` holds 70 (query, text, score)
 * triples produced by `word_similarity()` on a live Postgres 16 with pg_trgm —
 * 40 synthetic cases covering normalization, padding, duplicates, word order
 * and extent boundaries, and 30 real (question, memory text) pairs from the
 * M17 baseline corpus whose scores straddle the 0.35 threshold (0.257 to
 * 0.605). `trigram.test.ts` asserts this implementation against all of them, so
 * the claim "same scores" is checkable rather than asserted.
 *
 * What that fixture pinned down:
 *
 *  - Normalization is lowercase, and every non-alphanumeric character is a word
 *    separator — including `_` (`show_trgm('a1_b')` is `{"  a","  b"," a1",
 *    " b ","a1 "}`, two words, not one).
 *  - A word of length n contributes n+1 trigrams, taken from `"  " + word + " "`.
 *    So a one-character word still contributes two.
 *  - Trigrams are a *set* per string, and a *set* per extent: `word_similarity
 *    ('cat', 'cat cat')` is 1, not 0.5.
 *  - An extent is any contiguous run of the target's trigram sequence, and the
 *    sequence is the words' trigrams concatenated in document order. Extents do
 *    not have to respect word boundaries (that is `strict_word_similarity`), and
 *    order inside an extent does not matter — `word_similarity('cat dog',
 *    'dog cat')` is 1.
 *  - The score is Jaccard: |Q ∩ E| / (|Q| + |E| − |Q ∩ E|).
 *
 * ## The one place this and pg_trgm disagree, and by how much
 *
 * pg_trgm's C implementation does not actually search every extent: it slides a
 * two-pointer window and only advances the left edge when doing so does not cost
 * it a matched trigram, which is a greedy approximation of the maximum its own
 * documentation describes. This computes the documented maximum, so it is
 * always >= pg_trgm's answer and occasionally larger.
 *
 * Quantified, not hand-waved. Over the full cross product of M17's gate corpus
 * — all 10 `eval/why-spike` questions against all 142 mined memories, 1,420
 * pairs, pg values read straight out of Postgres — 1,386 agree exactly, 34
 * differ, the largest difference is **0.0073**, and **no pair crosses the 0.35
 * threshold**. The trigram leg returns the same hits in the same order for
 * every one of the ten questions. The fixture keeps the one divergent case
 * (marked `greedyDivergence`) rather than dropping it, so the difference stays
 * visible instead of being tuned away.
 *
 * One further deliberate difference: pg_trgm hashes non-ASCII trigrams to 3
 * bytes (`show_trgm('éé')` returns hex blobs), so distinct multibyte trigrams
 * can collide there. This keeps them as strings, which is strictly more
 * precise. It cannot change an all-ASCII score, and this corpus's text is
 * English prose and code identifiers.
 */

/**
 * Lowercased maximal runs of alphanumeric characters — pg_trgm's
 * KEEPONLYALNUM, which treats every other character (including `_`) as a word
 * separator. Unicode letters and digits count as alphanumeric, matching
 * pg_trgm's locale-aware `t_isalpha` / `t_isdigit`.
 */
function words(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 0);
}

/**
 * The target's trigrams as an ordered sequence (duplicates kept — position is
 * what an extent is defined over).
 */
export function trigramSequence(value: string): string[] {
  const out: string[] = [];
  for (const word of words(value)) {
    const padded = `  ${word} `;
    for (let i = 0; i + 3 <= padded.length; i += 1) out.push(padded.slice(i, i + 3));
  }
  return out;
}

/** The query's trigrams as a set — `show_trgm` order is irrelevant to Jaccard. */
export function trigramSet(value: string): Set<string> {
  return new Set(trigramSequence(value));
}

/**
 * `word_similarity(query, target)`.
 *
 * The maximum is searched only over extents that *start* at a matching
 * trigram: an extent whose first trigram is not in the query can be trimmed
 * from the left without losing any intersection, which strictly raises the
 * score, so no such extent is ever the maximum.
 *
 * ## The three bounds that keep an exhaustive search affordable
 *
 * All three are exact with respect to what the caller asked for: they prune
 * extents that provably cannot exceed a floor, never extents that might.
 *
 * 1. **Ratio, capped by saturation.** An extent's intersection is capped by both
 *    the query size `q` and `saturation` — the number of query trigrams that
 *    occur in this target at all. So no extent *longer* than the current one can
 *    score above `saturation / (q + u' - saturation)` where
 *    `u' = max(u, saturation)`, and that expression only falls as `u` grows.
 *
 *    The `max` is the whole correctness of this bound, and getting it wrong is
 *    instructive: with `min(u, saturation)` the expression reads `u / q` while
 *    `u < saturation`, which *rises* with `u` rather than falling, so it is not a
 *    valid bound on the future at all — it fires on the first iteration of every
 *    extent and the function returns `1 / q` for everything. That version passed
 *    the performance test and failed all 1,420 pg-comparison pairs, which is why
 *    both tests exist.
 *
 *    Tightened this way the bound subsumes the plain `min(q, u) / max(q, u)`
 *    ratio (they coincide when every query trigram is present) and is
 *    dramatically tighter when the target shares only part of the query, which is
 *    the common case: at `q = 45`, `saturation = 16` and a 0.35 floor it stops
 *    after 17 distinct trigrams where the plain ratio bound would have walked
 *    128.
 *
 * 2. **Saturation reached.** Once the extent contains every query trigram that
 *    occurs in the target at all, the intersection can no longer grow while `u`
 *    still can, so the score is non-increasing from there.
 *
 * 3. **`minScore`.** The caller's threshold, used as a floor for bound 1 before
 *    any score has been found. Solving `inter/(q + u - inter) >= t` with
 *    `inter <= q` gives `u <= q / t`, so at a 0.35 threshold no extent with more
 *    than ~3x the query's trigram count can qualify, whatever the text says.
 *
 * Bounds 1 and 2 are each individually insufficient, and the way they fail is
 * worth recording because both failures were measured rather than reasoned
 * about:
 *
 *  - Bound 1 can NEVER fire on repetitive text, because `u` is capped by the
 *    document's own distinct-trigram count. A body of 400 repeated sentences has
 *    ~45 distinct trigrams, so `u` never reaches a limit expressed in multiples
 *    of `q`, and every start position walks to the end of the document: 1.9 s
 *    for a single memory.
 *  - Bound 2 does not fire on long *non*-repetitive prose, where reaching every
 *    query trigram means crossing most of the body. With bounds 1 and 2 only,
 *    the leg measured **3.9 s per question** over a 142-memory corpus — against
 *    9 ms for the indexed full-text leg. With `minScore` it is single-digit
 *    milliseconds.
 *
 * `minScore` is the one bound that makes the result conditional, so it is
 * explicit rather than a default: with `minScore > 0`, any value this returns
 * *at or above* `minScore` is exact, and anything below it is only known to be
 * below it. That is exactly what a thresholded leg needs and nothing more, which
 * is why the unit tests — which check equality against pg_trgm — call it without
 * one.
 */
export function wordSimilarity(query: string, target: string, minScore = 0): number {
  const q = trigramSet(query);
  if (q.size === 0) return 0;
  const sequence = trigramSequence(target);
  if (sequence.length === 0) return 0;

  // Interning: the inner loop runs tens of thousands of times per document, and
  // a `Set<string>` per start position was allocating (and hashing) far more
  // than the comparison itself cost. Each distinct trigram of the target gets an
  // integer id once, and membership becomes an array index.
  //
  // `stamp` holds the start position that last touched each id, so "have I seen
  // this trigram inside the current extent" is one comparison and the state
  // needs no clearing between start positions.
  const ids = new Map<string, number>();
  const sequenceIds = new Int32Array(sequence.length);
  const isQueryTrigram: boolean[] = [];
  for (let i = 0; i < sequence.length; i += 1) {
    const trigram = sequence[i] as string;
    let id = ids.get(trigram);
    if (id === undefined) {
      id = ids.size;
      ids.set(trigram, id);
      isQueryTrigram.push(q.has(trigram));
    }
    sequenceIds[i] = id;
  }

  // The query trigrams that occur in this target at all — the ceiling on any
  // extent's intersection, and therefore on the whole target's score.
  let saturation = 0;
  for (const present of isQueryTrigram) if (present) saturation += 1;
  if (saturation === 0) return 0;
  // Document-level early out. The best conceivable extent contains exactly the
  // `saturation` query trigrams and nothing else, scoring `saturation / q`. If
  // that is already below the caller's floor, no extent in this target can
  // qualify and the search is skipped entirely.
  if (saturation / q.size < minScore) return 0;

  const stamp = new Int32Array(ids.size).fill(-1);
  let best = 0;
  for (let start = 0; start < sequence.length; start += 1) {
    if (!isQueryTrigram[sequenceIds[start] as number]) continue;
    let distinct = 0;
    let intersection = 0;
    for (let end = start; end < sequence.length; end += 1) {
      const id = sequenceIds[end] as number;
      if (stamp[id] !== start) {
        stamp[id] = start;
        distinct += 1;
        if (isQueryTrigram[id]) intersection += 1;
      }
      const score = intersection / (q.size + distinct - intersection);
      if (score > best) best = score;
      if (intersection === saturation) break;
      const reachable = distinct > saturation ? distinct : saturation;
      const bound = saturation / (q.size + reachable - saturation);
      // Two floors, two comparisons, and the difference is not pedantry.
      //
      // Against `best` the test is `<=`: an extent that can only TIE the best
      // score found so far cannot change the maximum, so pruning it is free.
      //
      // Against `minScore` it must be strict. While `distinct <= saturation`
      // the bound collapses to `saturation / q.size`, which is not an
      // over-estimate but the *attainable* supremum — an extent consisting of
      // exactly the target's query trigrams scores precisely that. So `<=`
      // there prunes an extent whose true score EQUALS the caller's threshold,
      // and `searchExperiencesByTrigram` keeps `score >= threshold` (as
      // pg_trgm's `<%` does). Measured: `wordSimilarity("parser loader config",
      // "parser")` is 0.35 exactly, and with `<=` the floored call returned
      // 0.05 — a hit Postgres returns and this leg silently dropped.
      if (bound <= best || bound < minScore) break;
    }
  }
  return best;
}
