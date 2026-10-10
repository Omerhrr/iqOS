import { NextResponse, type NextRequest } from 'next/server'

// P0 security: the trading kernel validates an x-kernel-token header whenever
// KERNEL_TOKEN is set (trading-core/index.ts). The browser talks to the kernel
// through the ?XTransformPort= rewrite (next.config.ts), and rewrites cannot
// inject request headers - middleware does it here instead, so the token stays
// server-side (agent route, keeper route, this rewrite path) and never reaches
// the browser bundle. Caveat (same story as KERNEL_URL in next.config.ts):
// process.env.KERNEL_TOKEN is evaluated at BUILD time inside middleware - the
// Docker web image takes it as a build arg (see Dockerfile /
// docker-compose.yml), so rotating the token means rebuilding the web image.
export function middleware(req: NextRequest) {
  const token = process.env.KERNEL_TOKEN
  if (!token || !req.nextUrl.searchParams.has('XTransformPort')) return NextResponse.next()
  const headers = new Headers(req.headers)
  headers.set('x-kernel-token', token)
  return NextResponse.next({ request: { headers } })
}

export const config = {
  // Only the OS-shell paths can ever need the kernel - skip static assets.
  matcher: ['/((?!_next/|favicon.ico|robots.txt|logo.svg).*)'],
}
