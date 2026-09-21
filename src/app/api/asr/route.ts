// IQAIR//OS - Copilot voice: speech-to-text endpoint.
// Accepts a base64 audio blob (16 kHz mono WAV produced by the copilot mic
// fallback, or any other browser-supported recording) and transcribes it via
// the z-ai SDK. Mirrors /api/tts so the copilot can listen as well as speak.

import { NextRequest, NextResponse } from 'next/server'
import ZAI from 'z-ai-web-dev-sdk'

const MAX_B64 = 24 * 1024 * 1024 // ~9 min of 16 kHz mono WAV - generous cap

let zaiMemo: Promise<Awaited<ReturnType<typeof ZAI.create>>> | null = null
function getZAI() {
  if (!zaiMemo) zaiMemo = ZAI.create()
  return zaiMemo
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { audioBase64?: string }
    // accept both raw base64 and full data URLs (client FileReader output)
    const b64 = String(body.audioBase64 ?? '').replace(/^data:[^,]*,/, '')
    if (!b64) return NextResponse.json({ error: 'no audio provided' }, { status: 400 })
    if (b64.length > MAX_B64) return NextResponse.json({ error: 'audio too large (keep it under ~60s)' }, { status: 413 })

    const zai = await getZAI()
    const r = await zai.audio.asr.create({ file_base64: b64 })
    const text = String(r?.text ?? '').trim()
    return NextResponse.json({ ok: true, text })
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message || 'asr failed' }, { status: 500 })
  }
}
