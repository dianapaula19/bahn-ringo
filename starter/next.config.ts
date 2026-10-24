import type { NextConfig } from "next"

// Matrix OS serves apps under /apps/<slug>: build and start with NEXT_BASE_PATH=/apps/bahn-ring.
// Empty locally. Client code reads the same value through withBase() in lib/base.ts.
const basePath = process.env.NEXT_BASE_PATH || ""

// trailingSlash under a base path: Matrix scopes the app session cookie to "/apps/<slug>/", so a link to
// "/apps/bahn-ring" (no slash) arrives without it and Matrix asks the user to sign in again.
const config: NextConfig = { devIndicators: false, basePath, trailingSlash: Boolean(basePath), env: { NEXT_PUBLIC_BASE_PATH: basePath } }

export default config
