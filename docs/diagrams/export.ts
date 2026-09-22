/**
 * Export an HTML artboard with headless Chrome, once per colour scheme.
 *
 *   bun run export.ts <artboard.html> <out-dir> <basename> <w> <h> [query]
 *
 * `query`, if given, is appended to the file:// URL, so one artboard source can
 * produce more than one render when it reads the query itself.
 *
 * Produces <base>-light.png and <base>-dark.png at 2x device scale.
 *
 * Raw CDP over Bun's WebSocket: no puppeteer, no node_modules. The only
 * external binary is a Chrome.
 *
 * PNG is the shipping format on purpose. Chrome has no HTML -> SVG path, and
 * routing through PDF (Page.printToPDF, then `pdftocairo -svg`) outlines every
 * glyph — the resulting SVG has zero <text> elements, so it buys nothing over
 * a raster; layers.html is the greppable source.
 *
 * Point CHROME_PATH at a Chrome or chrome-headless-shell binary.
 */

import { resolve } from 'node:path'

const chromeFromEnv = process.env.CHROME_PATH
if (chromeFromEnv === undefined || chromeFromEnv.length === 0) {
  throw new Error('set CHROME_PATH to a Chrome or chrome-headless-shell binary')
}
const CHROME: string = chromeFromEnv

const [htmlArg, outDirArg, baseArg, wRaw, hRaw, query] = process.argv.slice(2)
if (htmlArg === undefined || outDirArg === undefined || baseArg === undefined) {
  throw new Error('usage: bun run export.ts <abs-artboard.html> <out-dir> <basename> [w] [h]')
}
const html = resolve(htmlArg)
const outDir = outDirArg
const base = baseArg
const width = Number(wRaw ?? 1280)
const height = Number(hRaw ?? 720)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function connect(port: number): Promise<WebSocket> {
  for (let i = 0; i < 80; i++) {
    await sleep(150)
    try {
      const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as {
        type: string
        webSocketDebuggerUrl: string
      }[]
      const page = list.find((t) => t.type === 'page')
      if (page === undefined) continue
      return await new Promise<WebSocket>((done, fail) => {
        const s = new WebSocket(page.webSocketDebuggerUrl)
        s.onopen = () => done(s)
        s.onerror = () => fail(new Error('ws refused'))
      })
    } catch {
      /* chrome is not listening yet */
    }
  }
  throw new Error('chrome never came up')
}

async function render(scheme: 'light' | 'dark'): Promise<void> {
  const port = scheme === 'light' ? 9411 : 9412
  const proc = Bun.spawn(
    [
      CHROME,
      `--remote-debugging-port=${port}`,
      '--headless',
      '--hide-scrollbars',
      '--disable-gpu',
      `--window-size=${width},${height}`,
      'about:blank',
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  )

  const ws = await connect(port)
  let seq = 0
  const pending = new Map<number, (v: any) => void>()
  ws.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data)) as { id?: number; result?: unknown }
    if (msg.id !== undefined) pending.get(msg.id)?.(msg.result)
  }
  const send = (method: string, params: unknown = {}) =>
    new Promise<any>((done) => {
      const id = ++seq
      pending.set(id, done)
      ws.send(JSON.stringify({ id, method, params }))
    })

  await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 2,
    mobile: false,
  })
  await send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: scheme }],
  })
  await send('Page.navigate', { url: `file://${html}${query === undefined ? '' : `?${query}`}` })
  await sleep(1200)

  const png = await send('Page.captureScreenshot', { format: 'png' })
  await Bun.write(`${outDir}/${base}-${scheme}.png`, Buffer.from(png.data, 'base64'))

  ws.close()
  proc.kill()
  console.log(`${base}-${scheme}.png`)
}

await render('light')
await render('dark')
