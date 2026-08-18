/**
 * What a surface is allowed to see (task E2).
 *
 * The server owns the folded state, the store and the sessions; a surface
 * owns one module's routes. This type is the seam between them, and it is
 * deliberately narrow: a surface can READ the projections and APPEND through
 * the one write path, and it cannot reach the projections' variables to
 * assign one. Every fold in the process therefore still happens in `absorb`,
 * which is what stops a handler from updating one projection and forgetting
 * another.
 *
 * The facts here are COMPOSED from their owning contracts (R10) — the server
 * builds them once and hands the same closures to every surface, so two
 * surfaces cannot form different opinions about who is on the roster or who
 * holds the orchestrator's seat.
 */

import type { PlaybooksState } from './../domain/contracts/playbooks.ts'
import type { TasksState } from './../domain/contracts/tasks.ts'
import type { TriggersState } from './../domain/contracts/triggers.ts'
import type { AgentName, AgentRole } from './../domain/contracts/vocabulary.ts'
import type { StoredEvent } from './../es/index.ts'

/** Who is asking, as the shell could work it out. `connected` is a transport
 *  fact; `role` is the agents contract's answer, live session included. */
export type Caller = { name?: AgentName; role?: AgentRole; connected: boolean }

export type SurfaceContext = {
  json: (value: unknown, status?: number) => Response
  /** Parse a JSON body, or `null` when it is not JSON at all. Grammar. */
  body: (req: Request) => Promise<Record<string, unknown> | null>
  /** Who is asking: the header, the query, or — third parameter — a value
   *  the SURFACE knows names its caller. Never a generic body field: `agent`
   *  means addressee, subject and target on different routes, so a reader
   *  that guessed would credit a task's new assignee with reassigning it. */
  callerOf: (req: Request, url: URL, claimed?: string) => Caller
  /** The ONE write path: append, fold every projection, append whatever the
   *  domain says must follow (the A-SUB forward half). */
  record: (type: string, stream: string, data: unknown) => Promise<StoredEvent>
  /** The log, read — one door, the store's own options. */
  read: (opts?: { stream?: string; types?: string[]; afterId?: number }) => Promise<readonly StoredEvent[]>
  now: () => number
  /** The agent's own act — never the handshake (R8). */
  observeActivity: (name: AgentName) => void

  tasksState: () => TasksState
  triggersState: () => TriggersState
  playbooksState: () => PlaybooksState
  isRosterMember: (name: AgentName) => boolean
  orchestratorOf: () => AgentName | undefined
  roleOf: (name: AgentName) => AgentRole | undefined
  /** Epoch ms of the last event on a task's own stream — the caller's fact
   *  that `staleTasks` takes, kept by the shell because it is stream
   *  bookkeeping and not a board question. */
  lastEventAt: (taskId: string) => number | undefined
  staleAfterMs: number

  /** Where the dojo's files live (`.jean`), when this server has a data dir
   *  at all. Absent in-memory, which is how tests run without a wiki. */
  dataDir?: string
  /** Search telemetry — best-effort, never a reason to fail a search. */
  logRetrieval: (record: Record<string, unknown>) => void
}
