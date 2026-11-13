import { test } from "node:test"
import assert from "node:assert/strict"

import { applyEvent, getMetrics, reconcileIdle, type EventDetails, type SessionMetrics } from "./events.ts"
import { decodeTps, prefillTps, type TokenUsage } from "./metrics.ts"

type Data = {
  sessionID?: string
  assistantMessageID?: string
  model?: { id: string; providerID: string; variant?: string }
  started?: number
  tokens?: TokenUsage
  delta?: string
  status?: { type?: string }
}

function ev(type: string, created: number, data: Data = {}): EventDetails {
  return { type, created, data }
}

const TOK: TokenUsage = { input: 100, output: 200, reasoning: 50, cache: { read: 10, write: 5 } }
const MODEL = { id: "m", providerID: "p" }

/** Map with one started step: messageID "a1", start 1000, model set. */
function stepCtx(): { map: Map<string, SessionMetrics>; m: SessionMetrics } {
  const map = new Map<string, SessionMetrics>()
  applyEvent(map, ev("session.step.started", 1000, { sessionID: "s1", assistantMessageID: "a1", model: MODEL, started: 1000 }))
  return { map, m: map.get("s1")! }
}

// --- getMetrics ---
test("getMetrics creates a fresh entry and returns the same object on repeat", () => {
  const map = new Map<string, SessionMetrics>()
  const a = getMetrics(map, "s1")
  const b = getMetrics(map, "s1")
  assert.equal(a, b)
  assert.equal(map.get("s1"), a)
  assert.equal(a.status, "idle")
  assert.equal(a.lastDecode, null)
  assert.equal(a.perm, 0)
})

// --- session.step.started ---
test("session.step.started sets model/stepStart/stepMessageID, clears stepFirstToken", () => {
  const map = new Map<string, SessionMetrics>()
  applyEvent(map, ev("session.step.started", 1000, { sessionID: "s1", assistantMessageID: "a1", model: MODEL, started: 1010 }))
  const m = map.get("s1")!
  assert.deepEqual(m.model, MODEL)
  assert.equal(m.stepStart, 1010)
  assert.equal(m.stepMessageID, "a1")
  assert.equal(m.stepFirstToken, null)
})

test("session.step.started replaces the live rate (previous step's samples discarded)", () => {
  const { map, m } = stepCtx()
  applyEvent(map, ev("session.text.delta", 1100, { sessionID: "s1", assistantMessageID: "a1", delta: "x".repeat(40) }))
  applyEvent(map, ev("session.text.delta", 2100, { sessionID: "s1", assistantMessageID: "a1", delta: "x".repeat(40) }))
  assert.ok(m.live.tps(2100) !== null, "live rate must be alive before the next step")
  applyEvent(map, ev("session.step.started", 2101, { sessionID: "s1", assistantMessageID: "a2", model: MODEL, started: 2101 }))
  assert.equal(m.live.tps(2101), null)
  assert.equal(m.stepMessageID, "a2")
})

// --- session.step.first-token / streamed ---
test("session.step.first-token sets stepFirstToken only for the current step message", () => {
  const { map, m } = stepCtx()
  applyEvent(map, ev("session.step.first-token", 1500, { sessionID: "s1", assistantMessageID: "OTHER" }))
  assert.equal(m.stepFirstToken, null)
  applyEvent(map, ev("session.step.first-token", 1500, { sessionID: "s1", assistantMessageID: "a1" }))
  assert.equal(m.stepFirstToken, 1500)
})

test("session.step.streamed is the TTFT fallback when first-token never arrived (and does not overwrite)", () => {
  const { map, m } = stepCtx()
  applyEvent(map, ev("session.step.streamed", 1600, { sessionID: "s1", assistantMessageID: "a1" }))
  assert.equal(m.stepFirstToken, 1600)
  applyEvent(map, ev("session.step.streamed", 1700, { sessionID: "s1", assistantMessageID: "a1" }))
  assert.equal(m.stepFirstToken, 1600)
})

// --- session.step.ended / failed ---
test("session.step.ended computes exact speeds and clears step state", () => {
  const { map, m } = stepCtx()
  applyEvent(map, ev("session.step.first-token", 1200, { sessionID: "s1", assistantMessageID: "a1" }))
  applyEvent(map, ev("session.step.ended", 3000, { sessionID: "s1", assistantMessageID: "a1", tokens: TOK }))
  assert.equal(m.lastDecode, decodeTps(TOK, { start: 1000, firstToken: 1200, ended: 3000 }))
  assert.equal(m.lastPrefill, prefillTps(TOK, { start: 1000, firstToken: 1200, ended: 3000 }))
  assert.equal(m.stepMessageID, null)
  assert.equal(m.stepStart, null)
  assert.equal(m.stepFirstToken, null)
})

test("session.step.ended with a foreign assistantMessageID leaves metrics untouched", () => {
  const { map, m } = stepCtx()
  applyEvent(map, ev("session.step.ended", 3000, { sessionID: "s1", assistantMessageID: "OTHER", tokens: TOK }))
  assert.equal(m.lastDecode, null)
  assert.equal(m.stepMessageID, "a1")
})

test("session.step.failed without tokens resets speeds (no stale values from the previous step)", () => {
  const { map, m } = stepCtx()
  applyEvent(map, ev("session.step.first-token", 1200, { sessionID: "s1", assistantMessageID: "a1" }))
  applyEvent(map, ev("session.step.ended", 3000, { sessionID: "s1", assistantMessageID: "a1", tokens: TOK }))
  assert.ok(m.lastDecode !== null, "a finished step leaves values behind")
  applyEvent(map, ev("session.step.started", 4000, { sessionID: "s1", assistantMessageID: "a2", model: MODEL, started: 4000 }))
  applyEvent(map, ev("session.step.failed", 5000, { sessionID: "s1", assistantMessageID: "a2" }))
  assert.equal(m.lastDecode, null)
  assert.equal(m.lastPrefill, null)
  assert.equal(m.stepMessageID, null)
})

// --- session.execution.* ---
test("session.execution.started sets execStart, status busy, and clears previous step's speeds", () => {
  const { map, m } = stepCtx()
  applyEvent(map, ev("session.step.first-token", 1200, { sessionID: "s1", assistantMessageID: "a1" }))
  applyEvent(map, ev("session.step.ended", 3000, { sessionID: "s1", assistantMessageID: "a1", tokens: TOK }))
  assert.ok(m.lastDecode !== null)
  applyEvent(map, ev("session.execution.started", 9999, { sessionID: "s1" }))
  assert.equal(m.execStart, 9999)
  assert.equal(m.status, "busy")
  assert.equal(m.lastDecode, null)
  assert.equal(m.lastPrefill, null)
})

test("session.execution end clears the previous step's exact speeds (they must not linger when idle)", () => {
  for (const type of ["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"]) {
    const { map, m } = stepCtx()
    applyEvent(map, ev("session.execution.started", 100, { sessionID: "s1" }))
    applyEvent(map, ev("session.step.first-token", 1200, { sessionID: "s1", assistantMessageID: "a1" }))
    applyEvent(map, ev("session.step.ended", 3000, { sessionID: "s1", assistantMessageID: "a1", tokens: TOK }))
    assert.equal(m.lastDecode, decodeTps(TOK, { start: 1000, firstToken: 1200, ended: 3000 }), `${type}: step end computed values`)
    applyEvent(map, ev(type, 4000, { sessionID: "s1" }))
    assert.equal(m.lastDecode, null, `${type}: decode must not linger when idle`)
    assert.equal(m.lastPrefill, null, `${type}: prefill must not linger when idle`)
  }
})

test("session.execution.succeeded / failed / interrupted reset exec, status and live rate", () => {
  for (const type of ["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"]) {
    const { map, m } = stepCtx()
    applyEvent(map, ev("session.execution.started", 100, { sessionID: "s1" }))
    applyEvent(map, ev("session.text.delta", 200, { sessionID: "s1", assistantMessageID: "a1", delta: "abc" }))
    applyEvent(map, ev("session.text.delta", 1200, { sessionID: "s1", assistantMessageID: "a1", delta: "abcdef" }))
    assert.ok(m.live.tps(1200) !== null, `${type}: live rate must be alive before the execution ends`)
    applyEvent(map, ev(type, 2000, { sessionID: "s1" }))
    assert.equal(m.execStart, null)
    assert.equal(m.status, "idle")
    assert.equal(m.live.tps(999999999999), null)
  }
})

// --- reconcileIdle (authoritative-store fallback for hosts that do not deliver session.execution.*) ---
test("reconcileIdle: running=true keeps all state untouched", () => {
  const { map, m } = stepCtx()
  applyEvent(map, ev("session.execution.started", 100, { sessionID: "s1" }))
  applyEvent(map, ev("session.step.first-token", 1200, { sessionID: "s1", assistantMessageID: "a1" }))
  applyEvent(map, ev("session.step.ended", 3000, { sessionID: "s1", assistantMessageID: "a1", tokens: TOK }))
  m.live.update(400, 3500)
  const execStart = m.execStart
  const lastDecode = m.lastDecode
  const lastPrefill = m.lastPrefill
  assert.ok(execStart !== null && lastDecode !== null && lastPrefill !== null)
  reconcileIdle(m, true)
  assert.equal(m.execStart, execStart)
  assert.equal(m.lastDecode, lastDecode)
  assert.equal(m.lastPrefill, lastPrefill)
  assert.equal(m.live.tps(3600), m.live.tps(3600)) // still sampling
})

test("reconcileIdle: idle clears lingering execution state (speeds, time, status, live)", () => {
  const { map, m } = stepCtx()
  applyEvent(map, ev("session.execution.started", 100, { sessionID: "s1" }))
  applyEvent(map, ev("session.step.first-token", 1200, { sessionID: "s1", assistantMessageID: "a1" }))
  applyEvent(map, ev("session.step.ended", 3000, { sessionID: "s1", assistantMessageID: "a1", tokens: TOK }))
  m.live.update(400, 3500)
  assert.ok(m.lastDecode !== null && m.lastPrefill !== null && m.execStart !== null)
  reconcileIdle(m, false)
  assert.equal(m.execStart, null)
  assert.equal(m.lastDecode, null)
  assert.equal(m.lastPrefill, null)
  assert.equal(m.status, "idle")
  assert.equal(m.live.tps(4000), null)
})

test("reconcileIdle: a step in progress is never cleared (store false-negative guard)", () => {
  const { map, m } = stepCtx() // stepCtx leaves step a1 in progress (stepMessageID "a1")
  applyEvent(map, ev("session.execution.started", 100, { sessionID: "s1" }))
  assert.equal(m.stepMessageID, "a1")
  reconcileIdle(m, false) // store lags: still reports idle while the step runs
  assert.equal(m.execStart, 100)
  assert.equal(m.stepMessageID, "a1")
})

// --- execution end must clear step state too (I-1: the cut-off step of an interrupt has no step.ended/failed) ---
test("execution.interrupted with a step in progress clears step state (reconcileIdle guard stays effective)", () => {
  const { map, m } = stepCtx() // step a1 in progress: stepStart 1000, stepMessageID "a1"
  applyEvent(map, ev("session.execution.started", 100, { sessionID: "s1" }))
  applyEvent(map, ev("session.step.first-token", 1200, { sessionID: "s1", assistantMessageID: "a1" }))
  assert.equal(m.stepMessageID, "a1")
  applyEvent(map, ev("session.execution.interrupted", 3000, { sessionID: "s1" }))
  assert.equal(m.execStart, null)
  assert.equal(m.status, "idle")
  assert.equal(m.lastDecode, null)
  assert.equal(m.lastPrefill, null)
  assert.equal(m.stepStart, null)
  assert.equal(m.stepMessageID, null)
  assert.equal(m.stepFirstToken, null)
  // The safety net must stay effective afterwards: idle reconcile clears everything.
  m.live.update(400, 3500)
  reconcileIdle(m, false)
  assert.equal(m.live.tps(4000), null)
})

test("a late step.ended after execution end is ignored (no resurrected leftovers)", () => {
  const { map, m } = stepCtx()
  applyEvent(map, ev("session.execution.started", 100, { sessionID: "s1" }))
  applyEvent(map, ev("session.step.first-token", 1200, { sessionID: "s1", assistantMessageID: "a1" }))
  applyEvent(map, ev("session.execution.succeeded", 3000, { sessionID: "s1" }))
  applyEvent(map, ev("session.step.ended", 3100, { sessionID: "s1", assistantMessageID: "a1", tokens: TOK }))
  assert.equal(m.lastDecode, null, "late step end must not resurrect speeds")
  assert.equal(m.lastPrefill, null)
  assert.equal(m.stepMessageID, null)
})

// --- session.status ---
test("session.status maps busy/retry/other to the stored status", () => {
  const map = new Map<string, SessionMetrics>()
  applyEvent(map, ev("session.status", 1, { sessionID: "s1", status: { type: "busy" } }))
  assert.equal(map.get("s1")!.status, "busy")
  applyEvent(map, ev("session.status", 2, { sessionID: "s1", status: { type: "retry" } }))
  assert.equal(map.get("s1")!.status, "retry")
  applyEvent(map, ev("session.status", 3, { sessionID: "s1", status: { type: "idle" } }))
  assert.equal(map.get("s1")!.status, "idle")
})

// --- session.model.selected ---
test("session.model.selected updates the session's model", () => {
  const { map, m } = stepCtx()
  applyEvent(map, ev("session.model.selected", 5000, { sessionID: "s1", model: { id: "m2", providerID: "p2", variant: "v" } }))
  assert.deepEqual(m.model, { id: "m2", providerID: "p2", variant: "v" })
})

// --- session.text.delta / session.reasoning.delta ---
test("text/reasoning deltas feed the live rate (80 chars over 1s → ~20 tok/s)", () => {
  const { map, m } = stepCtx()
  applyEvent(map, ev("session.text.delta", 1100, { sessionID: "s1", assistantMessageID: "a1", delta: "x".repeat(40) }))
  applyEvent(map, ev("session.reasoning.delta", 2100, { sessionID: "s1", assistantMessageID: "a1", delta: "x".repeat(40) }))
  const v = m.live.tps(2100)
  assert.ok(v !== null, "live rate must have enough data")
  assert.ok(Math.abs(v - 20) <= 1, `expected ~20 tok/s, got ${v}`)
})

test("deltas of a foreign session do not touch the active session's live rate (Review Focus 2)", () => {
  const { map, m } = stepCtx()
  applyEvent(map, ev("session.text.delta", 1100, { sessionID: "s2", assistantMessageID: "a1", delta: "x".repeat(80) }))
  assert.equal(m.live.tps(1100), null, "s1 (active) must stay untouched")
  assert.equal(map.get("s2")!.live.tps(1100), null, "s2's own record exists but carries no live data")
})

// --- permission.* ---
test("permission.asked increments, permission.replied decrements (never below 0)", () => {
  const map = new Map<string, SessionMetrics>()
  applyEvent(map, ev("permission.asked", 1, { sessionID: "s1" }))
  applyEvent(map, ev("permission.asked", 2, { sessionID: "s1" }))
  assert.equal(map.get("s1")!.perm, 2)
  applyEvent(map, ev("permission.replied", 3, { sessionID: "s1" }))
  applyEvent(map, ev("permission.replied", 4, { sessionID: "s1" }))
  applyEvent(map, ev("permission.replied", 5, { sessionID: "s1" }))
  assert.equal(map.get("s1")!.perm, 0)
})

// --- defensive: no sessionID / unknown events ---
test("events without data.sessionID create no records and do not throw", () => {
  const map = new Map<string, SessionMetrics>()
  applyEvent(map, { type: "plugin.updated", created: 1 })
  applyEvent(map, ev("session.status", 1)) // data without sessionID
  assert.equal(map.size, 0)
})

// --- user-interaction boundaries (form/permission): the request is no longer being
// processed, so execution leftovers must not linger or leak into the next execution ---
test("form.created (nested form.sessionID) clears stale execution state", () => {
  const { map, m } = stepCtx()
  applyEvent(map, ev("session.execution.started", 100, { sessionID: "s1" }))
  applyEvent(map, ev("session.step.first-token", 1200, { sessionID: "s1", assistantMessageID: "a1" }))
  applyEvent(map, ev("session.step.ended", 3000, { sessionID: "s1", assistantMessageID: "a1", tokens: TOK }))
  assert.ok(m.lastDecode !== null && m.lastPrefill !== null, "values exist before the pause")
  applyEvent(map, { type: "form.created", created: 4000, data: { form: { sessionID: "s1", id: "f1" } } })
  assert.equal(m.execStart, null)
  assert.equal(m.status, "idle")
  assert.equal(m.lastDecode, null, "decode must not leak into the next execution")
  assert.equal(m.lastPrefill, null, "prefill must not leak into the next execution")
  assert.equal(m.stepMessageID, null)
  assert.equal(m.live.tps(999999999999), null)
})

test("form.replied / form.cancelled clear stale state (robustness when form.created was missed)", () => {
  for (const type of ["form.replied", "form.cancelled"]) {
    const { map, m } = stepCtx()
    applyEvent(map, ev("session.execution.started", 100, { sessionID: "s1" }))
    applyEvent(map, ev("session.step.first-token", 1200, { sessionID: "s1", assistantMessageID: "a1" }))
    applyEvent(map, ev("session.step.ended", 3000, { sessionID: "s1", assistantMessageID: "a1", tokens: TOK }))
    applyEvent(map, ev(type, 5000, { sessionID: "s1" }))
    assert.equal(m.lastDecode, null, `${type}: stale decode cleared`)
    assert.equal(m.lastPrefill, null, `${type}: stale prefill cleared`)
  }
})

test("permission.asked clears speeds (request paused on the user's decision) but keeps execStart and perm", () => {
  const { map, m } = stepCtx()
  applyEvent(map, ev("session.execution.started", 100, { sessionID: "s1" }))
  applyEvent(map, ev("session.step.first-token", 1200, { sessionID: "s1", assistantMessageID: "a1" }))
  applyEvent(map, ev("session.step.ended", 3000, { sessionID: "s1", assistantMessageID: "a1", tokens: TOK }))
  applyEvent(map, ev("permission.asked", 4000, { sessionID: "s1" }))
  assert.equal(m.lastDecode, null)
  assert.equal(m.lastPrefill, null)
  assert.equal(m.execStart, 100, "the execution is paused, not ended — time keeps counting")
  assert.equal(m.perm, 1)
})
