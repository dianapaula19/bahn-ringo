// Prefix for raw URLs (fetch, <img>, <a>) when the app runs under a base path (see next.config.ts).
// <Link> and the router add it themselves; next/image and plain fetch do not.
export const withBase = (path: string) => `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}${path}`
