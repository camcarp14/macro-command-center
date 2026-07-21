// Polish primitives — pairs with the system classes in styles.css.
// No router in this app: CommandK takes action items with run() callbacks.
import React, { useState, useEffect, useRef, useMemo, createContext, useContext } from 'react'

/* ---- numbers count to their value (ease-out cubic); tabular-nums in CSS ----
   Gated on prefers-reduced-motion like every CSS animation in the system. */
export function useTween(target, dur = 700) {
  const [v, setV] = useState(target ?? 0)
  const fromRef = useRef(target ?? 0)
  useEffect(() => {
    if (target == null) return
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      fromRef.current = target; setV(target); return
    }
    const from = fromRef.current ?? 0
    if (from === target) { setV(target); return }
    let raf; const t0 = performance.now()
    const step = (now) => {
      const p = Math.min(1, (now - t0) / dur)
      setV(from + (target - from) * (1 - Math.pow(1 - p, 3)))
      if (p < 1) raf = requestAnimationFrame(step); else fromRef.current = target
    }
    raf = requestAnimationFrame(step)
    return () => { cancelAnimationFrame(raf); fromRef.current = target }
  }, [target, dur])
  return target == null ? null : v
}

/** Animated number. f formats the (fractional) tween value — round inside f. */
export function Num({ v, f = (x) => Math.round(x).toLocaleString('en-US'), dur }) {
  const shown = useTween(typeof v === 'number' && Number.isFinite(v) ? v : null, dur)
  return shown == null ? <>—</> : <>{f(shown)}</>
}

/* ---- skeletons: pages develop instead of arriving ---- */
export const SkLine = ({ w }) => <div className={`sk sk-line${w ? ` ${w}` : ''}`} />
export const SkCard = () => (
  <div className="card"><SkLine w="w40" /><div className="sk sk-big" /><SkLine w="w80" /></div>
)
export function SkPage({ cards = 4 }) {
  return (
    <div className="pagefade">
      <div className="grid">{Array.from({ length: cards }).map((_, i) => <SkCard key={i} />)}</div>
    </div>
  )
}

/* ---- height:auto expansion, zero measuring, zero jank ----
   Children stay mounted while closing so the collapse actually animates
   (unmounting them empties the box mid-transition and it snaps shut). */
export function Expand({ open, children }) {
  return <div className={`expand${open ? ' open' : ''}`} aria-hidden={!open} inert={open ? undefined : ''}><div>{children}</div></div>
}

/* ---- toasts ---- */
const ToastCtx = createContext(null)
export function ToastProvider({ children }) {
  const [items, setItems] = useState([])
  const push = (msg, opts = {}) => {
    const id = Math.random().toString(36).slice(2)
    setItems((xs) => [...xs, { id, msg, err: !!opts.err }])
    setTimeout(() => setItems((xs) => xs.map((x) => (x.id === id ? { ...x, out: true } : x))), opts.ms || 2600)
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), (opts.ms || 2600) + 260)
  }
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast${t.err ? ' err' : ''}${t.out ? ' out' : ''}`}><span className="tdot" />{t.msg}</div>
        ))}
      </div>
    </ToastCtx.Provider>
  )
}
export const useToast = () => useContext(ToastCtx) || (() => {})

/* ---- segmented control ---- */
export function Seg({ value, onChange, options }) {
  return (
    <div className="seg" role="tablist">
      {options.map((o) => (
        <button key={o.value} role="tab" aria-selected={value === o.value}
          className={value === o.value ? 'on' : ''} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

/* ---- freshness chip: live / stale / dead — the honesty badge ---- */
export function FreshChip({ fresh, label, title }) {
  if (!fresh) return null
  return (
    <span className={`chip ${fresh.state}`} title={title || `${label || ''} ${fresh.label}`.trim()}>
      <span className="dot" />{label ? `${label} · ` : ''}{fresh.state === 'dead' ? 'no data' : fresh.label}
    </span>
  )
}

/* ---- ⌘K command palette — actions, not routes ---- */
export function CommandK({ items = [] }) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [i, setI] = useState(0)
  const inputRef = useRef(null)
  const shown = useMemo(() => {
    const n = q.trim().toLowerCase()
    return n ? items.filter((x) => x.label.toLowerCase().includes(n) || (x.k || []).some((w) => w.includes(n))) : items
  }, [q, items])
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setOpen((o) => !o); setQ(''); setI(0) }
      else if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  useEffect(() => { if (open) setTimeout(() => inputRef.current?.focus(), 10) }, [open])
  // lock the ROOT element: with `html { overflow-x: clip }` the body's
  // overflow no longer propagates to the viewport, so a body lock is a no-op
  useEffect(() => {
    document.documentElement.style.overflow = open ? 'hidden' : ''
    return () => { document.documentElement.style.overflow = '' }
  }, [open])
  useEffect(() => { setI(0) }, [q])
  if (!open) return null
  const go = (item) => { setOpen(false); item.run() }
  return (
    <div className="cmdk-wrap" onMouseDown={(e) => { if (e.target === e.currentTarget) setOpen(false) }}>
      <div className="cmdk" role="dialog" aria-label="Command palette">
        <input ref={inputRef} value={q} placeholder="Jump to…" onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setI((x) => Math.min(x + 1, shown.length - 1)) }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setI((x) => Math.max(x - 1, 0)) }
            else if (e.key === 'Enter' && shown[i]) go(shown[i])
          }} />
        <div className="list">
          {shown.map((item, idx) => (
            <div key={item.label} className={`item${idx === i ? ' on' : ''}`} onMouseEnter={() => setI(idx)}
              onMouseDown={(e) => { e.preventDefault(); go(item) }}>
              <span>{item.label}</span><span className="k">↵</span>
            </div>
          ))}
          {shown.length === 0 && <div className="item">Nothing matches “{q}”</div>}
        </div>
      </div>
    </div>
  )
}
