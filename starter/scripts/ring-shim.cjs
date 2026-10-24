// Preload for Ring's node scripts (tsx --require ./scripts/ring-shim.cjs ...).
// Next resolves "server-only" itself; plain node does not, so map it to this
// empty module. Also load the starter's env files (never prints values).
const Module = require("module")
const resolve = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
  if (request === "server-only") return __filename
  return resolve.call(this, request, ...rest)
}
for (const file of [".env.local", ".env"]) {
  try { process.loadEnvFile(file) } catch {}
}
