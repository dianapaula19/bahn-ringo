// Prefix for raw URLs (fetch, <img>, <a>) when the app runs under a base path (see next.config.ts).
// <Link> and the router add it themselves; next/image and plain fetch do not.
export const withBase = (path: string) => `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}${path}`

// Inside Matrix OS an app only works in the shell's window: a new browser tab lands on Matrix's
// "Refreshing session…" page. So internal links open in a new tab only when there is no base path.
export const newTab = process.env.NEXT_PUBLIC_BASE_PATH ? {} : { target: "_blank", rel: "noopener noreferrer" }
