/**
 * Knowledge — memory admission and retrieval ranking (contract
 * `contracts/knowledge.ts`, task D7).
 *
 * ── LOCATION BEATS DENSITY, BY CONSTRUCTION RATHER THAN BY TUNING ──
 *
 * The contract holds a property, not an engine, and this implementation scores
 * by FIELD PRESENCE: a term either appears in a field or it does not, and the
 * field's weight is the whole contribution. Repeating a term in a body cannot
 * add score.
 *
 * That is a deliberate departure from the old engine (field-boosted BM25),
 * which reached the same property by weights large enough that frequency
 * rarely overtook location — true for the corpora it was tuned on, and a
 * tuning fact rather than a guarantee. Presence-scoring makes "the page ABOUT
 * a topic outranks the page mentioning it in passing" unfalsifiable by any
 * document: no number of body mentions can reach a title's weight, because
 * body mentions do not accumulate at all. The weights are kept from the old
 * BOOST table so relative ordering between fields is the extracted one.
 *
 * The cost is honest and worth stating, and one part of it is a real loss the
 * old engine covered. Presence-scoring cannot rank two documents that match the
 * same fields, and it has no IDF — so it also has no COVERAGE floor: a document
 * matching one term of a four-term query scores, which means `empty` can be
 * false when nothing topical matched. The old engine used IDF-weighted coverage
 * to make exactly that case empty ("coastal sailing certification course" found
 * nothing when only the incidental words matched). Reproducing it needs a
 * distinctiveness measure this scoring does not have, and inventing a
 * coverage threshold the contract does not state would be policy rather than
 * extraction — so it is reported on task 093 rather than guessed at.
 * STOPWORDS carry the rest of that load —
 * dropped at index AND query time, as the old code did, and for a reason that
 * matters more here than there: without them "what is my car" matches every
 * document on `what/is/my`, every document scores, and `empty` stops meaning
 * anything.
 *
 * ── THE EMPTY PROMISE ──
 *
 * `empty: true` says the searched scope definitively holds no lexical hit for
 * the query's terms. It is the signal that stops an agent from falling back to
 * grepping the raw log, so a masked partial search would be worse than a wrong
 * ranking: it would end the search. Two things protect it here. The index is
 * complete over the documents it was built from — there is no partial state to
 * report, because building and searching are separate steps and search never
 * fails halfway. And a query whose every term is a stopword yields NO terms,
 * which is reported as empty rather than as "everything matched": a question
 * made entirely of common words has no topical content to find.
 *
 * ── SCOPE IS NOT SOURCE ──
 *
 * The caller-facing scopes are the old API's, and `knowledge` maps to TWO
 * sources — the wiki and unconsolidated memory — because the question behind
 * it is one question ("is this known?") and a fact written an hour ago is not
 * in the wiki yet. An invalid scope is refused rather than widened: returning
 * all-scope hits for a typo'd scope answers a question the caller did not ask,
 * and they cannot tell from the results that the narrowing was dropped.
 *
 * What this file cannot enforce, and what does: the ranking properties, the
 * empty promise, the refusal shapes and the admission trim are held by
 * `knowledge.conformance.test.ts`.
 */

import type {
  KnowledgeContract,
  MemoryCommand,
  MemoryDecision,
  ScopeDecision,
  SearchDoc,
  SearchHit,
  SearchIndex,
  SearchResult,
  SearchScope,
  SearchSource,
} from '../contracts/knowledge.ts'
import type { AgentRole, MemoryScope } from '../contracts/vocabulary.ts'

// ── Terms ────────────────────────────────────────────────────────

/**
 * Common words carry no topical signal. Extracted verbatim, and load-bearing
 * for the empty promise rather than for ranking quality: a query of nothing but
 * these must find nothing, not everything.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
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

/** Split on anything that is not a word character, lowercase, drop stopwords.
 *  Applied at index AND query time — a term dropped on one side only would
 *  never match, which is the subtle way a stopword list breaks a search. */
function termsOf(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0 && !STOPWORDS.has(t))
}

/** Query terms, DEDUPED. A term repeated in the query would otherwise score
 *  twice against the same field and outrank a document that matched more of
 *  the query — so "telecom telecom" would beat a page matching both "telecom"
 *  and "pricing". The old retrieval deduped for exactly this reason
 *  (codex pass, task 093). Index-side terms need no dedup: they are already
 *  sets. */
function queryTerms(query: string): string[] {
  return [...new Set(termsOf(query))]
}

// ── Index ────────────────────────────────────────────────────────

/** The extracted field weights. Their RATIO is what the property rests on:
 *  title and description outrank headings, which outrank body. */
const BOOST = { title: 4, description: 4, headings: 2, body: 1 } as const

/** One document, with each field's terms pre-collected as a SET — presence is
 *  the only question asked of it, so a set is the honest shape. */
type Indexed = {
  readonly doc: SearchDoc
  readonly fields: ReadonlyMap<keyof typeof BOOST, ReadonlySet<string>>
}

type Index = readonly Indexed[]

function unwrap(index: SearchIndex): Index {
  return index as unknown as Index
}

// ── topN ─────────────────────────────────────────────────────────

const DEFAULT_TOP_N = 5
const MAX_TOP_N = 50

/**
 * Garbage clamps to the default rather than reaching `slice()`. Extracted with
 * its reason: negative, fractional and NaN values used to reach `slice(0, -1)`
 * and `Math.min`, producing nonsense response shapes like `returned: -1`. An
 * absurdly large request is a mistake rather than a need — the corpus is
 * kilobytes — so it caps instead of erroring.
 */
function clampTopN(v: number | undefined): number {
  if (v === undefined) return DEFAULT_TOP_N
  const n = Math.floor(v)
  return Number.isFinite(n) && n >= 1 ? Math.min(n, MAX_TOP_N) : DEFAULT_TOP_N
}

// ── Scopes ───────────────────────────────────────────────────────

/** SCOPE ≠ SOURCE. `knowledge` is two sources on purpose — see the header. */
const SCOPE_SOURCES: Readonly<Record<SearchScope, ReadonlySet<SearchSource>>> = {
  all: new Set<SearchSource>(['wiki', 'memory', 'task', 'channel']),
  knowledge: new Set<SearchSource>(['wiki', 'memory']),
  tasks: new Set<SearchSource>(['task']),
  channel: new Set<SearchSource>(['channel']),
}

const VALID_SCOPES: readonly SearchScope[] = ['all', 'knowledge', 'tasks', 'channel']

/** What an unrecognised scope searches: nothing. See `search`. */
const EMPTY_SOURCES: ReadonlySet<SearchSource> = new Set<SearchSource>()

// ── Snippets ─────────────────────────────────────────────────────

/**
 * A window of body text around the densest cluster of matches. Extracted whole,
 * including the guard that earns its comment: `indexOf('')` never advances, so
 * an empty term would spin forever.
 */
function makeSnippet(body: string, terms: readonly string[], window = 200): string {
  const clean = body.replace(/\s+/g, ' ').trim()
  if (!clean) return ''
  const lower = clean.toLowerCase()

  const positions: number[] = []
  for (const t of terms) {
    const tl = t.toLowerCase()
    if (!tl) continue
    for (let i = lower.indexOf(tl); i !== -1; i = lower.indexOf(tl, i + tl.length)) positions.push(i)
  }
  if (positions.length === 0) return clean.slice(0, window) + (clean.length > window ? '…' : '')
  positions.sort((a, b) => a - b)

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

// ── The contract ─────────────────────────────────────────────────

export const knowledge: KnowledgeContract = {
  admitMemory(cmd: MemoryCommand): MemoryDecision {
    const text = (cmd.text ?? '').trim()
    // TRIMMED BEFORE JUDGED: whitespace is not a memory, and admitting one
    // would put an unfindable blank into the corpus forever. The AGENT is
    // trimmed on the same rule — the contract only names the text, but a
    // memory attributed to '   ' is attributed to nobody, and the two fields
    // fail the same way (codex noted the asymmetry, task 093).
    const agent = (cmd.agent ?? '').trim()
    if (agent.length === 0 || !cmd.role || text.length === 0) {
      return { ok: false, refusal: { kind: 'missing-fields' } }
    }
    // `user` is the one non-default scope; anything else — including a typo —
    // falls to `dojo`. Widening to the dojo is the safe direction: a memory
    // filed too broadly is visible, where one filed to a scope nobody reads
    // is lost.
    const scope: MemoryScope = cmd.scope === 'user' ? 'user' : 'dojo'
    return {
      ok: true,
      data: {
        agent,
        role: cmd.role as AgentRole,
        text,
        scope,
        ...(cmd.taskId !== undefined && { taskId: cmd.taskId }),
      },
    }
  },

  resolveScope(scope: string | null | undefined): ScopeDecision {
    // Absent means the caller did not narrow — the widest scope is the honest
    // default, and it is the one whose `empty` answer is worth trusting.
    if (scope === undefined || scope === null) return { ok: true, scope: 'all' }
    // '' IS NOT ABSENT HERE, and I had it wrong first (codex pass, task 093).
    // The contract names `null` and `undefined` as the absent forms; an empty
    // string is a value the caller SENT — `?scope=` — and widening it answers a
    // question they did not ask, with nothing in the result to show the
    // narrowing was dropped. This is the per-field polarity question from D6
    // answered the other way: empty means "none" for a taskId, and means
    // "malformed" for a scope, because a scope is a choice among named things.
    if ((VALID_SCOPES as readonly string[]).includes(scope)) return { ok: true, scope: scope as SearchScope }
    // NEVER A SILENT WIDEN. A typo'd scope that returned all-scope hits would
    // answer a question the caller did not ask, and nothing in the results
    // would show that the narrowing was dropped.
    return { ok: false, valid: VALID_SCOPES }
  },

  buildIndex(docs: readonly SearchDoc[]): SearchIndex {
    const indexed: Indexed[] = docs.map((doc) => ({
      doc,
      fields: new Map<keyof typeof BOOST, ReadonlySet<string>>([
        ['title', new Set(termsOf(doc.title))],
        ['description', new Set(termsOf(doc.description))],
        ['headings', new Set(termsOf(doc.headings))],
        ['body', new Set(termsOf(doc.body))],
      ]),
    }))
    return indexed as unknown as SearchIndex
  },

  search(index: SearchIndex, query: string, opts: { topN?: number; scope: SearchScope }): SearchResult {
    const terms = queryTerms(query)
    // NO WIDENING FALLBACK. An unrecognised scope reaches here only through a
    // cast past `resolveScope`, and the old `?? all` I wrote here undid the
    // very guarantee that function exists to give: it answered an all-scope
    // question for a caller who asked to narrow (codex pass, task 093).
    // Matching NOTHING is the honest failure — "nothing in a scope that does
    // not exist" is at least true, and it is visible, where a silent widen is
    // neither.
    const sources = SCOPE_SOURCES[opts.scope] ?? EMPTY_SOURCES
    const limit = clampTopN(opts.topN)

    // A query with no topical terms finds nothing. Reporting it as empty is the
    // truthful answer and the one that keeps `empty` meaningful — the
    // alternative, every document matching zero terms, would score them all.
    if (terms.length === 0) return { hits: [], total: 0, returned: 0, empty: true }

    const scored: SearchHit[] = []
    for (const { doc, fields } of unwrap(index)) {
      // SCOPE FILTERS EXACTLY, before scoring: a narrowed search must not be
      // able to return a hit from another source, whatever it scored.
      if (!sources.has(doc.source)) continue

      let score = 0
      const matched: string[] = []
      for (const term of terms) {
        let hit = false
        for (const [field, weight] of Object.entries(BOOST) as [keyof typeof BOOST, number][]) {
          // PRESENCE, not count — the whole location-beats-density property
          // lives in this line not being a frequency.
          if (fields.get(field)?.has(term)) {
            score += weight
            hit = true
          }
        }
        if (hit) matched.push(term)
      }
      if (score === 0) continue
      scored.push({
        id: doc.id,
        source: doc.source,
        page: doc.page,
        description: doc.description,
        score,
        snippet: makeSnippet(doc.body, matched),
        matchedTerms: matched,
      })
    }

    // Score descending; id ascending as the tie-break, so a caller reading two
    // equal hits gets a stable order rather than input order — input order is
    // the corpus walk's accident, and it would make results move between runs.
    scored.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    const hits = scored.slice(0, limit)
    return { hits, total: scored.length, returned: hits.length, empty: scored.length === 0 }
  },

  parsePage(rawInput: string): { description: string; headings: string; body: string } {
    // CRLF normalised first: the anchored `\n` frontmatter match would
    // otherwise miss a Windows-authored page and drop its whole description.
    const raw = rawInput.replace(/\r\n/g, '\n')
    let description = ''
    let rest = raw
    const fm = raw.match(/^---\n([\s\S]*?)\n---\n?/)
    if (fm?.[1] !== undefined) {
      rest = raw.slice(fm[0].length)
      const lines = fm[1].split('\n')
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        if (line === undefined) continue
        const m = line.match(/^description:\s*(.*)$/)
        if (!m) continue
        description = (m[1] ?? '').trim()
        // Fold continuation lines — indented, and not a key of their own.
        for (let j = i + 1; j < lines.length; j++) {
          const cont = lines[j]
          if (cont === undefined || !/^\s+\S/.test(cont) || /^\S+:/.test(cont)) break
          description += ` ${cont.trim()}`
        }
        // A YAML block-scalar marker is not content; without this the folded
        // description starts with a stray `>` or `|`.
        description = description.replace(/^[>|][-+0-9]*\s*/, '').trim()
        break
      }
    }
    // The `# Title` is dropped from headings' emphasis by being collected with
    // the rest rather than boosted separately; `##`/`###` carry the structure.
    const headings = (rest.match(/^#{1,3}\s+.+$/gm) ?? []).map((h) => h.replace(/^#+\s+/, '')).join(' · ')
    return { description, headings, body: rest }
  },

  memoryDocs(recent) {
    return recent.map((m) => ({
      // Namespaced, like every id here: a page literally named `mem-5.md`
      // must not collide with memory 5 in the unioned index.
      id: `mem-${m.id}`,
      source: 'memory' as const,
      page: 'recent memory (unconsolidated)',
      title: '',
      // The memory's own opening IS its description — there is no separate
      // summary to draw on, and a hit still has to say what it is about.
      description: m.text.slice(0, 120) + (m.text.length > 120 ? '…' : ''),
      headings: '',
      body: m.text,
    }))
  },

  taskDocs(tasks) {
    return tasks.map((t) => ({
      id: `task-${t.id}`,
      source: 'task' as const,
      page: `task ${t.id}`,
      title: t.title,
      description: t.title,
      // The id goes in an indexed field so a by-id lookup matches even when the
      // task's text never mentions its own number.
      headings: `task ${t.id}`,
      body: [t.description ?? '', ...t.comments].filter(Boolean).join('\n'),
    }))
  },

  channelDocs(messages, windowSize = 6) {
    const docs: SearchDoc[] = []
    // Windows, not lines: meaning lives in the exchange, so a hit returns the
    // conversation around it. `Math.max(1, …)` because a zero or negative
    // window would step nowhere and loop forever.
    const step = Math.max(1, Math.floor(windowSize) || 1)
    for (let i = 0; i < messages.length; i += step) {
      const chunk = messages.slice(i, i + step)
      docs.push({
        id: `chan-${i}`,
        source: 'channel',
        page: 'conversation',
        title: '',
        // NO static description on purpose: labelling a window by its first
        // message hides a hit whose match is a neighbour — it reads as a miss
        // when it is not. The snippet, centred on the match, carries it.
        description: '',
        headings: '',
        body: chunk.map((m) => `${m.who}: ${m.text}`).join('\n'),
      })
    }
    return docs
  },
}
