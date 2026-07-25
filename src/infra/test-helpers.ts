import type { OutboundMsg } from './protocol.ts'

export type ConnectedAgent = {
  ws: WebSocket
  messages: OutboundMsg[]
  /** Number of messages the CONNECT itself produced. `messages.slice(baselineCount)`
   *  is therefore "everything that happened because of what the test did next". */
  baselineCount: number
  [Symbol.dispose](): void
}

/** The server's connect-time greeting to a sensei, delivered 500ms AFTER the
 *  register is acked (see the register handler in server.ts). Matched by prefix
 *  so a wording change doesn't silently re-open the race below. */
const SENSEI_WELCOME_PREFIX = 'You just connected'

/** Upper bound on waiting for that greeting. Comfortably past the server's
 *  500ms, and if the greeting ever stops being sent the helper degrades to a
 *  slightly slow connect rather than a hang. */
const WELCOME_WAIT_MS = 1200

export function connectAgent(wsUrl: string, name: string, role: string = 'worker'): Promise<ConnectedAgent> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    const messages: OutboundMsg[] = []
    let resolved = false
    let welcomeTimer: ReturnType<typeof setTimeout> | undefined
    const make = (): ConnectedAgent => ({
      ws,
      messages,
      baselineCount: messages.length,
      [Symbol.dispose]() {
        ws.close()
      },
    })
    const finish = () => {
      if (resolved) return
      resolved = true
      clearTimeout(welcomeTimer)
      resolve(make())
    }
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'register', agent: name, role }))
    }
    ws.onmessage = (e) => {
      const msg = JSON.parse(String(e.data)) as OutboundMsg
      messages.push(msg)
      if (resolved) return
      if (msg.type === 'registered') {
        // A sensei connect produces TWO messages: the register ack, and the
        // server's greeting 500ms later. Resolving on the ack (or after a
        // guessed sleep — this used to wait 100ms) snapshots baselineCount
        // between them, so the greeting lands in the "caused by the test" slice
        // and reads as an unexpected infra deliver. That is a ~200ms-margin
        // race against the suite's own pacing: it passed on one machine and
        // failed 3/3 on another, costing a merge cycle (task 001, 2026-07-25).
        // Wait for the greeting ITSELF — deterministic, no margin to lose.
        if (role === 'sensei') {
          welcomeTimer = setTimeout(finish, WELCOME_WAIT_MS)
          return
        }
        finish()
        return
      }
      if (role === 'sensei' && msg.type === 'deliver' && msg.text?.startsWith(SENSEI_WELCOME_PREFIX)) {
        finish()
      }
    }
    ws.onerror = reject
    setTimeout(() => reject(new Error('timeout')), 3000)
  })
}
