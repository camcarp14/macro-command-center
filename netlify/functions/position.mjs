// The single open MSTR position (v1: one position, long-only). The stop
// discipline lives client-side in the risk engine; this stores the facts.
import { json, checkAuth, unauthorized, store } from '../shared/util.mjs'
import { validatePosition } from '../shared/validate.mjs'

export default async (req) => {
  if (!checkAuth(req)) return unauthorized()
  const s = store()

  if (req.method === 'GET') {
    const position = await s.get('position', { type: 'json' })
    return json({ position: position || null })
  }

  if (req.method === 'PUT') {
    const body = await req.json().catch(() => null)
    const v = validatePosition(body)
    if (!v.ok) return json({ error: 'validation failed', errors: v.errors }, 400)
    // The stop high-water mark survives edits and only ratchets up — this is
    // what makes "the stop only ever rises" hold across position blends and
    // settings changes. It resets only when the position is cleared.
    const prev = await s.get('position', { type: 'json' })
    const stopHighWater = Math.max(
      prev?.stopHighWater ?? -Infinity,
      v.value.initialStop,
      v.value.stopOverride ?? -Infinity,
    )
    const position = { ...v.value, stopHighWater: Number.isFinite(stopHighWater) ? stopHighWater : null, updatedAt: Date.now() }
    await s.setJSON('position', position)
    return json({ position })
  }

  if (req.method === 'DELETE') {
    await s.delete('position')
    return json({ position: null })
  }

  return json({ error: 'method not allowed' }, 405)
}
