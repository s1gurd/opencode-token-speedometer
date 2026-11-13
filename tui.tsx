import { createSignal } from "solid-js"
import { Plugin } from "@opencode/plugin/tui"
import { applyEvent, reconcileIdle, type EventDetails, type SessionMetrics } from "./events.ts"
import { formatLine, type LineInput } from "./metrics.ts"

export default Plugin.define({
  id: "opencode-token-speedometer",
  setup(context) {
    const sessions = new Map<string, SessionMetrics>()

    // One listener for every server event we care about. The event → state
    // logic lives in the shared `events.ts` (unit-tested, shared with the GUI part).
    const stop = context.data.listen(({ details }) => {
      applyEvent(sessions, details as unknown as EventDetails)
    })

    // Re-render the line every 500ms while things are live (timer + ≈ speed).
    // The tick must be *read* inside the render so Solid tracks it: writing
    // the signal from the timer alone would not trigger any re-render.
    const [tick, bump] = createSignal(0)
    const timer = setInterval(() => bump((v) => v + 1), 500)

    const renderLine = () => {
      tick() // read: tracked inside the host's render computation
      const route = context.ui.router.current()
      const sessionID = route.type === "session" ? route.sessionID : null
      const m = sessionID ? sessions.get(sessionID) : undefined
      const now = Date.now()

      // Authoritative "is the session working" source: the synced session
      // store. Event-driven `m.status` alone misses executions that
      // started before the listener attached.
      const running = sessionID !== null && context.data.session.status(sessionID) === "running"
      // Hosts that do not deliver `session.execution.*` events leave execution
      // leftovers behind once idle; reconcile them against the store each render.
      if (m) reconcileIdle(m, running)
      const status: "idle" | "busy" | "retry" = running ? "busy" : m?.status ?? "idle"

      // Design: model comes from step/selection events; fall back to the
      // prompt's selected model (reactive) when this session has none yet.
      const promptModel = context.ui.model.current()
      const inStep = m ? m.stepMessageID !== null : false
      const input: LineInput = {
        session: sessionID,
        status,
        permissionPending: (m?.perm ?? 0) > 0,
        model: m?.model ?? (promptModel ? { id: promptModel.modelID, providerID: promptModel.providerID, variant: promptModel.variant } : null),
        execStart: m?.execStart ?? null,
        now,
        decode: inStep
          ? { tps: m?.live.tps(now) ?? 0, live: true }
          : m && m.lastDecode !== null
            ? { tps: m.lastDecode, live: false }
            : null,
        // Section hidden when no value is known (no marker; user decision 2026-11-13).
        prefill: m?.lastPrefill ?? null,
      }
      return (
        <text fg={context.theme.text.muted}>{formatLine(input)}</text>
      )
    }

    const unhookHome = context.ui.slot({ append: "home.footer.status", render: renderLine })
    const unhookPrompt = context.ui.slot({ append: "prompt.footer.status", render: renderLine })

    return () => {
      clearInterval(timer)
      stop()
      if (typeof unhookHome === "function") unhookHome()
      if (typeof unhookPrompt === "function") unhookPrompt()
    }
  },
})
