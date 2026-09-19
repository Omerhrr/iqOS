// SSE client bisect: does the 'final' event survive the Next.js dev server?
const BODY = {
  sessionId: 'default',
  message: 'Set up my EURUSD chart for analysis: add Ichimoku and Parabolic SAR overlays and a Stochastic sub-pane, then explain what each is telling me in two bullets.',
  ui: { asset: 'EURUSD', tf: '1m', chartType: 'candles' },
}

const res = await fetch('http://localhost:81/api/agent', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(BODY),
})
console.log('status:', res.status, res.headers.get('content-type'))

const reader = res.body!.getReader()
const dec = new TextDecoder()
let buf = ''
const types: string[] = []
let finished = false
for (;;) {
  const { done, value } = await reader.read()
  if (done) break
  buf += dec.decode(value, { stream: true })
  let idx: number
  while ((idx = buf.indexOf('\n\n')) >= 0) {
    const chunk = buf.slice(0, idx)
    buf = buf.slice(idx + 2)
    for (const line of chunk.split('\n')) {
      if (!line.startsWith('data: ')) continue
      try {
        const ev = JSON.parse(line.slice(6)) as { type: string; tool?: string; ok?: boolean; preview?: string; args?: unknown }
        types.push(ev.type)
        if (ev.type === 'final') console.log('FINAL TEXT:', (ev as { text?: string }).text?.slice(0, 160))
        if (ev.type === 'tool_end' && ev.ok === false) console.log('FAILED TOOL:', ev.tool, '->', ev.preview?.slice(0, 200))
        if (ev.type === 'tool_end' && ev.ok === true) console.log('ok tool:', ev.tool, (ev.preview ?? '').slice(0, 110))
      } catch {
        console.log('UNPARSEABLE CHUNK:', JSON.stringify(line.slice(0, 120)))
      }
    }
  }
}
finished = true
console.log('stream ended. events:', JSON.stringify(types))
console.log('leftover buf:', JSON.stringify(buf.slice(0, 200)))
