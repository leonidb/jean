/**
 * The playbooks contract — the plan-gap module (task 105; found at E2: no
 * module owned playbooks while H2 deletes the old code). EXTRACTION
 * territory (§8): the old reducer, the reconcile watcher and the task
 * include in `src/infra/{reducers,server}.ts` are the requirements source —
 * deliberate behaviour extracted, accidents left behind and RULED on below.
 *
 * ── WHAT A PLAYBOOK IS HERE ──
 *
 * A body of instructions with an identity. The BODIES live in this module's
 * registry, folded from the log's CRUD kinds (`playbook-created/updated/
 * removed`, census shapes). The REFERENCE on a task (`Task.playbook` — the
 * playbook's ID, never its frontmatter name) is the tasks module's; the
 * include a caller sees is COMPOSED by the shell from the two owning
 * modules — `tasks.taskOf(...).playbook` naming the id, `includeFor`
 * supplying the body. That seam is an injected-fact composition (R10),
 * never a cross-module import (P2's discipline).
 *
 * ── FILES ARE THE SOURCE; THE LOG RECORDS WHAT CHANGED ──
 *
 * Playbook bodies are authored as markdown files; the adapter watches the
 * directory and RECONCILES: scan → diff against the registry BY HASH → emit
 * exactly what changed. The diff is a pure decision and lives here as
 * `decideReconcile` (the fs walk stays adapter-side — the same split the
 * knowledge module made for its documents): given the files and the state,
 * it returns the events to append — created for unknown ids, updated where
 * the hash differs (carrying `prevHash`, the audit trail of what was
 * replaced), removed for registry entries with no file (carrying
 * `lastHash`). AN UNCHANGED FILE EMITS NOTHING: reconciliation is
 * idempotent, and a watcher rerun over a quiet directory appends zero
 * events — the mirror direction (checklist #3): a reconciler that "helpfully"
 * re-emits floods the log on every debounce.
 *
 * HASHES ARE THE WRITE SITE'S FACTS. The domain never computes one — it
 * compares what the shell supplies against what the log recorded (R10).
 * `prevHash`/`lastHash` are record fields, produced by the decision for the
 * audit trail; the FOLD keys on id alone and consults no hash chain.
 *
 * ── FRONTMATTER (extracted with its quirks, deliberately) ──
 *
 * `parsePlaybook` reads YAML-ish frontmatter for `name` and `description`,
 * including the folded `description: >` multi-line form the old parser
 * accepted (real playbooks use it). It returns what the text SAYS — an
 * absent name comes back empty, and the FOLD applies the id fallback
 * (`name || id`), so the parse stays a pure transform and the policy sits
 * in one place.
 *
 * ── TOLERANCE RULINGS (extraction decisions, flagged as such) ──
 *
 * The old reducer had two accidents at unassumed inputs, both resolved here
 * in the content-preserving direction (the same law as provenance
 * tolerance, 097: effect-determining fields present → apply):
 *
 *  - CREATED FOR A KNOWN ID folds as a REPLACE. The old fold appended a
 *    second entry sharing the id — an impossible registry (id is identity;
 *    `playbookOf` answered with whichever came first while the list showed
 *    both). Last write wins: the latest content is the file's truth.
 *  - UPDATED FOR AN UNKNOWN ID folds as a CREATE (upsert). The old fold
 *    mapped over existing entries and silently dropped the content forever
 *    — the file existed, the log said updated, the registry never showed
 *    it. The event carries everything a create needs; dropping real
 *    content over bookkeeping order is the under-delivery direction.
 *    `createdAt` is honestly the upsert event's ts.
 *  - REMOVED FOR AN UNKNOWN ID is a no-op (unchanged — nothing to remove
 *    is not an error in a permanent log).
 *
 * Malformed records (no id, non-string content) fold to nothing — typed
 * tolerance at the fold, per the standing per-field polarity: an absent
 * effect-determining field means the record cannot act, never a crash.
 *
 * What the types cannot enforce, and what does: the fold semantics, both
 * tolerance rulings, reconcile idempotence, the id fallback, and the
 * include shape are held by `playbooks.conformance.test.ts` (red by
 * absence until D-PB lands `src/domain/playbooks/index.ts`).
 */

import type { PlaybookCreatedData, PlaybookRemovedData, PlaybookUpdatedData, StoredEvent } from './vocabulary.ts'

/** The registry entry — the get view returns it whole. */
export type Playbook = {
  id: string
  /** Frontmatter name, or the id when the frontmatter has none. */
  name: string
  description: string
  content: string
  /** The write site's hash of `content` — carried, never recomputed. */
  hash: string
  createdAt: string
  updatedAt: string
}

/** The list view's row — deliberately CONTENT-FREE (the old `/playbooks`
 *  shape): a list that shipped every body would make the cheap read the
 *  expensive one. */
export type PlaybookSummary = {
  id: string
  name: string
  description: string
  hash: string
  updatedAt: string
}

/** The task-include shape — exactly what E2's `enriched.playbook` serves. */
export type PlaybookInclude = {
  id: string
  name: string
  content: string
}

/** One file as the adapter's scan found it: id from the filename, content
 *  read whole, hash computed at the write site (R10 — a fact). */
export type PlaybookFile = {
  id: string
  content: string
  hash: string
}

/** What `decideReconcile` tells the shell to append — census kinds with
 *  their declared data, in order (creations and updates in file order,
 *  then removals). All three kinds are HISTORY per the resolution table:
 *  registry changes, not mail. */
export type ReconcileEvent =
  | { type: 'playbook-created'; data: PlaybookCreatedData }
  | { type: 'playbook-updated'; data: PlaybookUpdatedData }
  | { type: 'playbook-removed'; data: PlaybookRemovedData }

/** Opaque — the registry. Constructed by `initial()`, evolved by `fold`,
 *  read through the views only. */
export type PlaybooksState = { readonly __playbooksState: true }

/** `export const playbooks: PlaybooksContract` — src/domain/playbooks/
 *  (task D-PB, and nowhere else). */
export type PlaybooksContract = {
  initial: () => PlaybooksState

  /** Fold one event; non-playbook kinds are ignored. Tolerance rulings in
   *  the header: created-on-known replaces, updated-on-unknown creates,
   *  removed-on-unknown no-ops, malformed folds to nothing. */
  fold: (state: PlaybooksState, event: StoredEvent) => PlaybooksState

  /** Pure frontmatter parse — name and description (including the folded
   *  `>` form), empty strings when absent. The id fallback is the FOLD's,
   *  not the parser's. */
  parsePlaybook: (content: string) => { name: string; description: string }

  /** The list view, in first-recorded order — stable across updates. */
  all: (state: PlaybooksState) => readonly PlaybookSummary[]

  /** The get view — the whole entry, or undefined for an unknown id. */
  playbookOf: (state: PlaybooksState, id: string) => Playbook | undefined

  /** The task-include seam: the body for a task's playbook reference —
   *  `Task.playbook` carries the playbook's ID (the filename-derived
   *  identity; the old adapter matched it against `p.id`), NOT the
   *  frontmatter name. Unknown or empty reference → undefined (per-field
   *  polarity: an empty `Task.playbook` means absent, and the include
   *  simply does not attach — the old adapter's exact behaviour). */
  includeFor: (state: PlaybooksState, id: string | undefined) => PlaybookInclude | undefined

  /** The pure half of the watcher: diff the scanned files against the
   *  registry, return exactly the events to append. Unchanged files emit
   *  NOTHING — idempotent by construction. */
  decideReconcile: (state: PlaybooksState, files: readonly PlaybookFile[]) => readonly ReconcileEvent[]
}
