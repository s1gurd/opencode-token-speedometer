# opencode-token-speedometer

A statusline widget for [OpenCode](https://opencode.ai) that shows, at a glance, what the agent is doing right now: **session · status · model · elapsed time · live decode/prefill token speeds**. It renders in two places at once:

- **TUI** — appended to the `home.footer.status` and `prompt.footer.status` footer slots
- **Desktop (GUI)** — a strip in the `window.bottom` slot of the window

## Features

- **Live decode speed** — a rolling `≈ N tok/s` estimate while the model is streaming (3-second window over streamed text deltas)
- **Exact per-step speeds** — prefill (input tokens / time-to-first-token) and decode (output tokens / decode time) of the last finished step, shown while the execution continues
- **Session status** — `working` / `waiting` / `retrying` / `waiting for permission` (a pending permission always wins)
- **Elapsed execution time** — counts only while an execution runs
- **Session + model labels** — last 8 chars of the session id, `provider/model[variant]`
- **Event-driven, zero polling** — the TUI and GUI halves share one pure event→state module (`events.ts`), so the two renders can never drift apart
- **Stale-value protection** — speeds are cleared at execution end, on idle (reconciled against the synced session store), and at user-interaction boundaries (question forms, permission prompts), so values from one execution never leak into the next

## Example line

```
…b3c4d5e6 · working · ninfer/qwen3.8-27b-nvfp4full[default] · 00:42 · ≈ 41 tok/s · prefill 8.5k/s
```

Sections are omitted when unknown: no time section when idle, no prefill section when no prefill value is known (no placeholder, no marker). If the line exceeds the width budget, sections are dropped from the end and an ellipsis is appended.

## Installation

### One-line install (recommended)

Add one entry to the `plugin` array in your OpenCode config (`opencode.json`):

- **Windows**: `%USERPROFILE%\.config\opencode\opencode.json`
- **macOS / Linux**: `~/.config/opencode/opencode.json`

```json
{
  "plugin": [
    "opencode-token-speedometer@git+https://github.com/s1gurd/opencode-token-speedometer.git"
  ]
}
```

Then restart the OpenCode desktop app (and the background server if you run it separately). No build tools are needed — the GUI bundle is prebuilt and shipped in the repository.

### Manual install

```bash
git clone https://github.com/s1gurd/opencode-token-speedometer.git \
  ~/.config/opencode/plugin/opencode-token-speedometer
```

Then add the **absolute path** to the clone as a `plugin` array entry in `opencode.json` (e.g. `C:\Users\you\.config\opencode\plugin\opencode-token-speedometer` on Windows) and restart.

### For LLM agents (machine-readable install procedure)

Follow the steps exactly; stop and report if a step fails.

1. **Locate the config file.** Path: `~/.config/opencode/opencode.json` (Unix) or `%USERPROFILE%\.config\opencode\opencode.json` (Windows). Read it. If it does not exist, create it with `{}`.
2. **Add the plugin entry.** In the top-level `plugin` array (create the array if missing), add the string:
   `opencode-token-speedometer@git+https://github.com/s1gurd/opencode-token-speedometer.git`
   Do not remove or reorder existing entries. Save the file as valid JSON.
3. **Restart OpenCode.** Restart the desktop application; if a background OpenCode server is managed separately, restart it as well (a new plugin target registers on restart).
4. **Verify.** Expected observations:
   - TUI footer: a line of the form `…<8 hex chars> · waiting · <provider>/<model>` (at idle).
   - Desktop: a new strip at the bottom of the window with the same content.
   - While a response is generating: status becomes `working`, a live `≈ N tok/s` speed appears; after it finishes the status returns to `waiting` and the speeds disappear.
   - When a tool asks for permission: status shows `waiting for permission`.
5. **Optional dev verification** (clone + Node 22+): `npm install && npm test` → 53/53 pass; `npm run typecheck` → exit 0.

**Uninstall:** remove the entry from the `plugin` array (and delete the clone directory for manual installs), restart OpenCode.

## Behavior reference

| Section | Meaning |
| --- | --- |
| `…b3c4d5e6` | last 8 chars of the active session id (`—` outside a session) |
| `working` / `waiting` / `retrying` | session status; `waiting for permission` overrides while a permission prompt is pending |
| `ninfer/qwen3.8[default]` | last model seen in the session, falling back to the model selected in the prompt composer |
| `00:42` | elapsed execution time — visible only while an execution runs |
| `≈ 41 tok/s` | live decode estimate (rolling, `≈` marks it); exact value of the last finished step once the live estimate is not the source |
| `prefill 8.5k/s` | exact prefill speed of the last finished step — **shown only when a value is known** |

**Speed semantics (why):** speeds answer “how fast is the request being processed *right now*”:

- while a step streams — the live `≈` estimate (no value until ≥ 500 ms of samples exist);
- between steps of a multi-step execution — the exact values of the finished step;
- speeds **disappear when no request is being processed**: at execution end, when the session store reports idle, when a question form appears (the execution is paused on the user), and while a permission prompt is pending. This prevents a stale value from one execution from leaking into the first step of the next one.

## How it works

- `events.ts` — shared pure event→state logic (`applyEvent`, `getMetrics`, `reconcileIdle`). Both halves feed their server event stream into the same functions; all per-session state is keyed by session id.
- `metrics.ts` — pure metrics and formatting (`prefillTps`, `decodeTps`, `LiveRate`, `formatLine`, `statusWord`). No OpenCode dependencies, fully unit-tested.
- `tui.tsx` — TUI entry: footer slots, a 500 ms tick for the live sections, and a status overlay read from the synced session store (the authoritative “is it running” source).
- `gui.tsx` — desktop entry: the `window.bottom` slot. The host invokes `Slot.render` once outside a tracked owner, so the line is synced imperatively to the DOM from a `createEffect` under a `createKeyed` run (re-runs on every tick and server event).
- `index.ts` — no-op server part; keeps the package shape valid for auto-loading next to the TUI part.

Hosts whose plugin stream does **not** deliver `session.execution.*` events (the desktop sidecar stream is one) are handled by `reconcileIdle` (reconciled against the synced `session.status` store on every render) plus user-interaction boundaries: `form.created` / `form.replied` / `form.cancelled` act as execution boundaries, and `permission.asked` pauses the displayed speeds.

## Development

Prerequisites: Node 22+ (used with `--experimental-strip-types` for the tests), npm.

```bash
npm install
npm test          # 53 tests: events + metrics (TDD suite)
npm run typecheck # tsc --noEmit over the GUI part (tsconfig.gui.json)
npm run build     # vite build -> dist/gui-experimental.cjs (single CJS bundle, externals kept)
```

The `gui()` preset from `@opencode/plugin/gui/vite` compiles Solid JSX and keeps the app-provided modules (`solid-js`, `@opencode/plugin`, …) external. The TUI part (`tui.tsx`) is loaded from source by the OpenCode server; typechecking its JSX intrinsics requires the `@opentui/solid` package (a separate dev harness, not part of this repo).

## Known limitations

- The live `≈` speed is a heuristic (chars/4 over a 3 s window), not a tokenizer — treat the number as indicative.
- On desktop hosts the `session.execution.*` events are not delivered to plugin listeners; boundaries are reconstructed from the session store and form/permission events (see above).
- The TUI may show `≈ 0.0 tok/s` for the first ~500 ms of a step (live estimate not yet ready); the GUI omits the section instead.
- Per-session state is never pruned (a few hundred bytes per session id — negligible in practice).

## License

[GNU GPL v3.0](LICENSE)
