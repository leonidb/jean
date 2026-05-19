import type { OutboundMsg } from './protocol.ts'

export type ConnectedAgent = {
  ws: WebSocket
  messages: OutboundMsg[]
  baselineCount: number
  [Symbol.dispose](): void
}

export function connectAgent(wsUrl: string, name: string, role: string = 'worker'): Promise<ConnectedAgent> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    const messages: OutboundMsg[] = []
    let resolved = false
    const make = (): ConnectedAgent => ({
      ws,
      messages,
      baselineCount: messages.length,
      [Symbol.dispose]() {
        ws.close()
      },
    })
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'register', agent: name, role }))
    }
    ws.onmessage = (e) => {
      const msg = JSON.parse(String(e.data)) as OutboundMsg
      messages.push(msg)
      if (msg.type === 'registered' && !resolved) {
        resolved = true
        // For sensei, wait a tick so the connect-time nudge lands in `messages`
        // and is counted in `baselineCount`.
        if (role === 'sensei') {
          setTimeout(() => resolve(make()), 100)
        } else {
          resolve(make())
        }
      }
    }
    ws.onerror = reject
    setTimeout(() => reject(new Error('timeout')), 3000)
  })
}
