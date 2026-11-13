import { createEffect, createSignal, onCleanup } from "solid-js"
import { createKeyed, Plugin, Slot, Style } from "@opencode/plugin/gui"
import { applyEvent, reconcileIdle, type EventDetails, type SessionMetrics } from "./events.ts"
import { formatLine, type LineInput } from "./metrics.ts"
import css from "./oc-statusline.css?inline"

export default Plugin.define({
  setup(ctx) {
    const sessions = new Map<string, SessionMetrics>()

    // 500 ms tick for the live pieces (elapsed time, ≈ speed).
    const [tick, bump] = createSignal(0)
    const timer = setInterval(() => bump((v) => v + 1), 500)
    onCleanup(() => clearInterval(timer))

    // The host renders the slot content ONCE and only updates the reactivity
    // of the returned JSX, so a line computed in the `render` body is frozen.
    // Instead the text is synced imperatively to the DOM node from a
    // createEffect under a createKeyed run (a live owner: its registrations
    // and onCleanups end with the run). The effect re-runs on every tick and
    // on every server event, and re-reads the reactive ctx getters fresh.
    let el: HTMLDivElement | null = null
    // The current sidecar `Data` generation (set by the createKeyed run).
    // Used to read the authoritative per-session running state.
    type SessionStore = { status: (id: string) => "idle" | "running" }
    let dataRef: { session: SessionStore } | null = null

    const computeLine = (): string => {
      const sessionID = ctx.sessions.current()?.id ?? null
      const m = sessionID ? sessions.get(sessionID) : undefined
      const now = Date.now()

      // Authoritative "is the session working" source: the synced session
      // store. Event-driven `m.status` alone misses executions that started
      // before the listener attached (the bundle re-evaluates on plugin
      // events, mid-execution included).
      const running = sessionID !== null && dataRef !== null && dataRef.session.status(sessionID) === "running"
      // Hosts that do not deliver `session.execution.*` events leave execution
      // leftovers behind once idle; reconcile them against the store each render.
      if (m) reconcileIdle(m, running)
      const status: LineInput["status"] = running ? "busy" : m?.status ?? "idle"

      // Model fallback: the model the next prompt is sent with — same
      // semantics as ui.model.current() in the TUI part.
      const promptModel = ctx.screen.current()?.composer.model()
      const inStep = m ? m.stepMessageID !== null : false
      const liveTps = m ? m.live.tps(now) : null
      const last = m && m.lastDecode !== null ? { tps: m.lastDecode, live: false } : null
      const input: LineInput = {
        session: sessionID,
        status,
        permissionPending: (m?.perm ?? 0) > 0,
        model: m?.model ?? (promptModel ? { id: promptModel.modelID, providerID: promptModel.providerID, variant: promptModel.variant } : null),
        execStart: m?.execStart ?? null,
        now,
        // "≈" only while the live estimate is ready; otherwise the last
        // exact value (no "≈ 0.0" artifact in the first <500 ms of a step).
        decode: inStep ? (liveTps !== null ? { tps: liveTps, live: true } : last) : last,
        // Section hidden when no value is known (no marker; user decision 2026-11-13).
        prefill: m?.lastPrefill ?? null,
        maxChars: 400,
      }
      return formatLine(input)
    }

    // Paint the current text into the DOM node. Safe to call untracked:
    // it only writes, never reads tracked state.
    const paint = () => {
      if (!el) return
      const text = computeLine()
      if (el.textContent !== text) el.textContent = text
    }

    createKeyed(
      () => ctx.servers.get("sidecar")?.data,
      (data) => {
        dataRef = data
        const stop = data.listen(({ details }) => {
          applyEvent(sessions, details as unknown as EventDetails)
          // Force an immediate line refresh (live ≈ speed while streaming).
          bump((v) => v + 1)
        })
        onCleanup(stop)

        // Live owner for the effect: re-runs on the 500 ms tick and on the
        // event-driven bumps; disposed with the keyed run.
        createEffect(() => {
          tick() // tracked read: re-runs every 500 ms
          paint()
        })
      },
    )

    ctx.add(Style, css)
    ctx.add(Slot, {
      at: "window.bottom",
      render: () => (
        <div class="oc-statusline" ref={(n) => { el = n; paint() }}>
          {computeLine()}
        </div>
      ),
    })
  },
})
