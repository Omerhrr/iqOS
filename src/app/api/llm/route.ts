import { NextResponse } from 'next/server'
import { providerStatus } from '@/lib/llm'

export const dynamic = 'force-dynamic'

/** GET /api/llm — which providers are enabled/ready, models, endpoints. */
export async function GET() {
  return NextResponse.json({ ok: true, ...providerStatus() })
}
