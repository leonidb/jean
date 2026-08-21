/**
 * Hosting the non-socket surfaces — the chat bridge and the peer dojos
 * (task G1-WIRE, closing the stop-the-switch finding from 111).
 *
 * ── WIRING, NOT DESIGN ──
 *
 * Both of these were already possible: E3 built the seam
 * (`attachSurface`/`postInbound`) precisely so a surface with no socket could
 * join on the ordinary paths. What was missing was the launcher calling it,
 * which is why the new server would have started with the human channel dark
 * and every peer send reported undelivered. Nothing below decides anything —
 * a bridge is a `user`-role session whose transport is Telegram or Slack, and
 * a peer is a `peer`-role session whose transport is another dojo's `/send`.
 *
 * ── AND BOTH KEEP THEIR OLD TRANSPORTS ──
 *
 * `src/infra/bridge.ts` and `src/infra/peers.ts` are NOT part of the rewrite:
 * H2's deletion list names the server, the core, the reducers and the old
 * suite, and leaves these two standing. They are transport modules with their
 * own contracts, and re-implementing them for the switch would be inventing
 * work under time pressure — the seam exists so they can be used as they are.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { AgentRole, HeadlessCompletedData, WikiConsolidatedData } from '../domain/contracts/vocabulary.ts'
import { type Bridge, type BridgeHealth, selectBridge } from '../infra/bridge.ts'
import type { JeanConfig } from '../infra/config.ts'
import { commitConsolidation, probeAnthropicAPI, recoverWikiLayout, spawnHeadless } from '../infra/librarian.ts'
import { createPeerDeliver, type Peer } from '../infra/peers.ts'
import { consolidatorPaths, discardDraftPlan, type HeadlessPorts } from './headless.ts'
import type { AdapterHandle } from './server.ts'

/** What `/status` says about the chat surface. `configured: false` is the
 *  honest answer for a dojo with no bridge in its config — as opposed to the
 *  inference from live sessions the adapter made before, which reported the
 *  same thing about a bridge that was configured and simply had not been
 *  started. */
export type BridgeStatus = { configured: false } | ({ configured: true; kind: string; target: string } & BridgeHealth)

export type Hosting = {
  /** Live status for `/status`, read at request time — a wedged poll loop
   *  cannot report on itself, so the ages are computed by the reader. */
  bridgeStatus: () => BridgeStatus
  /**
   * The transport's health for ONE agent, and only if that agent IS the
   * bridge — otherwise undefined.
   *
   * Keyed on the name the bridge actually registered under, not on
   * `role === 'user'`. The role is a category and a dojo may hold several
   * user-role surfaces; hanging poll counters on all of them would report a
   * Telegram connection's health against a person. The cancelled branch that
   * first built this surface pinned exactly that ("transport fields must not
   * leak onto non-bridge agents, including user-role"), and it was the one
   * piece of it worth salvaging.
   */
  transportFor: (agent: string) => BridgeHealth | undefined
  /** Start the bridge, if one is configured. Resolves once connected. */
  start: () => Promise<void>
}

/**
 * Attach every peer in `.jean/peers.json` as a session.
 *
 * A peer is another dojo's sensei, reachable over its infra's HTTP `/send`.
 * Registering it as a `peer`-role session is what makes the ordinary routing
 * decision reach it: `decideSend` sees a live non-mailbox-holding role and
 * hands the message to the adapter leg, which is this deliver.
 *
 * DESCRIPTIONS ARE LOCAL AND STAY LOCAL — the routing contract's enrichment
 * rule ("a peer cannot rewrite its description per message") is served by
 * `peerDescriptionOf`, which reads this same file, and not by anything on the
 * wire.
 */
export function attachPeers(
  handle: AdapterHandle,
  peers: Record<string, Peer>,
  log: (line: string) => void,
  myIdentity: string,
): void {
  for (const [name, peer] of Object.entries(peers)) {
    const deliver = createPeerDeliver({
      peer,
      myIdentity,
      peerName: name,
      // The sender learns their message did not get through. The POST is
      // async, so a mid-flight failure cannot flip the synchronous boolean
      // the routing decision already acted on — this is the only path by
      // which the truth reaches them.
      onUndelivered: (sender, reason) => {
        void handle
          .notify(sender, `Your message to "${name}" was NOT delivered — ${reason}. Nothing was sent.`)
          .catch(() => {})
      },
    })
    try {
      handle.attachSurface({
        name,
        role: 'peer',
        sessionId: `peer:${name}`,
        deliver: (payload) => {
          const msg = payload as { from?: unknown; text?: unknown; taskId?: unknown }
          if (typeof msg.text !== 'string') return false
          return deliver({
            from: typeof msg.from === 'string' ? msg.from : myIdentity,
            text: msg.text,
            ...(typeof msg.taskId === 'string' && { taskId: msg.taskId }),
          })
        },
      })
      log(`[jean:new] peer attached: ${name}\n`)
    } catch (err) {
      // A peer that cannot take its seat must not stop the dojo starting —
      // it is one correspondent, and the refusal names itself.
      log(`[jean:new] peer ${name} not attached: ${String(err)}\n`)
    }
  }
}

/**
 * The chat bridge, on the same seam.
 *
 * INBOUND is the human's own message and goes through `postInbound` — the
 * same path a WS `reply` frame takes, carrying `sentAt` and `sourceId` so a
 * burst of messages keeps its order instead of collapsing onto one
 * record-time.
 *
 * OUTBOUND needs nothing special at all: the bridge registers as a
 * `user`-role session, so routing hands its mail to the adapter leg exactly
 * as it does for any non-mailbox-holder, and the deliver below is the
 * transport.
 */
export function createHosting(
  handle: AdapterHandle,
  config: JeanConfig,
  dataDir: string,
  log: (line: string) => void,
  /** THE TRANSPORT, INJECTABLE — and only so it can be driven. `selectBridge`
   *  builds a real Telegram or Slack client from config, which left this whole
   *  module untestable: the identity-matching below decides whether transport
   *  counters can land on a person's row, and it had no test because there was
   *  no way to attach a bridge without a wire (codex pass, task 121).
   *  Production passes nothing and gets `selectBridge`. */
  bridgeOverride?: Bridge | null,
): Hosting {
  const bridge: Bridge | null = bridgeOverride === undefined ? selectBridge(config) : bridgeOverride
  /** The name the bridge registered under — learned at attach, because only
   *  the transport knows it (a Telegram chat's title, else `chat-<id>`). */
  let attachedAs: string | undefined

  return {
    bridgeStatus: () => {
      if (bridge === null) return { configured: false }
      return { configured: true, kind: bridge.kind, target: bridge.target, ...bridge.health() }
    },

    transportFor: (agent) =>
      bridge !== null && attachedAs !== undefined && agent === attachedAs ? bridge.health() : undefined,

    async start() {
      if (bridge === null) return
      await bridge.start({
        register: (name, send) => {
          // NO ACTIVITY IS STAMPED. Bridge registration is infra's act at
          // boot, not the human's — stamping it would make a chat surface
          // silent for months read as active for the next stretch after
          // every restart. The human's traffic is their inbound message.
          handle.attachSurface({
            name,
            role: 'user',
            sessionId: `bridge:${bridge.kind}`,
            deliver: (payload) => {
              const msg = payload as { from?: unknown; text?: unknown; attachments?: unknown }
              if (typeof msg.text !== 'string') return false
              return send({
                from: typeof msg.from === 'string' ? msg.from : 'infra',
                text: msg.text,
                ...(Array.isArray(msg.attachments) && { attachments: msg.attachments as string[] }),
              })
            },
          })
          attachedAs = name
          log(`[jean:new] bridge attached: ${name} (${bridge.kind})\n`)
        },

        onInbound: (name, text, meta) => {
          void handle.postInbound(name, text, meta).catch((err: unknown) => {
            log(`[jean:new] inbound from ${name} not recorded: ${String(err)}\n`)
          })
        },

        // The bridge owns the wire; the dojo's filesystem is the host's.
        saveAttachment: (data, filename) => {
          const dir = resolve(dataDir, 'inbox')
          mkdirSync(dir, { recursive: true })
          const dest = resolve(dir, `${Date.now()}-${filename.replace(/[^\w.-]/g, '_')}`)
          writeFileSync(dest, data)
          return dest
        },
      })
    },
  }
}

// ── The headless spawn ports ─────────────────────────────────────
//
// The transports the headless runner needs, built from the modules that
// already own them. `src/infra/librarian.ts` is not part of the rewrite —
// H2's list leaves it standing beside the bridge and the peers — and it
// holds the process spawn, the API probe, the wiki-layout recovery and the
// commit. Re-implementing any of them for tonight's consolidation would be
// exactly the invention the switch day forbids.

/** Build the ports from the dojo's own paths. `record` and `log` come from
 *  the server, which owns the log and the writer. */
export function headlessPorts(args: {
  dataDir: string
  now: () => number
  log: (line: string) => void
  record: (data: HeadlessCompletedData) => Promise<unknown>
  recordConsolidated: (data: WikiConsolidatedData) => Promise<unknown>
}): HeadlessPorts {
  const dojoRoot = resolve(args.dataDir, '..')
  return {
    now: args.now,
    log: args.log,
    record: args.record,

    async spawn(spec) {
      try {
        const result = await spawnHeadless({
          dojoRoot,
          role: spec.role as AgentRole,
          prompt: spec.prompt,
          ...(spec.model !== undefined && { model: spec.model }),
          streamSinkPath: spec.streamSinkPath,
          // THE DECISION'S BOUND, enforced here. The old path had the port
          // choose an ambient number nobody declared.
          timeoutMs: spec.timeoutMs,
        })
        return {
          kind: 'ran',
          exitCode: result.exitCode,
          durationMs: result.durationMs,
          timedOut: result.timedOut,
          stderr: result.stderr,
          ...(result.parsed !== undefined && { parsed: result.parsed }),
        }
      } catch (err) {
        // The spawn never happened — a missing role directory, a missing
        // binary. The -1 sentinel is the decision's to write; this only
        // reports what it was.
        return { kind: 'spawn-failed', message: String(err) }
      }
    },

    probe: () => probeAnthropicAPI(),

    async prepare() {
      try {
        const recovered = recoverWikiLayout(dojoRoot)
        if (recovered.recovered !== 'none') args.log(`[jean:new] wiki layout recovered (${recovered.recovered})\n`)
        return { ok: true }
      } catch (err) {
        return { ok: false, message: `wiki layout recovery failed: ${String(err)}` }
      }
    },

    async commit() {
      const result = await commitConsolidation({ dojoRoot, recordEvent: args.recordConsolidated })
      args.log(
        `[jean:new] consolidation committed — swapped=${result.swapped} pages=${result.pageCount} anomalies=${result.emitted.anomalies?.length ?? 0}\n`,
      )
    },

    discardDraft: () => discardDraftPlan(args.dataDir),

    // THE DRAFT'S ARTIFACT IS THE POST CHECK. An exit-0 draft that produced
    // no plan is a failure — and the reason review can trust its input.
    postCheck: (phaseTag) => (phaseTag === 'draft' ? existsSync(consolidatorPaths(args.dataDir).planPath) : undefined),

    wait: (ms) => Bun.sleep(ms),
  }
}
