/**
 * Wiki-first retrieval — the curated search over the knowledge layer.
 *
 * The point (see the goals-dojo diagnosis): agents grep the raw event log
 * instead of the wiki because grep is the cheap, mechanical path. This makes
 * the cheap path the *correct* one — a single search over the curated corpus
 * (default `all`: wiki + unconsolidated memories + task comments + the human
 * conversation), never the raw log. An all-scope empty therefore means
 * "definitively not in the dojo's memory" (lexically — for the query's terms),
 * which is what kills the grep-the-log hedge.
 *
 * Ranking is field-boosted BM25 + fuzzy via MiniSearch (zero-dependency,
 * fully in-process — no data ever leaves the machine). Location beats
 * density: a hit in a page's title/description outranks a hit buried in the
 * body, because the page that's *about* a topic names it up top.
 */

import MiniSearch from 'minisearch'

/** Where a document came from — also the `scope` values, minus `all`. */
export type SearchSource = 'wiki' | 'memory' | 'task' | 'channel'

/** A single indexable unit. Sources adapt their content into this shape. */
export type SearchDoc = {
  /** Stable unique id (page name, `mem-<eventId>`, `task-<id>-<n>`, …). */
  id: string
  source: SearchSource
  /** Owning container shown to the agent (page name, task id, "channel"). */
  page: string
  /** Short label used for the highest-boost field (usually the page name). */
  title: string
  /** Frontmatter description / one-line summary — carried on every hit so a
   *  result immediately says "this hit lives on page X, which is about Y." */
  description: string
  /** Concatenated headings — mid-tier boost. */
  headings: string
  /** Full text — lowest boost. */
  body: string
}

export type SearchHit = {
  id: string
  source: SearchSource
  page: string
  /** The owning page/source description — the "header summary" on every hit. */
  description: string
  score: number
  /** A window of body text around the match, for at-a-glance relevance. */
  snippet: string
  /** Which of the query's terms this hit actually matched — lets the reader
   *  judge a borderline hit fast ("matched only 'lines' of 4" = probably not it). */
  matchedTerms: string[]
}

export type SearchResult = {
  query: string
  scope: string
  /** Total matches before the top-N cut — surfaced so truncation is never silent. */
  total: number
  returned: number
  /** True when nothing matched — "definitively not in [scope]" (lexically). */
  empty: boolean
  hits: SearchHit[]
}

const FIELDS = ['title', 'description', 'headings', 'body']

// Common words carry no topical signal — without filtering them, "what is my
// car" floods with high-score noise (the "what/is/my" match every page) even
// when the knowledge layer has nothing about cars, breaking empty-is-
// definitive. Dropped at BOTH index and query time via processTerm.
const STOPWORDS = new Set([
  'a',
  'an',
  'the',
  'and',
  'or',
  'but',
  'if',
  'of',
  'at',
  'by',
  'for',
  'with',
  'about',
  'to',
  'from',
  'in',
  'on',
  'out',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'am',
  'do',
  'does',
  'did',
  'have',
  'has',
  'had',
  'i',
  'me',
  'my',
  'we',
  'our',
  'you',
  'your',
  'it',
  'its',
  'this',
  'that',
  'these',
  'those',
  'he',
  'she',
  'they',
  'them',
  'what',
  'which',
  'who',
  'whom',
  'when',
  'where',
  'why',
  'how',
  'not',
  'no',
  'so',
  'as',
  'than',
  'too',
  'can',
  'will',
  'would',
  'should',
  'could',
  'get',
  'got',
])

/** Lowercase and drop stopwords, at both index and search time. Returning a
 *  falsy value removes the term (MiniSearch contract). */
function processTerm(term: string): string | null {
  const t = term.toLowerCase()
  return STOPWORDS.has(t) ? null : t
}

// Location weighting: title/description ≫ headings ≫ body. This is the
// principled version of "the page that's about X names X up top" — a common
// term self-cancels via BM25's IDF, and a distinctive term in the description
// wins over the same term sprinkled through a long body.
const BOOST = { title: 4, description: 4, headings: 2, body: 1 }

const DEFAULT_TOP_N = 5

// Upper bound on returned hits. The curated corpus is small (KB–MB), so a
// caller asking for thousands is a mistake, not a need — and this is the clamp
// point for hostile/garbage topN (negative, fractional, NaN) that otherwise
// reached slice()/Math.min and produced nonsense response shapes (returned:-1,
// slice(0,-1)). Non-integer/<1/NaN falls back to the default rather than erroring.
const MAX_TOP_N = 50
function clampTopN(v: number | undefined): number {
  if (v === undefined) return DEFAULT_TOP_N
  const n = Math.floor(v)
  return Number.isFinite(n) && n >= 1 ? Math.min(n, MAX_TOP_N) : DEFAULT_TOP_N
}

// A hit must cover at least this fraction of the query's total IDF weight.
// Tuned on a sensei's QA: 0.5 makes "coastal sailing certification course"
// empty (sailing's high absent-term weight isn't covered) while keeping
// all-discriminating and full-match queries.
const COVERAGE_FRACTION = 0.5

// Source priority — applied as a score multiplier so that in the `all` scope
// the wiki (the authoritative, distilled layer that tasks/channel get
// consolidated INTO) ranks above raw sources. Uniform within a single scope,
// so it only re-orders when sources are mixed.
const SOURCE_WEIGHT: Record<SearchSource, number> = { wiki: 1.5, memory: 1.2, task: 1.0, channel: 0.8 }

/** Build an in-memory index over a set of docs. Cheap enough to build on
 *  demand per query at the wiki's scale (KB–MB); no persistence needed until
 *  thousands of pages, at which point the librarian can build it. */
export function buildIndex(docs: SearchDoc[]): MiniSearch<SearchDoc> {
  const mini = new MiniSearch<SearchDoc>({
    fields: FIELDS,
    storeFields: ['source', 'page', 'description', 'body'],
    processTerm,
    searchOptions: {
      boost: BOOST,
      // Fuzzy tolerates typos, but a ratio alone (0.2 × len) gets too loose on
      // long tokens — a 14-char garbage query matched a real token at 3 edits,
      // producing a spurious low-score hit that breaks "empty = definitive".
      // Cap the edit distance: ≤3 chars none, ≤6 one, longer at most two.
      fuzzy: (term) => (term.length <= 3 ? false : term.length <= 6 ? 1 : 2),
      // Prefix-match only reasonably long terms: "car" must NOT prefix-match
      // "career"/"carbs" (that flooded a no-answer query with noise), while
      // longer terms still benefit. Plurals/typos are covered by capped fuzzy.
      prefix: (term) => term.length >= 5,
    },
  })
  mini.addAll(docs)
  return mini
}

/** The query's DISTINCT terms after the same processing the index uses
 *  (lowercased, stopwords dropped). Deduped — otherwise "alpha alpha beta"
 *  would let an alpha-only doc clear the coverage floor by double-counting. */
function queryTerms(q: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of q.split(/[^\p{L}\p{N}]+/u)) {
    const t = processTerm(raw)
    if (t && !seen.has(t)) {
      seen.add(t)
      out.push(t)
    }
  }
  return out
}

/** Search the index; return ranked top-N hits plus the honest total.
 *
 *  Coverage floor (from a sensei's QA): MiniSearch OR-matches, so a
 *  multi-word query like "Telefone retention three lines" otherwise returns
 *  every doc touching ANY term (65 of them, most matching one incidental word)
 *  — which floods the total and breaks "empty = definitive". Require each hit
 *  to match at least half the query's terms; an absent topic whose terms only
 *  match incidentally then drops to empty, as it should. */
export function search(
  index: MiniSearch<SearchDoc>,
  query: string,
  opts: { topN?: number; scope?: string } = {},
): SearchResult {
  const topN = clampTopN(opts.topN)
  const scope = opts.scope ?? 'all'
  const q = query.trim()
  const terms = queryTerms(q)
  if (terms.length === 0) return { query, scope, total: 0, returned: 0, empty: true, hits: [] }

  // True per-query-term coverage: search EACH query term separately (with its
  // own fuzzy/prefix) for the doc-ids that satisfy it. Counting the full
  // query's `r.terms` instead would overcount — fuzzy expands one query term
  // into many index tokens ("telefone" → "telephone"…), clearing a naive
  // floor with zero real coverage.
  const perTerm = terms.map((t) => new Set((index.search(t) as Array<{ id: string }>).map((r) => String(r.id))))

  // IDF-weighted coverage floor (from a sensei's QA): a flat "half the
  // terms" is too loose for long queries — "coastal sailing certification course"
  // cleared it via two COMMON words while its rare, discriminating term
  // (sailing, absent) went unmatched. Weight each query term by IDF so a hit must
  // cover the query's *discriminating* mass, not just any half. An absent term
  // has the highest weight (df 0), so its absence vetoes — sailing → empty, while
  // all-discriminating queries (locksmith) and full matches (watch 5/5) stay.
  const n = index.documentCount
  const idf = perTerm.map((s) => Math.log((n + 1) / (s.size + 1)) + 1)
  const totalIdf = idf.reduce((a, b) => a + b, 0)
  const need = COVERAGE_FRACTION * totalIdf

  const full = index.search(q) as Array<Record<string, unknown> & { id: string; score: number; terms: string[] }>
  const hits: SearchHit[] = []
  for (const r of full) {
    const id = String(r.id)
    let coveredIdf = 0
    const matchedTerms: string[] = []
    for (let i = 0; i < terms.length; i++) {
      if (perTerm[i]?.has(id)) {
        coveredIdf += idf[i] ?? 0
        const t = terms[i]
        if (t) matchedTerms.push(t)
      }
    }
    if (coveredIdf < need) continue
    const source = r.source as SearchSource
    hits.push({
      id,
      source,
      page: (r.page as string) ?? '',
      description: (r.description as string) ?? '',
      // Source-weighted so the wiki ranks first in a mixed (`all`) result set.
      score: r.score * (SOURCE_WEIGHT[source] ?? 1),
      // locate the snippet by the actual matched index tokens; show the reader
      // the query terms covered.
      snippet: makeSnippet((r.body as string) ?? '', r.terms),
      matchedTerms,
    })
  }
  // Re-rank after source weighting (MiniSearch sorted by raw score).
  hits.sort((a, b) => b.score - a.score)
  const total = hits.length
  return { query, scope, total, returned: Math.min(total, topN), empty: total === 0, hits: hits.slice(0, topN) }
}

/** KWIC snippet: a ~200-char window centered on the DENSEST cluster of matched
 *  terms, so the agent sees the actual matched exchange — not the first lone
 *  occurrence of a common term. (The goals sensei hit this: a "fell asleep no
 *  shake yet" channel hit windowed on an early stray "shake" and showed fat
 *  content instead of the target line.) Falls back to the head when no term is
 *  located (a fuzzy match on a variant that isn't a literal substring). */
export function makeSnippet(body: string, terms: string[], window = 200): string {
  const clean = body.replace(/\s+/g, ' ').trim()
  if (!clean) return ''
  const lower = clean.toLowerCase()

  // Every occurrence position of any matched term.
  const positions: number[] = []
  for (const t of terms) {
    const tl = t.toLowerCase()
    if (!tl) continue // guard: indexOf('') never advances → infinite loop
    for (let i = lower.indexOf(tl); i !== -1; i = lower.indexOf(tl, i + tl.length)) positions.push(i)
  }
  if (positions.length === 0) return clean.slice(0, window) + (clean.length > window ? '…' : '')
  positions.sort((a, b) => a - b)

  // Window start that covers the most matched occurrences = the densest cluster.
  let best = positions[0] ?? 0
  let bestCount = 0
  for (const p of positions) {
    const count = positions.filter((x) => x >= p && x < p + window).length
    if (count > bestCount) {
      bestCount = count
      best = p
    }
  }
  const start = Math.max(0, best - 20)
  const end = Math.min(clean.length, start + window)
  return (start > 0 ? '…' : '') + clean.slice(start, end).trim() + (end < clean.length ? '…' : '')
}
