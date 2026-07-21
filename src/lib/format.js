// Display formatting — App-free so components never import the shell.

export function fmtPx(x) {
  if (!Number.isFinite(x)) return '—'
  return x >= 10000 ? Math.round(x).toLocaleString('en-US') : x.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export function round2(x) { return Math.round(x * 100) / 100 }
