// Round-trip voice test: /api/tts (text -> wav) -> /api/asr (wav -> text).
// Validates the copilot's voice stack end to end without a browser mic.
const BASE = process.env.BASE || 'http://localhost:3000'
const PHRASE = process.env.PHRASE || 'What is the trend on EURUSD right now?'

async function main() {
  // 1) speak
  const t0 = Date.now()
  const ttsRes = await fetch(`${BASE}/api/tts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: PHRASE }),
  })
  if (!ttsRes.ok) throw new Error(`tts HTTP ${ttsRes.status}: ${await ttsRes.text()}`)
  const wav = Buffer.from(await ttsRes.arrayBuffer())
  console.log(`tts: ${wav.length} bytes in ${Date.now() - t0}ms, riff=${wav.toString('ascii', 0, 4)}`)

  // sanity: parse RIFF header (44-byte canonical PCM)
  if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAV')

  // 2) listen
  const t1 = Date.now()
  const asrRes = await fetch(`${BASE}/api/asr`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ audioBase64: `data:audio/wav;base64,${wav.toString('base64')}` }),
  })
  const d = await asrRes.json()
  console.log(`asr: ${Date.now() - t1}ms -> ${JSON.stringify(d)}`)
  if (!asrRes.ok || !d.text) throw new Error('asr failed')

  // 3) compare (normalize punctuation/case)
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim()
  const a = norm(PHRASE)
  const b = norm(d.text)
  const words = a.split(' ')
  const hit = words.filter((w) => b.includes(w)).length
  console.log(`match: ${hit}/${words.length} words, verbatim=${a === b}`)
  if (hit / words.length < 0.6) throw new Error('transcription too far from source')
  console.log('ROUND-TRIP OK')
}

main().catch((e) => {
  console.error('FAIL:', e.message)
  process.exit(1)
})
