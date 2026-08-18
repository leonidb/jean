/**
 * The playbook directory — the adapter's half of the playbooks module
 * (task D-PB).
 *
 * The same split `corpus.ts` makes for knowledge, and for the same stated
 * reason: the DIFF is a pure decision and lives in the domain
 * (`decideReconcile`), the WALK is reading files and lives here. What crosses
 * between them is a list of `{id, content, hash}` — and the hash is computed
 * at this write site, because the domain never hashes and so never has an
 * opinion about what "the same content" means (R10).
 *
 * ── A FILE THAT CANNOT BE READ IS NOT A FILE THAT IS GONE ──
 *
 * `decideReconcile` removes a registry entry whose file has vanished. So a
 * read that fails for any reason OTHER than absence must not be reported as
 * absence: a permissions blip during a scan would otherwise emit
 * `playbook-removed` for a playbook that is sitting right there, and the next
 * scan would create it again — a log that flaps with the weather. Only ENOENT
 * is treated as gone; everything else propagates and the reconcile is
 * abandoned with nothing appended.
 */

import { readdirSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import type { PlaybookFile } from '../domain/contracts/playbooks.ts'

/**
 * The identity of a playbook IS its filename, minus the extension — which is
 * why `Task.playbook` carries an id and not a frontmatter name.
 *
 * A file named exactly `.md` yields an EMPTY id, and empty is not an
 * identity: `decideReconcile` would emit a create for it, the fold would
 * drop it as malformed, and the next scan — every boot, every watcher
 * debounce — would emit it again. A log that grows forever over a file
 * nobody can name is the same flood the idempotence pin exists to prevent,
 * arriving through the scan instead of the diff (codex pass, task 106).
 */
function idFromFilename(filename: string): string | undefined {
  if (!filename.endsWith('.md')) return undefined
  const id = basename(filename, '.md')
  return id.length > 0 ? id : undefined
}

/** The write site's fact. Short on purpose — it is a change detector, not a
 *  security primitive, and it lands in every playbook event in the log. */
export function hashContent(content: string): string {
  return new Bun.CryptoHasher('sha256').update(content).digest('hex').slice(0, 12)
}

/**
 * Scan the directory into the domain's input shape, in directory order — the
 * order `decideReconcile` emits creations and updates in.
 *
 * A MISSING DIRECTORY IS AN EMPTY ONE: a dojo with no playbooks yet is the
 * normal case, and it must not read as "every playbook was deleted"… which
 * it would, if the caller treated the throw as a scan of nothing. Handled
 * here so the caller cannot get it wrong.
 */
export async function scanPlaybooks(dir: string): Promise<readonly PlaybookFile[]> {
  let filenames: string[]
  try {
    filenames = readdirSync(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return []
    throw err
  }

  const files: PlaybookFile[] = []
  for (const filename of filenames) {
    const id = idFromFilename(filename)
    if (id === undefined) continue
    try {
      const content = await Bun.file(resolve(dir, filename)).text()
      files.push({ id, content, hash: hashContent(content) })
    } catch (err) {
      // Vanished between the listing and the read — a real race with an
      // editor, and the file genuinely is gone, so leaving it out of the
      // scan is the honest answer.
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') continue
      throw err
    }
  }
  return files
}
