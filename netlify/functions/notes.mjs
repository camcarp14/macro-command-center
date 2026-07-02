import { checkAuth, unauthorized, json, store } from '../shared/util.mjs'

// Manual thesis timeline ("Oracle CDS widened", etc). Lives next to the
// automated data on the Thesis tab.
export default async (req) => {
  if (!checkAuth(req)) return unauthorized()
  const s = store()
  const notes = (await s.get('thesis_notes', { type: 'json' })) || []
  if (req.method === 'GET') return json({ notes })
  if (req.method === 'POST') {
    const { text } = await req.json()
    if (!text || typeof text !== 'string' || text.length > 2000) return json({ error: 'text required (<=2000 chars)' }, 400)
    notes.push({ ts: Date.now(), text: text.trim() })
    await s.setJSON('thesis_notes', notes.slice(-500))
    return json({ notes: notes.slice(-500) })
  }
  if (req.method === 'DELETE') {
    const ts = Number(new URL(req.url).searchParams.get('ts'))
    const next = notes.filter((n) => n.ts !== ts)
    await s.setJSON('thesis_notes', next)
    return json({ notes: next })
  }
  return json({ error: 'method not allowed' }, 405)
}
