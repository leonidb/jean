/**
 * Session liveness — the read-time half of attention phase 4 (docs/attention.md
 * §3). Infra bumps a `lastActivityAt` on any inbound traffic it already sees;
 * this module turns that observation into a session class.
 *
 * Pure: no registry, no clock of its own, no I/O. Callers pass what they
 * observed. Kept separate from server.ts so the classification rules — which
 * are role-asymmetric and easy to get subtly wrong — are unit-testable without
 * standing up a server.
 *
 * INVARIANT (binding): the result is a HINT. It is reported on GET /agents and
 * consumed by human/sensei judgment; nothing in the delivery path may branch on
 * it. A wrong classification must cost a slightly-stale board reading, never a
 * stalled queue.
 */

import type { AgentRole } from './protocol.ts'

export type AgentSession = 'active' | 'quiet' | 'offline'

/**
 * Per-role quiet thresholds, from the goals dojo's measured traffic (task 001):
 * sensei sessions are chatty (max real gap ~4 min), while workers routinely go
 * 10–30+ min silent on file/git/test work while at their busiest. One global
 * threshold would either flag every busy worker or blind us to a dead sensei.
 */
export const QUIET_THRESHOLD_DEFAULTS: Record<AgentRole, number> = {
  sensei: 10 * 60_000,
  worker: 45 * 60_000,
  librarian: 45 * 60_000,
  user: 45 * 60_000,
  peer: 45 * 60_000,
}

/** Positive-number env read; anything else (unset, NaN, ≤0) means "not set". */
export function envMs(name: string): number | undefined {
  const raw = Number(process.env[name])
  return Number.isFinite(raw) && raw > 0 ? raw : undefined
}

/** Per-role env override (`JEAN_QUIET_THRESHOLD_SENSEI_MS`) wins over the global
 *  one (`JEAN_QUIET_THRESHOLD_MS`), which wins over the role default. */
export function quietThresholdMs(role: AgentRole): number {
  return (
    envMs(`JEAN_QUIET_THRESHOLD_${role.toUpperCase()}_MS`) ??
    envMs('JEAN_QUIET_THRESHOLD_MS') ??
    QUIET_THRESHOLD_DEFAULTS[role]
  )
}

export type LivenessObservation = {
  role: AgentRole
  /** Epoch ms of the last inbound traffic FROM THE AGENT ITSELF. Undefined when
   *  nothing has ever been observed — which includes entries infra created on
   *  an agent's behalf (a bridge registering a chat surface). Registration by
   *  infra is not the human's act, so it must not read as activity. */
  lastActivityAt?: number
  /** False when the transport is known dead (a WS whose close handler hasn't
   *  run yet). Undefined for transports with no liveness check. */
  transportLive?: boolean
}

/**
 * Classify a session. `offline` beats everything — a dead transport is dead
 * whatever it said a second ago. With no observed traffic the honest answer is
 * `quiet`, never `active`: absence of evidence is not evidence of presence.
 */
export function classifySession(obs: LivenessObservation, now: number): AgentSession {
  if (obs.transportLive === false) return 'offline'
  if (obs.lastActivityAt === undefined) return 'quiet'
  return now - obs.lastActivityAt <= quietThresholdMs(obs.role) ? 'active' : 'quiet'
}
