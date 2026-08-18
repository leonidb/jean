/**
 * The triggers surface — CRUD and fire (design §5; task E2).
 *
 * The thinnest of the three, and deliberately so: the old handler carried
 * eleven inline validations, each with its own `Response.json(…, 400)`, and
 * every one of them is now a typed refusal from `triggers.decideCreate`. What
 * is left here is the two things the contract says are the shell's —
 * NONDETERMINISM (minting an id when the caller supplies none) and AMBIENT
 * FACTS (cron syntax validity, which is a library call).
 *
 * ── THE UPDATE BODY IS PASSED THROUGH RAW, ON PURPOSE ──
 *
 * `decideUpdate` takes `fields: Record<string, unknown>` because REFUSING an
 * unknown field is its job. A shell that pre-filtered to the known keys would
 * perform exactly the silent drop the refusal exists to prevent — the caller
 * would get a 200 and a trigger that ignored half of what it asked for. So
 * this file does not look inside the body at all.
 *
 * ── FIRING APPENDS ONE EVENT ──
 *
 * `trigger-fired`, and nothing else. The old fire wrote a `send` alongside it
 * so the prompt would reach the target's session; under the rewrite's
 * resolution table an agent-kind firing ALREADY resolves to the target's
 * mailbox, so a second event would put the same prompt in that mailbox twice.
 * The delivery half — pushing the prompt to a live session, spawning the
 * headless run — is an outbound listener, which is E3's.
 */

import { Cron } from 'croner'
import type { AgentRole } from './../../domain/contracts/vocabulary.ts'
import { TRIGGERS_STREAM } from './../../domain/contracts/vocabulary.ts'
import { triggers } from './../../domain/triggers/index.ts'
import type { SurfaceContext } from './../context.ts'
import { renameTriggerRefusal } from './../refusals.ts'

/** The roles a headless trigger may spawn under. Same table shape as the
 *  server's `ROLES`, and for the same reason: a role added to the vocabulary
 *  fails the build here rather than being quietly unspawnable. */
const ROLE_TABLE: Record<AgentRole, true> = { sensei: true, worker: true, user: true, peer: true, librarian: true }
export const VALID_ROLES = Object.keys(ROLE_TABLE) as readonly AgentRole[]

/** The ambient fact the contract injects rather than importing: whether a
 *  string is a cron expression at all. croner is the library; the domain
 *  never learns its name. */
export function isValidCron(expr: string): boolean {
  try {
    new Cron(expr)
    return true
  } catch {
    return false
  }
}

export function triggerRoutes(ctx: SurfaceContext): (req: Request, url: URL) => Promise<Response | undefined> {
  const refuse = (renamed: ReturnType<typeof renameTriggerRefusal>) => ctx.json(renamed.body, renamed.status)

  async function create(req: Request, url: URL): Promise<Response> {
    const body = await ctx.body(req)
    if (body === null) return ctx.json({ error: 'body must be a JSON object' }, 400)
    // GRAMMAR, and the one field that needs it here. `kind` and `retries`
    // reach the decision RAW because `decideCreate` has typed refusals for
    // both (`invalid-kind`, `invalid-retries` — its `got: unknown` says so).
    // `metadata` has NO create-time check in the domain, so an array or a
    // null cast into `Record<string, unknown>` would be the adapter asserting
    // a type it never checked, into a permanent log. Refused as malformed
    // input, which is the only kind of refusal this file authors (codex pass,
    // task 103 — and the asymmetry with `decideUpdate`'s `invalid-metadata`
    // is flagged to the architect, not papered over).
    if (
      body.metadata !== undefined &&
      (typeof body.metadata !== 'object' || body.metadata === null || Array.isArray(body.metadata))
    ) {
      return ctx.json({ error: 'metadata must be a JSON object (not an array)' }, 400)
    }
    // `agent` in a trigger body is its TARGET, never its author — the caller
    // is named by `actor`, the header, or not at all.
    const caller = ctx.callerOf(req, url, typeof body.actor === 'string' ? body.actor : undefined)
    // THE ID IS THE SHELL'S: the contract takes it as a command field
    // precisely so the domain stays deterministic (design §5). A caller may
    // name its own — the CLI does, for triggers a human types the name of.
    const id = typeof body.id === 'string' && body.id.length > 0 ? body.id : crypto.randomUUID().slice(0, 8)
    const decision = triggers.decideCreate(
      ctx.triggersState(),
      {
        id,
        agent: typeof body.agent === 'string' ? body.agent : '',
        prompt: typeof body.prompt === 'string' ? body.prompt : '',
        actor: caller.name ?? 'api',
        ...(typeof body.cron === 'string' && { cron: body.cron }),
        ...(typeof body.at === 'string' && { at: body.at }),
        ...(body.kind !== undefined && { kind: body.kind as 'agent' | 'headless' }),
        ...(typeof body.model === 'string' && { model: body.model }),
        ...(body.retries !== undefined && { retries: body.retries as number }),
        ...(body.metadata !== undefined && { metadata: body.metadata as Record<string, unknown> }),
      },
      { isValidCron, validRoles: VALID_ROLES },
    )
    if (!decision.ok) return refuse(renameTriggerRefusal(decision.refusal))
    await ctx.record('trigger-created', TRIGGERS_STREAM, decision.data)
    if (caller.name !== undefined) ctx.observeActivity(caller.name)
    return ctx.json(triggers.triggerOf(ctx.triggersState(), id), 201)
  }

  function list(url: URL): Response {
    const status = url.searchParams.get('status')
    const agent = url.searchParams.get('agent')
    const selected = triggers
      .all(ctx.triggersState())
      .filter(
        (t) =>
          (status === null || status === '' || t.status === status) &&
          (agent === null || agent === '' || t.agent === agent),
      )
    return ctx.json({ triggers: selected })
  }

  async function update(id: string, req: Request): Promise<Response> {
    const body = await ctx.body(req)
    if (body === null) return ctx.json({ error: 'body must be a JSON object' }, 400)
    // RAW, deliberately — see the header. The unknown-field refusal is the
    // decision's, and pre-filtering here would delete it.
    const decision = triggers.decideUpdate(ctx.triggersState(), { id, fields: body })
    if (!decision.ok) return refuse(renameTriggerRefusal(decision.refusal))
    await ctx.record('trigger-updated', TRIGGERS_STREAM, decision.data)
    return ctx.json(triggers.triggerOf(ctx.triggersState(), id))
  }

  async function remove(id: string): Promise<Response> {
    const decision = triggers.decideRemove(ctx.triggersState(), id)
    if (!decision.ok) return refuse(renameTriggerRefusal(decision.refusal))
    await ctx.record('trigger-removed', TRIGGERS_STREAM, decision.data)
    return ctx.json({ ok: true, id })
  }

  async function fire(id: string): Promise<Response> {
    const trigger = triggers.triggerOf(ctx.triggersState(), id)
    if (trigger === undefined) return refuse(renameTriggerRefusal({ kind: 'unknown-trigger', id }))
    await ctx.record('trigger-fired', TRIGGERS_STREAM, triggers.fireData(trigger))
    return ctx.json({ ok: true, triggerId: id })
  }

  const ID = /^\/triggers\/([^/]+)$/
  const FIRE = /^\/triggers\/([^/]+)\/fire$/

  return async (req, url) => {
    const path = url.pathname
    if (path === '/triggers' && req.method === 'POST') return create(req, url)
    if (path === '/triggers' && req.method === 'GET') return list(url)

    const firing = FIRE.exec(path)
    if (firing?.[1] !== undefined && req.method === 'POST') return fire(decodeURIComponent(firing[1]))

    const byId = ID.exec(path)
    if (byId?.[1] !== undefined) {
      const id = decodeURIComponent(byId[1])
      if (req.method === 'GET') {
        const trigger = triggers.triggerOf(ctx.triggersState(), id)
        return trigger === undefined ? refuse(renameTriggerRefusal({ kind: 'unknown-trigger', id })) : ctx.json(trigger)
      }
      if (req.method === 'PATCH') return update(id, req)
      if (req.method === 'DELETE') return remove(id)
    }
    return undefined
  }
}
