// Scale measurements for the control room (see ../PROCESS.md, "Scale").
//   npx tsx --require ./scripts/ring-shim.cjs scripts/scale-measure.ts
// Env: APP_URL (default http://localhost:3000) for the HTTP and browser parts,
// PLAYWRIGHT_CORE (path to playwright-core's index.mjs) and CHROME (executable) for
// the browser part; it is skipped when playwright-core cannot be loaded.
// Prints one JSON line per measurement. Reads only; writes nothing.
import { gzipSync } from "node:zlib"
import { db } from "@/lib/db"
import { simNow } from "@/lib/agent/clock"
import { triageAll } from "@/lib/agent/story"

const APP = process.env.APP_URL ?? "http://localhost:3000"
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
const ms = (n: number) => Math.round(n)
const out = (what: string, v: Record<string, unknown>) => console.log(JSON.stringify({ what, ...v }))

async function server() {
  const now = await simNow()
  await triageAll(now) // warm the pool
  const times: number[] = []
  let n = 0
  for (let i = 0; i < 5; i++) { const t = performance.now(); n = (await triageAll(now)).length; times.push(performance.now() - t) }
  out("triageAll", { orders: n, medianMs: ms(median(times)), minMs: ms(Math.min(...times)) })
}

async function http() {
  for (const path of ["/api/agent/queue", "/api/overview"]) {
    await fetch(APP + path).then((r) => r.arrayBuffer())
    const times: number[] = []
    let bytes = 0, gz = 0
    for (let i = 0; i < 5; i++) {
      const t = performance.now()
      const buf = Buffer.from(await (await fetch(APP + path)).arrayBuffer())
      times.push(performance.now() - t); bytes = buf.length; gz = gzipSync(buf).length
    }
    out(path, { medianMs: ms(median(times)), kB: Math.round(bytes / 1024), gzipKB: Math.round(gz / 1024) })
  }
}

async function browser() {
  // playwright-core is not a dependency; load it from wherever it is installed.
  const spec: string = process.env.PLAYWRIGHT_CORE ?? "playwright-core"
  const pw = await import(spec).catch(() => null)
  if (!pw) { out("browser", { skipped: "playwright-core not found" }); return }
  const b = await pw.chromium.launch({ executablePath: process.env.CHROME ?? "/usr/bin/google-chrome" })
  const page = await b.newPage({ viewport: { width: 1440, height: 900 } })
  const lcp = () => page.evaluate(() => new Promise<number>((res) => {
    new PerformanceObserver((l) => { const e = l.getEntries(); res(e[e.length - 1].startTime) }).observe({ type: "largest-contentful-paint", buffered: true })
    setTimeout(() => res(-1), 3000)
  }))
  const nav = () => page.evaluate(() => { const n = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming; return { ttfb: n.responseStart, load: n.loadEventEnd } })

  for (let run = 0; run < 2; run++) { // run 0 warms the dev compiler
    const t = Date.now()
    await page.goto(APP + "/", { waitUntil: "load" })
    await page.waitForSelector("[data-row]", { timeout: 60_000 })
    const rowsAt = Date.now() - t
    const rows = await page.locator("[data-row]").count()
    // j/k: time from the key to the next painted frame, 20 presses.
    const keys = await page.evaluate(async () => {
      const lat: number[] = []
      for (let i = 0; i < 20; i++) {
        const t0 = performance.now()
        window.dispatchEvent(new KeyboardEvent("keydown", { key: i % 4 === 3 ? "k" : "j", bubbles: true }))
        await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)))
        lat.push(performance.now() - t0)
      }
      return lat.sort((a, b) => a - b)[Math.floor(lat.length * 0.9)]
    })
    const dom = await page.evaluate(() => document.querySelectorAll("*").length)
    if (run) out("queue page", { ...(await nav()), lcp: ms(await lcp()), rowsVisibleMs: rowsAt, rowsRendered: rows, domNodes: dom, jkP90Ms: ms(keys) })
  }
  for (const [what, path, sel] of [["map page", "/map", ".map-svg"], ["board page", "/board", ".card"]] as const) {
    for (let run = 0; run < 2; run++) {
      const t = Date.now()
      await page.goto(APP + path, { waitUntil: "load" })
      await page.waitForSelector(sel, { timeout: 60_000 })
      const at = Date.now() - t
      if (run) out(what, { ...(await nav()), lcp: ms(await lcp()), readyMs: at, domNodes: await page.evaluate(() => document.querySelectorAll("*").length) })
    }
  }
  await b.close()
}

server().then(http).then(browser).finally(() => db.$client.end())
