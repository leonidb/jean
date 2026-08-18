/**
 * The playbooks surface — list and get (design §5; task D-PB).
 *
 * The thinnest surface in the tree, because playbooks are read-only over
 * HTTP: the FILES are the source of truth and the reconciler is what writes
 * events, so there is no create/update/delete door to serve. Everything here
 * is a view rename.
 */

import { playbooks } from './../../domain/playbooks/index.ts'
import type { SurfaceContext } from './../context.ts'

export function playbookRoutes(ctx: SurfaceContext): (req: Request, url: URL) => Promise<Response | undefined> {
  const ID = /^\/playbooks\/([^/]+)$/

  return async (req, url) => {
    if (url.pathname === '/playbooks' && req.method === 'GET') {
      // The list is content-free by contract — the cheap read stays cheap.
      return ctx.json({ playbooks: playbooks.all(ctx.playbooksState()) })
    }
    const byId = ID.exec(url.pathname)
    if (byId?.[1] !== undefined && req.method === 'GET') {
      const playbook = playbooks.playbookOf(ctx.playbooksState(), decodeURIComponent(byId[1]))
      return playbook === undefined ? ctx.json({ error: 'no such playbook' }, 404) : ctx.json(playbook)
    }
    return undefined
  }
}
