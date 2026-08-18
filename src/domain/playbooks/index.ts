/**
 * Playbooks — the registry, the frontmatter parse, and the watcher's pure
 * half (contract: `contracts/playbooks.ts`; task D-PB).
 *
 * ── THE REGISTRY IS A MAP, AND THAT IS THE WHOLE OF THE FIRST RULING ──
 *
 * The old fold kept an ARRAY and appended on `playbook-created`, so a second
 * creation for a known id produced two entries sharing one identity —
 * `playbookOf` answered with whichever came first while the list showed both.
 * A map cannot express that state. The ruled semantics (created-on-known
 * REPLACES, updated-on-unknown UPSERTS) then cost one line each rather than a
 * branch each, because both are "write this id".
 *
 * Insertion order is the list order, which a `Map` gives for free and which
 * the contract asks for: first-recorded, stable across updates. A replace
 * therefore keeps its position — the entry is rewritten, not re-added.
 *
 * ── WHAT A MALFORMED RECORD MAY DO: NOTHING ──
 *
 * Per-field polarity at the fold. The effect-determining fields differ by
 * kind — a create or an update cannot act without BOTH an id and a string
 * body; a removal needs only an id — and the half-malformed update is the
 * one that bites: `{id: 'deploy', hash: 'h9'}` with no content names a real
 * entry, and an implementation that spread it over the existing one would
 * blank the body and move the hash to a body that no longer exists. The
 * check comes before any write, so a record that cannot act cannot touch
 * what it names.
 *
 * ── THE DIFF COMPARES HASHES, NEVER BODIES (R10) ──
 *
 * The hash is the write site's fact. `decideReconcile` asks whether the
 * scanned hash differs from the recorded one and never computes one of its
 * own — a domain that hashed would be second-guessing the fact's owner, and
 * would also quietly decide what "the same content" means (line endings,
 * trailing newline, encoding). Both directions are pinned: same body with a
 * new hash updates; different body with the same hash does nothing.
 *
 * ── AND IT EMITS NOTHING WHEN NOTHING CHANGED ──
 *
 * The mirror direction. The watcher debounces on every filesystem event, so
 * a reconciler that re-emitted "helpfully" would append to the log every time
 * an editor touched a file's mtime. Unchanged in, empty out.
 */

import type {
  Playbook,
  PlaybookFile,
  PlaybookInclude,
  PlaybookSummary,
  PlaybooksContract,
  PlaybooksState,
  ReconcileEvent,
} from '../contracts/playbooks.ts'
import type {
  PlaybookCreatedData,
  PlaybookRemovedData,
  PlaybookUpdatedData,
  StoredEvent,
} from '../contracts/vocabulary.ts'

/** The registry, keyed by id — insertion-ordered, which IS the list order. */
type Registry = ReadonlyMap<string, Playbook>

const seal = (registry: Registry): PlaybooksState => registry as unknown as PlaybooksState
const open = (state: PlaybooksState): Registry => state as unknown as Registry

// ── Frontmatter ──────────────────────────────────────────────────

const FRONTMATTER = /^---\s*\n([\s\S]*?)\n---/

/**
 * YAML-ish, and deliberately not YAML: two keys, one folded form, no
 * dependency. Extracted with its quirks because real playbooks are written
 * against it — the folded `description: >` form in particular, which several
 * of them use.
 *
 * Returns what the text SAYS. The `name || id` fallback is the fold's, so
 * this stays a pure transform of one string and the policy lives in one
 * place.
 */
function parsePlaybook(content: string): { name: string; description: string } {
  if (typeof content !== 'string') return { name: '', description: '' }
  const block = content.match(FRONTMATTER)?.[1]
  if (block === undefined) return { name: '', description: '' }
  const lines = block.split('\n')
  const name = block.match(/^name:\s*(.+)/m)?.[1]?.trim() ?? ''

  let description = ''
  const at = lines.findIndex((line) => /^description:/.test(line))
  if (at >= 0) {
    const rest = lines[at]?.replace(/^description:\s*/, '')
    if (rest === '>' || rest === '') {
      // THE FOLDED FORM: continuation lines are the indented ones that
      // follow, joined by spaces, stopping at the first unindented line —
      // which is the next key, or the end of the block.
      const folded: string[] = []
      for (const line of lines.slice(at + 1)) {
        if (!/^\s+/.test(line)) break
        folded.push(line.trim())
      }
      description = folded.filter(Boolean).join(' ')
    } else {
      description = rest ?? ''
    }
  }
  return { name, description }
}

// ── The fold ─────────────────────────────────────────────────────

/** An id that can act: present, a string, non-empty. */
const idOf = (data: unknown): string | undefined => {
  const id = (data as { id?: unknown } | null)?.id
  return typeof id === 'string' && id.length > 0 ? id : undefined
}

/** A body that can act. `content` is the effect-determining field for both
 *  writing kinds — without it there is nothing to record and nothing to
 *  overwrite WITH. */
const bodyOf = (data: unknown): string | undefined => {
  const content = (data as { content?: unknown } | null)?.content
  return typeof content === 'string' ? content : undefined
}

const hashOf = (data: unknown): string => {
  const hash = (data as { hash?: unknown } | null)?.hash
  return typeof hash === 'string' ? hash : ''
}

/** Write one id — the shared body of both ruled tolerances. A known id is
 *  rewritten in place (keeping its position and its `createdAt`); an unknown
 *  one is added, with `createdAt` honestly this event's instant. */
function write(current: Registry, event: StoredEvent, id: string, content: string): PlaybooksState {
  const { name, description } = parsePlaybook(content)
  const existing = current.get(id)
  const next = new Map(current)
  next.set(id, {
    id,
    // THE ID FALLBACK, in the one place it belongs: a playbook with no
    // frontmatter name is known by its filename, which is its id.
    name: name || id,
    description,
    content,
    hash: hashOf(event.data),
    createdAt: existing?.createdAt ?? event.ts,
    updatedAt: event.ts,
  })
  return seal(next)
}

function fold(state: PlaybooksState, event: StoredEvent): PlaybooksState {
  const current = open(state)
  switch (event.type) {
    // ONE ARM FOR BOTH WRITING KINDS. The two tolerance rulings — a create
    // for a known id REPLACES, an update for an unknown id UPSERTS — are
    // exactly the statement that neither kind cares whether the id is
    // already there, so writing them as one arm is the ruling rather than a
    // shortcut past it. What they carry is identical (`PlaybookCreatedData`
    // and `PlaybookUpdatedData` differ only by `prevHash`, which is audit
    // trail: the fold keys on id alone and consults no hash chain).
    case 'playbook-created':
    case 'playbook-updated': {
      const id = idOf(event.data)
      const content = bodyOf(event.data)
      // BEFORE ANY WRITE. `{id: 'deploy', hash: 'h9'}` with no content names
      // a real entry, and touching it would blank the body while moving the
      // hash to a body that no longer exists.
      if (id === undefined || content === undefined) return state
      return write(current, event, id, content)
    }

    case 'playbook-removed': {
      const id = idOf(event.data)
      // Removing what is not there is not an error in a permanent log — and
      // a removal with no id names nothing, so it removes nothing.
      if (id === undefined || !current.has(id)) return state
      const next = new Map(current)
      next.delete(id)
      return seal(next)
    }

    default:
      return state
  }
}

// ── Views ────────────────────────────────────────────────────────

/** The list row: everything but the body. A list that shipped every
 *  playbook's content would make the cheap read the expensive one, and the
 *  cheap read is the one agents make constantly. */
const summarize = (playbook: Playbook): PlaybookSummary => ({
  id: playbook.id,
  name: playbook.name,
  description: playbook.description,
  hash: playbook.hash,
  updatedAt: playbook.updatedAt,
})

// ── Reconcile ────────────────────────────────────────────────────

function decideReconcile(state: PlaybooksState, files: readonly PlaybookFile[]): readonly ReconcileEvent[] {
  const known = open(state)
  const events: ReconcileEvent[] = []
  const seen = new Set<string>()

  // FILE ORDER FIRST — the scan's order, which is the order the watcher
  // found them in. The contract pins the ORDER and not merely the
  // membership: creations and updates as the files come, then removals.
  for (const file of files) {
    seen.add(file.id)
    const existing = known.get(file.id)
    if (existing === undefined) {
      events.push({
        type: 'playbook-created',
        data: { id: file.id, content: file.content, hash: file.hash } satisfies PlaybookCreatedData,
      })
      continue
    }
    // THE HASH IS THE FACT. Not the body: the domain never hashes, so it
    // never has an opinion about what "the same content" means.
    if (existing.hash === file.hash) continue
    events.push({
      type: 'playbook-updated',
      data: {
        id: file.id,
        content: file.content,
        hash: file.hash,
        // What was replaced — the audit trail, produced here because this is
        // the only place that knows both sides.
        prevHash: existing.hash,
      } satisfies PlaybookUpdatedData,
    })
  }

  // THEN REMOVALS, in registry order: an entry whose file is gone.
  for (const [id, playbook] of known) {
    if (seen.has(id)) continue
    events.push({ type: 'playbook-removed', data: { id, lastHash: playbook.hash } satisfies PlaybookRemovedData })
  }

  return events
}

export const playbooks: PlaybooksContract = {
  initial: () => seal(new Map()),
  fold,
  parsePlaybook,

  all: (state) => [...open(state).values()].map(summarize),

  playbookOf: (state, id) => open(state).get(id),

  /**
   * The include seam.
   *
   * BY ID, never by name. `Task.playbook` carries the playbook's
   * filename-derived identity, and a playbook's frontmatter `name` is a
   * display string an author may change at will — resolving by it would make
   * every task's attachment break the day someone retitled a document.
   *
   * An EMPTY reference is absent, not a lookup for the empty id: a task with
   * no playbook simply has no include. (Per-field polarity again — the same
   * character means "malformed" for a search scope and "none" here.)
   */
  includeFor: (state, id) => {
    if (id === undefined || id.length === 0) return undefined
    const playbook = open(state).get(id)
    return playbook === undefined
      ? undefined
      : ({ id: playbook.id, name: playbook.name, content: playbook.content } satisfies PlaybookInclude)
  },

  decideReconcile,
}
