// Matrix OS's gateway strips /apps/<slug> before it forwards a request to a node app
// (packages/gateway/src/app-runtime/dispatcher.ts: subPath = path.slice(prefix.length)).
// Our Next app is built with basePath=/apps/<slug> so the browser's URLs carry the prefix;
// this proxy puts the prefix back and pipes everything (streams included) to `next start`.
//
//   node prefix-proxy.mjs /apps/bahn-ring          (PORT from env, Next on PORT+1)
import { spawn } from "node:child_process"
import http from "node:http"

const prefix = process.argv[2]
const port = Number(process.env.PORT)
const inner = port + 1 // ponytail: fixed offset; pick a free port if Matrix ever packs apps on adjacent ports
if (!prefix?.startsWith("/") || !port) {
  console.error("usage: PORT=<port> node prefix-proxy.mjs /apps/<slug>")
  process.exit(2)
}

const next = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(inner), "-H", "127.0.0.1"], { stdio: "inherit" })
next.on("exit", (code) => process.exit(code ?? 1))
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => next.kill(sig))

const server = http.createServer((req, res) => {
  const path = req.url.startsWith(prefix) ? req.url : prefix + (req.url === "/" ? "" : req.url)
  const up = http.request({ host: "127.0.0.1", port: inner, method: req.method, path, headers: req.headers }, (r) => {
    res.writeHead(r.statusCode ?? 502, r.headers)
    r.pipe(res)
  })
  up.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end("app starting") })
  req.pipe(up)
})

// Open our port only once Next answers, so Matrix's health check never sees a half-started app.
const ready = () => http.get({ host: "127.0.0.1", port: inner, path: prefix }, (r) => { r.resume(); server.listen(port, "127.0.0.1") })
  .on("error", () => setTimeout(ready, 300))
ready()
