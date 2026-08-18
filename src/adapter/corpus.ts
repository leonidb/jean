/**
 * The corpus walk — the adapter's half of knowledge (task E2).
 *
 * The knowledge contract draws this line exactly: "DOMAIN: what makes a
 * memory admissible; what a search-document is; how results rank … ADAPTER:
 * walking the wiki directory, reading files, cursor bookkeeping, logging
 * retrievals." Everything below is on the adapter's side of it. The
 * document SHAPING (`parsePage`, `memoryDocs`, `taskDocs`, `channelDocs`) is
 * domain and is called, not reimplemented — this file only produces the raw
 * inputs those transforms consume.
 *
 * ── READ FAILURES ARE NOT EMPTINESS ──
 *
 * `empty: true` promises "definitively no lexical hit in this scope", and an
 * all-scope empty is what tells an agent to stop looking. A wiki that failed
 * to read, reported as an empty wiki, turns that promise into a lie. So only
 * a MISSING directory or file is tolerated (a fresh dojo, or a page removed
 * mid-scan); every other error propagates for the surface to answer 503 with.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import type { SearchDoc } from '../domain/contracts/knowledge.ts'
import { knowledge } from '../domain/knowledge/index.ts'

/** Navigation, not knowledge — an index page names every topic in the dojo
 *  and would out-rank the pages it points at on every query. */
const META_PAGES: ReadonlySet<string> = new Set(['index', 'log'])

function missing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === 'ENOENT'
}

/**
 * Every knowledge page under `contextDir`, shaped into search docs.
 *
 * Ids are namespaced `wiki-*` so a page literally named `task-001.md` cannot
 * collide with a task doc in the unioned `all` index — a collision there is a
 * refused index build, which is a 500 nobody can act on.
 */
export function wikiDocs(contextDir: string): SearchDoc[] {
  let files: string[]
  try {
    files = readdirSync(contextDir).filter((f) => f.endsWith('.md'))
  } catch (err) {
    if (missing(err)) return [] // no wiki yet — legitimately empty
    throw err
  }
  const docs: SearchDoc[] = []
  for (const file of files) {
    const name = basename(file, '.md')
    if (META_PAGES.has(name)) continue
    let raw: string
    try {
      raw = readFileSync(resolve(contextDir, file), 'utf8')
    } catch (err) {
      if (missing(err)) continue // vanished mid-scan
      throw err
    }
    // The PARSE is the domain's; the read is ours.
    const { description, headings, body } = knowledge.parsePage(raw)
    docs.push({
      id: `wiki-${name}`,
      source: 'wiki',
      page: name,
      title: name.replace(/-/g, ' '),
      description,
      headings,
      body,
    })
  }
  return docs
}

/**
 * The consolidator's cursor — how much of the memory stream the librarian has
 * already folded into the wiki. Memories after it are the unconsolidated
 * slice, indexed directly so a fact written this morning is findable before
 * tonight's run.
 *
 * A missing or unreadable cursor means "take everything", which over-includes
 * rather than under-includes: the failure direction is a memory appearing
 * twice in a result set, never a memory that cannot be found.
 */
export async function consolidatedThrough(dataDir: string): Promise<number> {
  try {
    const raw = await Bun.file(resolve(dataDir, '.consolidator', 'cursor.json')).text()
    const parsed = JSON.parse(raw) as { lastEventId?: number }
    return typeof parsed.lastEventId === 'number' && Number.isFinite(parsed.lastEventId) ? parsed.lastEventId : 0
  } catch {
    return 0
  }
}
