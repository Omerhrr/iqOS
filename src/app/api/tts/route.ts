// IQAIR//OS - Copilot voice: text-to-speech endpoint.
// Converts a copilot answer (markdown) into spoken audio via the z-ai SDK.
// Markdown is stripped, long answers are split into sentence-bounded chunks
// (SDK hard limit: 1024 chars/request), each chunk is synthesized as WAV and
// the PCM payloads are re-muxed under a single correct RIFF header.

import { NextRequest, NextResponse } from 'next/server'
import ZAI from 'z-ai-web-dev-sdk'

const VOICES = ['tongtong', 'chuichui', 'xiaochen', 'jam', 'kazi', 'douji', 'luodo']
const MAX_CHUNK = 900
const MAX_CHUNKS = 6

let zaiMemo: Promise<Awaited<ReturnType<typeof ZAI.create>>> | null = null
function getZAI() {
  if (!zaiMemo) zaiMemo = ZAI.create()
  return zaiMemo
}

/** Strip markdown + decoration down to speakable prose. */
function stripMarkdown(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' (code block omitted). ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\|.*\|\s*$/gm, '')
    .replace(/^\s*[-=_]{3,}\s*$/gm, '')
    // drop emoji/symbols that read badly
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Sentence-bounded chunks under MAX_CHUNK chars. */
function chunkText(text: string): string[] {
  if (text.length <= MAX_CHUNK) return [text]
  const sentences = text.match(/[^.!?]+[.!?]+(\s|$)/g) ?? [text]
  const chunks: string[] = []
  let cur = ''
  for (const s of sentences) {
    if ((cur + s).length > MAX_CHUNK && cur) {
      chunks.push(cur.trim())
      cur = ''
    }
    cur += s
  }
  if (cur.trim()) chunks.push(cur.trim())
  // hard-split any monster sentence
  return chunks
    .flatMap((c) => (c.length <= MAX_CHUNK ? [c] : (c.match(new RegExp(`.{1,${MAX_CHUNK}}(\\s|$)`, 'g')) ?? [c])))
    .map((c) => c.trim())
    .filter(Boolean)
}

/** Extract the fmt chunk + PCM payload from a RIFF/WAVE buffer. */
function parseWav(buf: Buffer): { channels: number; sampleRate: number; bits: number; pcm: Buffer } | null {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null
  let off = 12
  let channels = 0
  let sampleRate = 0
  let bits = 0
  const pcm: Buffer[] = []
  let sawFmt = false
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4)
    const size = buf.readUInt32LE(off + 4)
    if (id === 'fmt ' && size >= 16) {
      channels = buf.readUInt16LE(off + 10)
      sampleRate = buf.readUInt32LE(off + 12)
      bits = buf.readUInt16LE(off + 22)
      sawFmt = true
    } else if (id === 'data') {
      pcm.push(buf.subarray(off + 8, Math.min(off + 8 + size, buf.length)))
    }
    off += 8 + size + (size % 2) // chunk bodies are word-aligned
  }
  if (!sawFmt || !pcm.length || !channels || !sampleRate || !bits) return null
  return { channels, sampleRate, bits, pcm: Buffer.concat(pcm) }
}

/** Re-mux several same-format WAVs under one clean RIFF header. */
function mergeWavs(buffers: Buffer[]): Buffer | null {
  const parsed = buffers.map(parseWav)
  if (!parsed.length || parsed.some((p) => p === null)) return null
  const first = parsed[0]!
  if (parsed.some((p) => p!.channels !== first.channels || p!.sampleRate !== first.sampleRate || p!.bits !== first.bits)) return null
  const pcm = Buffer.concat(parsed.map((p) => p!.pcm))
  const byteRate = first.sampleRate * first.channels * (first.bits / 8)
  const blockAlign = first.channels * (first.bits / 8)
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(first.channels, 22)
  header.writeUInt32LE(first.sampleRate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(first.bits, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { text?: string; voice?: string; speed?: number }
    const clean = stripMarkdown(String(body.text ?? ''))
    if (!clean) return NextResponse.json({ error: 'no speakable text' }, { status: 400 })

    const voice = VOICES.includes(String(body.voice)) ? String(body.voice) : 'jam' // British-accented default fits the trading desk
    const speed = Math.min(2, Math.max(0.5, Number(body.speed ?? 1) || 1))
    const chunks = chunkText(clean).slice(0, MAX_CHUNKS)
    const zai = await getZAI()

    const buffers: Buffer[] = []
    for (const c of chunks) {
      const resp = await zai.audio.tts.create({ input: c, voice, speed, response_format: 'wav', stream: false })
      const ab = await resp.arrayBuffer()
      if (ab.byteLength === 0) throw new Error('empty audio chunk')
      buffers.push(Buffer.from(new Uint8Array(ab)))
    }
    // single chunk -> pass through untouched; multi chunk -> re-mux the PCM
    const out = buffers.length === 1 ? buffers[0] : mergeWavs(buffers)
    if (!out) throw new Error('failed to merge audio chunks')
    return new NextResponse(new Uint8Array(out), {
      status: 200,
      headers: { 'content-type': 'audio/wav', 'content-length': String(out.length), 'cache-control': 'no-store' },
    })
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message || 'tts failed' }, { status: 500 })
  }
}
