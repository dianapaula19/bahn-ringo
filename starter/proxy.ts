// Order ids are lower case (ord-00010). A typed ORD-00010 or a stray space redirects to the
// real id instead of a 404, for pages and APIs alike. The sidebar says "Places"; so may the URL.
import { NextResponse, type NextRequest } from "next/server"

export function proxy(request: NextRequest) {
  const url = request.nextUrl.clone()
  if (/^\/places(\/|$)/.test(url.pathname)) url.pathname = url.pathname.replace(/^\/places/, "/sites")
  try {
    url.pathname = url.pathname.replace(/\/orders\/([^/]+)/, (_, id: string) => `/orders/${encodeURIComponent(decodeURIComponent(id).trim().toLowerCase())}`)
  } catch { return NextResponse.next() } // malformed %-escape: let the route 404
  return url.pathname === request.nextUrl.pathname ? NextResponse.next() : NextResponse.redirect(url, 308)
}

export const config = { matcher: ["/places/:path*", "/orders/:id/:path*", "/api/orders/:id/:path*", "/api/agent/orders/:id/:path*"] }
