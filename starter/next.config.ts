import type { NextConfig } from "next"

// Matrix OS serves apps under /apps/<slug>: build and start with NEXT_BASE_PATH=/apps/bahn-ring.
// Empty locally. Client code reads the same value through withBase() in lib/base.ts.
const basePath = process.env.NEXT_BASE_PATH || ""

const config: NextConfig = { devIndicators: false, basePath, env: { NEXT_PUBLIC_BASE_PATH: basePath } }

export default config
