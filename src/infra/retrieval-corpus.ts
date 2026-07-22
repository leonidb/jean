/**
 * Corpus adapters — turn the knowledge layer into searchable docs.
 *
 * Kept separate from retrieval.ts (the pure, fs-free core) so the ranking
 * logic stays unit-testable without touching disk. These readers are the
 * only fs-touching part.
 *
 * The default `all` scope unions every source (wiki + unconsolidated
 * memories + task comments + human conversation); `knowledge` narrows to
 * wiki + memories. The raw event log is never a source (that's the point).
 */

import { readdirSync, readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import type { SearchDoc } from './retrieval.ts'

/** Pages that are navigation/meta, not knowledge — excluded from the corpus. */
const META_PAGES = new Set(['index', 'log'])

/** Pull the frontmatter description and split the body from a page's raw text.
 *  Deliberately minimal (no YAML dep): the frontmatter we care about is a
 *  leading `---` block with a `description:` line (single- or folded-line). */
export function parsePage(rawInput: string): { description: string; headings: string; body: string } {
  // Normalize CRLF so a Windows-authored page's `---\r\n` frontmatter still
  // matches (the anchored `\n` regex would otherwise miss it, dropping the
  // whole frontmatter and its description).
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
      if (m) {
        description = (m[1] ?? '').trim()
        // Fold continuation lines (indented, no `key:` of their own).
        for (let j = i + 1; j < lines.length; j++) {
          const cont = lines[j]
          if (cont === undefined || !/^\s+\S/.test(cont) || /^\S+:/.test(cont)) break
          description += ` ${cont.trim()}`
        }
        // A YAML block-scalar marker (`description: >` / `|`) isn't content —
        // strip it so the folded body doesn't start with a stray `>`/`|`.
        description = description.replace(/^[>|][-+0-9]*\s*/, '').trim()
        break
      }
    }
  }
  // Strip a leading `# Title` so it doesn't dominate; collect `##`/`###` headings.
  const headings = (rest.match(/^#{1,3}\s+.+$/gm) ?? []).map((h) => h.replace(/^#+\s+/, '')).join(' · ')
  return { description, headings, body: rest }
}

/** Read every knowledge page in `.jean/context/` into search docs.
 *
 *  Read failures are NOT swallowed as "empty": an empty corpus makes an
 *  all-scope search return `empty:true`, which the design treats as
 *  "definitively not in the dojo's memory." A transiently-unreadable wiki
 *  (permissions, I/O) reported as empty would make that a lie — so only a
 *  MISSING dir/file (ENOENT, i.e. a fresh dojo or a page removed mid-scan) is
 *  tolerated; every other error propagates for the caller to surface. */
export function wikiDocs(contextDir: string): SearchDoc[] {
  let files: string[]
  try {
    files = readdirSync(contextDir).filter((f) => f.endsWith('.md'))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [] // no wiki yet — legitimately empty
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
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue // vanished mid-scan — skip
      throw err
    }
    const { description, headings, body } = parsePage(raw)
    // Id is namespaced `wiki-*` so a page literally named `task-001.md` /
    // `mem-5.md` can't collide with a task/memory/channel id and crash
    // MiniSearch's addAll (duplicate-id throw) in the unioned `all` index.
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

/** A memorize event, as returned by GET /context/recent. */
export type RecentMemory = { id: number; text: string; agent?: string; taskId?: string }

/** Unconsolidated memorize events → search docs, so today's facts are findable
 *  before the nightly librarian run — folded into the search corpus by
 *  construction, so a just-written fact is findable immediately. */
export function memoryDocs(recent: RecentMemory[]): SearchDoc[] {
  return recent.map((m) => ({
    id: `mem-${m.id}`,
    source: 'memory' as const,
    page: 'recent memory (unconsolidated)',
    title: '',
    description: m.text.slice(0, 120) + (m.text.length > 120 ? '…' : ''),
    headings: '',
    body: m.text,
  }))
}

/** A task and its curated comments — one search doc per task (a task is a
 *  container like a page). `tasks` scope. */
export type TaskInput = { id: string; title: string; description?: string; comments: string[] }
export function taskDocs(tasks: TaskInput[]): SearchDoc[] {
  return tasks.map((t) => ({
    id: `task-${t.id}`,
    source: 'task' as const,
    page: `task ${t.id}`,
    title: t.title,
    description: t.title,
    // Index the task id itself so a by-id lookup (`q=001&scope=tasks`) matches
    // even when the task's text never mentions the number.
    headings: `task ${t.id}`,
    body: [t.description ?? '', ...t.comments].filter(Boolean).join('\n'),
  }))
}

/** One human↔agent message. `channel` scope. */
export type ChannelMessage = { who: string; text: string }

/** The human↔agent conversation, chunked into overlapping-free windows of
 *  `windowSize` consecutive messages — meaning lives in the exchange, not one
 *  line, so a hit returns a conversation window rather than an isolated line.
 *  Reminds the agent "you discussed X with the human" even if never memorized. */
export function channelDocs(messages: ChannelMessage[], windowSize = 6): SearchDoc[] {
  const docs: SearchDoc[] = []
  for (let i = 0; i < messages.length; i += windowSize) {
    const chunk = messages.slice(i, i + windowSize)
    docs.push({
      id: `chan-${i}`,
      source: 'channel',
      page: 'conversation',
      title: '',
      // No static description: labelling a window by its FIRST message hides a
      // hit whose match is a neighbor (it "looks like a miss" when it isn't).
      // The KWIC snippet, centered on the matched line, carries the content.
      description: '',
      headings: '',
      body: chunk.map((m) => `${m.who}: ${m.text}`).join('\n'),
    })
  }
  return docs
}
