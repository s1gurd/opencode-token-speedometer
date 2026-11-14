// Event → state logic for the statusline plugin (server-agnostic).
// The GUI part feeds its server event stream into `applyEvent`.
// All timestamps are milliseconds.

import {
  LiveRate,
  decodeTps,
  prefillTps,
  type TokenUsage,
} from "./metrics.ts"

export type ModelRef = { id: string; providerID: string; variant?: string }

/** Structural event shape both halves feed into `applyEvent` (looser than the client's typed union). */
export type EventDetails = {
  type: string
  created: number
  data?: {
    sessionID?: string
    assistantMessageID?: string
    model?: ModelRef
    started?: number
    tokens?: TokenUsage
    delta?: string
    status?: { type?: string }
    /** `form.created` nests the form under `data.form` (no top-level sessionID); `form.replied`/`form.cancelled` carry it at the top level. */
    form?: { id?: string; sessionID?: string }
  }
}

export type SessionMetrics = {
  status: "idle" | "busy" | "retry"
  model: ModelRef | null
  execStart: number | null
  lastDecode: number | null
  lastPrefill: number | null
  live: LiveRate
  stepStart: number | null
  stepMessageID: string | null
  stepFirstToken: number | null
  perm: number
}

export function getMetrics(map: Map<string, SessionMetrics>, sessionID: string): SessionMetrics {
  let m = map.get(sessionID)
  if (!m) {
    m = {
      status: "idle",
      model: null,
      execStart: null,
      lastDecode: null,
      lastPrefill: null,
      live: new LiveRate(),
      stepStart: null,
      stepMessageID: null,
      stepFirstToken: null,
      perm: 0,
    }
    map.set(sessionID, m)
  }
  return m
}

/**
 * Reconcile a session's metrics against the authoritative "is it running"
 * flag (the synced store's `session.status`). Some hosts do not deliver
 * `session.execution.*` events to plugin listeners, so without this the
 * execution leftovers (time, exact speeds, live rate, status) would linger
 * on the line forever. Call on every render with the store's current value.
 * A step in progress (stepMessageID set) means the execution is running
 * regardless of the flag, so it is never cleared (store false-negative guard).
 */
export function reconcileIdle(m: SessionMetrics, running: boolean): void {
  if (running || m.stepMessageID !== null) return
  if (m.execStart !== null) m.execStart = null
  if (m.lastDecode !== null) m.lastDecode = null
  if (m.lastPrefill !== null) m.lastPrefill = null
  if (m.status !== "idle") m.status = "idle"
  m.live.reset()
}

/** Clears every execution leftover (time, status, exact speeds, live rate, step state). */
function clearExecution(m: SessionMetrics): void {
  m.execStart = null
  m.status = "idle"
  m.lastDecode = null
  m.lastPrefill = null
  m.live.reset()
  m.stepStart = null
  m.stepMessageID = null
  m.stepFirstToken = null
}

/** Applies one server event to the per-session state. Events without a sessionID are ignored. */
export function applyEvent(map: Map<string, SessionMetrics>, d: EventDetails): void {
  const data = d.data ?? {}
  // `form.created` carries the sessionID inside `data.form` (probe 2026-11-13:
  // the GUI stream delivers form.* with a null top-level sessionID).
  const sessionID = data.sessionID ?? data.form?.sessionID
  if (!sessionID) return
  const m = getMetrics(map, sessionID)

  switch (d.type) {
    case "session.step.started": {
      m.model = data.model ?? m.model
      m.stepStart = data.started ?? d.created
      m.stepMessageID = data.assistantMessageID ?? null
      m.stepFirstToken = null
      m.live = new LiveRate()
      break
    }
    case "session.step.first-token":
    case "session.step.streamed": {
      // first-token marks TTFT; the first streamed event is the fallback when
      // the first-token event is not delivered (older server/client).
      if (m.stepMessageID === data.assistantMessageID && m.stepFirstToken === null) {
        m.stepFirstToken = d.created
      }
      break
    }
    case "session.step.ended":
    case "session.step.failed": {
      if (m.stepMessageID === data.assistantMessageID) {
        const t = { start: m.stepStart ?? d.created, firstToken: m.stepFirstToken ?? undefined, ended: d.created }
        // A failed step without tokens must not leave the previous step's numbers behind.
        m.lastDecode = data.tokens ? decodeTps(data.tokens, t) : null
        m.lastPrefill = data.tokens ? prefillTps(data.tokens, t) : null
        m.stepStart = null
        m.stepMessageID = null
        m.stepFirstToken = null
        m.live.reset()
      }
      break
    }
    case "session.model.selected": {
      m.model = data.model ?? m.model
      break
    }
    case "session.execution.started": {
      m.execStart = d.created
      m.status = "busy"
      m.lastDecode = null
      m.lastPrefill = null
      break
    }
    case "session.execution.succeeded":
    case "session.execution.failed":
    case "session.execution.interrupted":
      // User-interaction boundaries: hosts do not always deliver
      // `session.execution.*`, so a question (form) or a pause on the user's
      // decision must also act as an execution boundary. While the request is
      // paused it is no longer being processed — the execution leftovers
      // (time, speeds, live rate) must not linger on the line or leak into the
      // next execution (stale `lastPrefill` was observed leaking into the
      // first step after a question pause, probe 2026-11-13). `form.replied`/
      // `form.cancelled` repeat the clear so the resumed execution starts
      // clean even when `form.created` was missed (bundle re-evaluated mid-pause).
    case "form.created":
    case "form.replied":
    case "form.cancelled": {
      clearExecution(m)
      break
    }
    case "session.status": {
      m.status = data.status?.type === "busy" ? "busy" : data.status?.type === "retry" ? "retry" : "idle"
      break
    }
    case "session.text.delta":
    case "session.reasoning.delta": {
      if (m.stepMessageID === data.assistantMessageID) {
        m.live.update(data.delta?.length ?? 0, d.created)
      }
      break
    }
    case "permission.asked": {
      m.perm += 1
      // The request is paused on the user's decision — no longer being
      // processed, so the exact speeds and the live estimate must not linger
      // on the line (and must not leak into the next step after the answer).
      // `execStart` is kept: the execution is paused, not ended — the
      // elapsed time keeps counting. Step fields are kept: the step is still
      // in progress (the tool waits for the decision inside it).
      m.lastDecode = null
      m.lastPrefill = null
      m.live.reset()
      break
    }
    case "permission.replied": {
      m.perm = Math.max(0, m.perm - 1)
      break
    }
  }
}
