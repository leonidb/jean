/**
 * The knowledge contract — memory admission and retrieval ranking
 * (design §3: ranking is domain, the corpus WALK is adapter; old code read
 * under §8's discipline — `retrieval.ts`'s rules extracted as properties,
 * the engine specifics deliberately left out; task 087's report carries the
 * calls).
 *
 * ── THE LINE (design §3, drawn exactly) ──
 *
 * DOMAIN: what makes a memory admissible; what a search-document is; how
 * results rank (the PROPERTIES, not the algorithm); what scopes mean; what
 * `empty` promises. ADAPTER: walking the wiki directory, reading files,
 * cursor bookkeeping, logging retrievals. The document-shaping transforms
 * (page text → doc, memories → docs, tasks → docs, channel windows → docs)
 * take typed values and are domain; ONLY the filesystem walk that feeds
 * them is not.
 *
 * ── RANKING AS PROPERTIES, not engine pins ──
 *
 * The implementation is free to use any engine (the old one is MiniSearch,
 * field-boosted BM25 + capped fuzzy). What the contract holds:
 *  - LOCATION BEATS DENSITY: a hit in a title/description outranks a hit
 *    buried in a body — the page that is ABOUT a topic names it up top.
 *  - `empty: true` means definitively no lexical hit for the query's terms
 *    in the searched scope. All-scope empty is the signal that kills the
 *    grep-the-raw-log reflex, so it must never mask a partial search.
 *  - Scope filters are exact: a narrowed search returns hits from that
 *    source only. An INVALID scope is the caller's error, refused typed —
 *    never a silent widen (returning all-scope hits for a typo'd scope
 *    misleads a caller who meant to narrow).
 *  - `topN` clamps garbage (negative, fractional, NaN) into a sane bound
 *    rather than reaching slice() raw; absent means the default.
 *  - Every hit carries its owning page and description, so a result says
 *    "this lives on page X, which is about Y" without a second lookup.
 *
 * ── MEMORY ADMISSION ──
 *
 * A memory requires an agent, a role, and NON-EMPTY text (trimmed); scope
 * defaults to `dojo`, and only `user` is the other value. The decision
 * returns the event data the shell appends — the adapter renames, never
 * judges.
 *
 * What the types cannot enforce, and what does: the ranking properties,
 * the empty promise, the refusal shapes and the admission trim are held by
 * `knowledge.conformance.test.ts`.
 */

import type { AgentRole, MemoryData, MemoryScope } from './vocabulary.ts'

export type SearchSource = 'wiki' | 'memory' | 'task' | 'channel'

/** The CALLER-facing scopes — faithful to the old API (codex pass caught the
 *  conflation): `knowledge` searches the wiki AND unconsolidated memory
 *  together (one question: "is this known?"), `tasks` searches task
 *  comments, `channel` the human conversation. Scope ≠ source: the mapping
 *  is knowledge → {wiki, memory}, tasks → {task}, channel → {channel}. */
export type SearchScope = 'all' | 'knowledge' | 'tasks' | 'channel'

export type SearchDoc = {
  id: string
  source: SearchSource
  /** Owning container shown to the agent (page name, task id, "channel"). */
  page: string
  title: string
  description: string
  headings: string
  body: string
}

export type SearchHit = {
  id: string
  source: SearchSource
  page: string
  description: string
  score: number
  snippet: string
  matchedTerms: readonly string[]
}

export type SearchResult = {
  hits: readonly SearchHit[]
  total: number
  returned: number
  /** Definitively nothing for these terms in this scope — never a masked
   *  partial search. */
  empty: boolean
}

export type MemoryCommand = {
  agent?: string
  role?: AgentRole
  text?: string
  scope?: string
  taskId?: string
}

export type MemoryDecision = { ok: true; data: MemoryData } | { ok: false; refusal: { kind: 'missing-fields' } }

export type ScopeDecision = { ok: true; scope: SearchScope } | { ok: false; valid: readonly SearchScope[] }

/** Opaque index handle — built from docs, queried by search. */
export type SearchIndex = { readonly __searchIndex: true }

/** `export const knowledge: KnowledgeContract` — src/domain/knowledge/ (D7). */
export type KnowledgeContract = {
  admitMemory: (cmd: MemoryCommand) => MemoryDecision
  /** Absent → 'all'; invalid → typed refusal, never a silent widen. */
  resolveScope: (scope: string | null | undefined) => ScopeDecision

  buildIndex: (docs: readonly SearchDoc[]) => SearchIndex
  search: (index: SearchIndex, query: string, opts: { topN?: number; scope: SearchScope }) => SearchResult

  // Document shaping — pure transforms of typed inputs (the fs walk that
  // produces `rawPage` inputs is the adapter's).
  parsePage: (raw: string) => { description: string; headings: string; body: string }
  memoryDocs: (recent: readonly { id: number; text: string; agent?: string; taskId?: string }[]) => SearchDoc[]
  taskDocs: (
    tasks: readonly { id: string; title: string; description?: string; comments: readonly string[] }[],
  ) => SearchDoc[]
  channelDocs: (messages: readonly { who: string; text: string }[], windowSize?: number) => SearchDoc[]
}

export type { MemoryScope }
