// Pure metrics for the statusline plugin — no OpenCode dependencies.
// All timestamps are milliseconds.

export type TokenUsage = {
  input: number
  output: number
  reasoning: number
  cache?: { read: number; write: number }
}

export type StepTimings = {
  start: number
  firstToken?: number
  ended?: number
}

/** Input tokens per second spent on prefill (start → first token). Null when it cannot be computed. */
export function prefillTps(tokens: TokenUsage, t: StepTimings): number | null {
  if (!tokens || !t.firstToken || t.firstToken - t.start <= 0) return null
  return tokens.input / ((t.firstToken - t.start) / 1000)
}

/** Output tokens per second spent on decoding (first token → end). Null when it cannot be computed. */
export function decodeTps(tokens: TokenUsage, t: StepTimings): number | null {
  if (!tokens || !t.firstToken || t.ended === undefined || t.ended - t.firstToken <= 0) return null
  return (tokens.output + tokens.reasoning) / ((t.ended - t.firstToken) / 1000)
}

/** 41.2 → "41", 9.8 → "9.8", 8500 → "8.5k", 12000 → "12k", null → "—". */
export function fmtTps(v: number | null): string {
  if (v === null) return "—"
  if (v >= 1000) {
    const k = v / 1000
    return k >= 10 ? `${Math.round(k)}k` : `${Number(k.toFixed(1))}k`
  }
  if (v >= 10) return String(Math.round(v))
  return v.toFixed(1)
}

/** 83000 → "01:23", 7530000 → "02:05:30", null → "—". */
export function fmtElapsed(ms: number | null): string {
  if (ms === null) return "—"
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const pad = (n: number) => String(n).padStart(2, "0")
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`
}

/** "working" / "waiting" / "retrying" (English, per user decision 2026-11-13). Pending permission always wins over the raw status. */
export function statusWord(s: "idle" | "busy" | "retry", permissionPending: boolean): string {
  if (permissionPending) return "waiting for permission"
  if (s === "busy") return "working"
  if (s === "retry") return "retrying"
  return "waiting"
}

/** "ninfer/qwen3.8[nvfp4]" or "—". */
export function modelLabel(m: { providerID: string; id: string; variant?: string } | null): string {
  if (!m) return "—"
  return `${m.providerID}/${m.id}${m.variant ? `[${m.variant}]` : ""}`
}

/** "…b3c4d5e6" (last 8 chars) or "—". */
export function sessionLabel(id: string | null): string {
  return id ? `…${id.slice(-8)}` : "—"
}

export type LineInput = {
  session: string | null
  status: "idle" | "busy" | "retry"
  permissionPending: boolean
  model: { providerID: string; id: string; variant?: string } | null
  /** When execution started (ms); null when idle. */
  execStart: number | null
  now: number
  /** Current decode speed; `live` marks an in-step estimate (rendered with ≈). */
  decode: { tps: number; live: boolean } | null
  /** Exact prefill speed of the last finished step; null (section hidden) until a step finishes it. */
  prefill: number | null
  maxChars?: number
}

/**
 * Section order: session · status · model · time · decode · prefill.
 * Omitted sections: time (no execStart), decode (null), prefill (null).
 * When the line exceeds maxChars (default 120), sections are dropped from
 * the end and an ellipsis is appended.
 */
export function formatLine(p: LineInput): string {
  const parts = [
    sessionLabel(p.session),
    statusWord(p.status, p.permissionPending),
    modelLabel(p.model),
  ]
  if (p.execStart !== null) parts.push(fmtElapsed(p.now - p.execStart))
  if (p.decode) parts.push(`${p.decode.live ? "≈ " : ""}${fmtTps(p.decode.tps)} tok/s`)
  if (p.prefill !== null) parts.push(`prefill ${fmtTps(p.prefill)}/s`)

  let line = parts.join(" · ")
  const max = p.maxChars ?? 120
  if (line.length > max) {
    const kept: string[] = []
    for (const part of parts) {
      const cand = kept.length ? `${kept.join(" · ")} · ${part}` : part
      if (cand.length + 1 > max) break
      kept.push(part)
    }
    line = kept.join(" · ") + "…"
  }
  return line
}

/**
 * Rolling estimate of live decode speed from streamed text deltas:
 * chars in a 3s window / 4 (≈ tokens), over the window's span.
 * Null while there is not enough data (fewer than 2 samples or span < 500ms).
 */
export class LiveRate {
  private samples: Array<[number, number]> = [] // [tMs, deltaChars]

  update(deltaChars: number, tMs: number): void {
    this.samples.push([tMs, deltaChars])
  }

  tps(nowMs: number): number | null {
    const cutoff = nowMs - 3000
    this.samples = this.samples.filter(([t]) => t > cutoff)
    if (this.samples.length < 2) return null
    const firstT = this.samples[0][0]
    const lastT = this.samples[this.samples.length - 1][0]
    const span = lastT - firstT
    if (span < 500) return null
    const chars = this.samples.reduce((sum, [, c]) => sum + c, 0)
    return chars / 4 / (span / 1000)
  }

  reset(): void {
    this.samples = []
  }
}
