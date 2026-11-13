import { test } from "node:test"
import assert from "node:assert/strict"
import {
  prefillTps,
  decodeTps,
  fmtTps,
  fmtElapsed,
  statusWord,
  modelLabel,
  sessionLabel,
  formatLine,
  LiveRate,
} from "./metrics.ts"

// --- prefillTps ---
test("prefillTps: normal case = input tokens / prefill time", () => {
  assert.equal(prefillTps({ input: 4000, output: 0, reasoning: 0 }, { start: 0, firstToken: 500 }), 8000)
})
test("prefillTps: no firstToken -> null", () => {
  assert.equal(prefillTps({ input: 4000, output: 0, reasoning: 0 }, { start: 0 }), null)
})
test("prefillTps: zero window (firstToken === start) -> null", () => {
  assert.equal(prefillTps({ input: 4000, output: 0, reasoning: 0 }, { start: 500, firstToken: 500 }), null)
})

// --- decodeTps ---
test("decodeTps: normal case = (output+reasoning) / decode time", () => {
  // 1000 tokens over 500ms (firstToken=500 → ended=1000) = 2000 tok/s
  assert.equal(
    decodeTps({ input: 0, output: 820, reasoning: 180 }, { start: 0, firstToken: 500, ended: 1000 }),
    2000,
  )
})
test("decodeTps: no ended -> null", () => {
  assert.equal(decodeTps({ input: 0, output: 820, reasoning: 180 }, { start: 0, firstToken: 500 }), null)
})
test("decodeTps: no firstToken -> null", () => {
  assert.equal(decodeTps({ input: 0, output: 820, reasoning: 180 }, { start: 0, ended: 1000 }), null)
})
test("decodeTps: zero window (ended === firstToken) -> null", () => {
  assert.equal(decodeTps({ input: 0, output: 820, reasoning: 180 }, { start: 0, firstToken: 500, ended: 500 }), null)
})
test("decodeTps: tokens undefined (step.failed without tokens) -> null, no throw", () => {
  assert.equal(decodeTps(undefined as unknown as { input: number; output: number; reasoning: number }, { start: 0, firstToken: 500, ended: 1000 }), null)
})

// --- fmtTps ---
test("fmtTps: null -> —", () => {
  assert.equal(fmtTps(null), "—")
})
test("fmtTps: >=10 -> integer, no decimals", () => {
  assert.equal(fmtTps(41.2), "41")
  assert.equal(fmtTps(12.3), "12")
})
test("fmtTps: <10 -> one decimal", () => {
  assert.equal(fmtTps(9.8), "9.8")
})
test("fmtTps: >=1000 -> k suffix", () => {
  assert.equal(fmtTps(8500), "8.5k")
  assert.equal(fmtTps(12000), "12k")
})

// --- fmtElapsed ---
test("fmtElapsed: null -> —", () => {
  assert.equal(fmtElapsed(null), "—")
})
test("fmtElapsed: 83s -> 01:23", () => {
  assert.equal(fmtElapsed(83000), "01:23")
})
test("fmtElapsed: 7530s -> 02:05:30", () => {
  assert.equal(fmtElapsed(7530000), "02:05:30")
})

// --- statusWord (English, per user decision 2026-11-13) ---
test("statusWord: basic states", () => {
  assert.equal(statusWord("idle", false), "waiting")
  assert.equal(statusWord("busy", false), "working")
  assert.equal(statusWord("retry", false), "retrying")
})
test("statusWord: pending permission takes priority", () => {
  assert.equal(statusWord("idle", true), "waiting for permission")
  assert.equal(statusWord("busy", true), "waiting for permission")
})

// --- prefill section rule (per user decision 2026-11-13): shown only when a value is known
// (the last finished step's speed, visible while the execution runs); hidden when unknown —
// no "…" placeholder, no marker. ---
test("formatLine: unknown prefill (null) hides the whole section, with or without decode", () => {
  const withDecode = formatLine({
    session: "ses_01a2b3c4d5e6",
    status: "busy",
    permissionPending: false,
    model: null,
    execStart: 999_000,
    now: 1_000_000,
    decode: { tps: 41, live: true },
    prefill: null,
  })
  assert.ok(!withDecode.includes("prefill"), `section must be hidden: ${withDecode}`)
  const withoutDecode = formatLine({
    session: "ses_01a2b3c4d5e6",
    status: "idle",
    permissionPending: false,
    model: null,
    execStart: null,
    now: 1_000_000,
    decode: null,
    prefill: null,
  })
  assert.ok(!withoutDecode.includes("prefill"))
})

// --- modelLabel / sessionLabel ---
test("modelLabel: provider/id[variant]", () => {
  assert.equal(modelLabel({ providerID: "ninfer", id: "qwen3.8", variant: "nvfp4" }), "ninfer/qwen3.8[nvfp4]")
  assert.equal(modelLabel(null), "—")
})
test("sessionLabel: last 8 chars with ellipsis", () => {
  assert.equal(sessionLabel("ses_01a2b3c4d5e6"), "…b3c4d5e6")
  assert.equal(sessionLabel(null), "—")
})

// --- formatLine ---
test("formatLine: full case — all sections in order", () => {
  const now = 1_000_000
  const line = formatLine({
    session: "ses_01a2b3c4d5e6",
    status: "busy",
    permissionPending: false,
    model: { providerID: "ninfer", id: "qwen3.8", variant: "nvfp4" },
    execStart: now - 83_000,
    now,
    decode: { tps: 41, live: true },
    prefill: 8500,
  })
  assert.equal(line, "…b3c4d5e6 · working · ninfer/qwen3.8[nvfp4] · 01:23 · ≈ 41 tok/s · prefill 8.5k/s")
})
test("formatLine: idle without data — no time/decode/prefill sections", () => {
  const now = 1_000_000
  const line = formatLine({
    session: "ses_01a2b3c4d5e6",
    status: "idle",
    permissionPending: false,
    model: { providerID: "ninfer", id: "qwen3.8", variant: "nvfp4" },
    execStart: null,
    now,
    decode: null,
    prefill: null,
  })
  assert.equal(line, "…b3c4d5e6 · waiting · ninfer/qwen3.8[nvfp4]")
})
test("formatLine: decode.live=false — no ≈ mark", () => {
  const line = formatLine({
    session: null,
    status: "idle",
    permissionPending: false,
    model: null,
    execStart: null,
    now: 0,
    decode: { tps: 41, live: false },
    prefill: null,
  })
  assert.ok(line.includes("41 tok/s"))
  assert.ok(!line.includes("≈"))
})
test("formatLine: maxChars truncation ends with … and fits", () => {
  const now = 1_000_000
  const line = formatLine({
    session: "ses_01a2b3c4d5e6",
    status: "busy",
    permissionPending: false,
    model: { providerID: "ninfer", id: "qwen3.8", variant: "nvfp4" },
    execStart: now - 83_000,
    now,
    decode: { tps: 41, live: true },
    prefill: 8500,
    maxChars: 40,
  })
  assert.ok(line.length <= 40, `line too long: ${line.length}`)
  assert.ok(line.endsWith("…"))
})

// --- LiveRate ---
test("LiveRate: no data -> null", () => {
  const lr = new LiveRate()
  assert.equal(lr.tps(0), null)
})
test("LiveRate: single sample (span < 500ms) -> null", () => {
  const lr = new LiveRate()
  lr.update(40, 1000)
  assert.equal(lr.tps(1000), null)
})
test("LiveRate: 80 chars over 1s span -> ~20 tok/s (chars/4)", () => {
  const lr = new LiveRate()
  lr.update(40, 1000)
  lr.update(40, 2000)
  const v = lr.tps(2000)
  assert.ok(v !== null)
  assert.ok(Math.abs(v - 20) <= 1, `expected ~20, got ${v}`)
})
test("LiveRate: reset -> null", () => {
  const lr = new LiveRate()
  lr.update(40, 1000)
  lr.update(40, 2000)
  lr.reset()
  assert.equal(lr.tps(2000), null)
})
