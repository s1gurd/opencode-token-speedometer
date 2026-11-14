# opencode-token-speedometer

A statusline widget for the [OpenCode](https://opencode.ai) **desktop app** that shows, at a glance, what the agent is doing right now: **session · status · model · elapsed time · live decode/prefill token speeds**. It renders as a single strip in the `window.bottom` slot of the window.

## Features

- **Live decode speed** — a rolling `≈ N tok/s` estimate while the model is streaming (3-second window over streamed text deltas)
- **Exact per-step speeds** — prefill (input tokens / time-to-first-token) and decode (output tokens / decode time) of the last finished step, shown while the execution continues
- **Session status** — `working` / `waiting` / `retrying` / `waiting for permission` (a pending permission always wins)
- **Elapsed execution time** — counts only while an execution runs
- **Session + model labels** — last 8 chars of the session id, `provider/model[variant]`
- **Event-driven, zero polling** — one pure event→state module (`events.ts`) feeds the render; a 500 ms tick only refreshes the live pieces (elapsed time, `≈` speed)
- **Stale-value protection** — speeds are cleared at execution end, on idle (reconciled against the synced session store), and at user-interaction boundaries (question forms, permission prompts), so values from one execution never leak into the next

## Example line

```
…b3c4d5e6 · working · ninfer/qwen3.8-27b-nvfp4full[default] · 00:42 · ≈ 41 tok/s · prefill 8.5k/s
```

Sections are omitted when unknown: no time section when idle, no prefill section when no prefill value is known (no placeholder, no marker). If the line exceeds the width budget, sections are dropped from the end and an ellipsis is appended.

## Installation

The GUI bundle is prebuilt and committed (`dist/gui-experimental.cjs`), so **no build tools are needed** to install — only a git clone and one config entry.

### Recommended: clone + local path

Clone the plugin into your OpenCode plugin directory:

```bash
git clone https://github.com/s1gurd/opencode-token-speedometer.git \
  ~/.config/opencode/plugin/opencode-token-speedometer
```

On Windows (PowerShell):

```powershell
git clone https://github.com/s1gurd/opencode-token-speedometer.git `
  "$env:USERPROFILE\.config\opencode\plugin\opencode-token-speedometer"
```

Then add the **absolute path to the clone** as one entry in the `plugin` array of your OpenCode config (`%USERPROFILE%\.config\opencode\opencode.json` on Windows, `~/.config/opencode/opencode.json` elsewhere):

```json
{
  "plugin": [
    "C:\\Users\\you\\.config\\opencode\\plugin\\opencode-token-speedometer"
  ]
}
```

Keep the other entries that are already in the array. Use `plugin` (singular) — that is the key read by OpenCode 1.19.x.

Restart the desktop app afterwards (and the background server, if you run it separately).

**Updating:** `git -C ~/.config/opencode/plugin/opencode-token-speedometer pull`, then restart (or reload plugins in Settings → Extensions).

### Why not `package@git+https://…`

The one-line spec form

```json
"opencode-token-speedometer@git+https://github.com/s1gurd/opencode-token-speedometer.git"
```

does **not** install on OpenCode 1.19.4: its embedded installer spawns the `opencode` binary instead of npm and the install fails with `Unrecognized flag: --force in command opencode` / `git dep preparation failed`. The clone + absolute path method above avoids that code path entirely.

### Only one entry that draws the strip

The bottom strip comes from the `./gui-experimental` bundle declared in `package.json`. Every plugin entry that ships that bundle renders its own strip, so two such entries show the strip **twice**. Keep exactly one entry for this widget, and do not install it alongside another statusline that carries the same GUI bundle.

### For LLM agents (machine-readable install procedure)

Follow the steps exactly; stop and report if a step fails.

1. **Locate the config file.** Path: `~/.config/opencode/opencode.json` (Unix) or `%USERPROFILE%\.config\opencode\opencode.json` (Windows). Read it. If it does not exist, create it with `{}`.
2. **Clone the plugin** (skip if the directory already exists):
   `git clone https://github.com/s1gurd/opencode-token-speedometer.git "<config dir>/plugin/opencode-token-speedometer"`
   where `<config dir>` is the directory containing `opencode.json`.
3. **Add the plugin entry.** In the top-level `plugin` array (create the array if missing), add the **absolute path** to the clone as a string (JSON-escape the backslashes on Windows: `"C:\\Users\\you\\.config\\opencode\\plugin\\opencode-token-speedometer"`). Do not remove or reorder existing entries, and do not add a second entry for the same widget. Save the file as valid JSON.
4. **Restart OpenCode.** Restart the desktop application; if a background OpenCode server is managed separately, restart it as well.
5. **Verify.** Expected observations:
   - Exactly **one** new strip at the bottom of the desktop window, showing a line of the form `…<8 hex chars> · waiting · <provider>/<model>` at idle.
   - While a response is generating: status becomes `working`, a live `≈ N tok/s` speed appears; after it finishes the status returns to `waiting` and the speeds disappear.
   - When a tool asks for permission: status shows `waiting for permission`.
6. **Optional dev verification** (Node 22+): `npm install && npm test` → 53/53 pass; `npm run typecheck` → exit 0; `npm run build` → `dist/gui-experimental.cjs`.

**Uninstall:** remove the entry from the `plugin` array, delete the clone directory, restart OpenCode.

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

- `events.ts` — pure event→state logic (`applyEvent`, `getMetrics`, `reconcileIdle`). The GUI part feeds its server event stream into these functions; all per-session state is keyed by session id.
- `metrics.ts` — pure metrics and formatting (`prefillTps`, `decodeTps`, `LiveRate`, `formatLine`, `statusWord`). No OpenCode dependencies, fully unit-tested.
- `gui.tsx` — desktop entry: the `window.bottom` slot. The host invokes `Slot.render` once outside a tracked owner, so the line is synced imperatively to the DOM from a `createEffect` under a `createKeyed` run (re-runs on every tick and server event).
- `index.ts` — no-op server part; keeps the package shape valid for auto-loading from the plugin directory. The visible widget is the GUI bundle.
- `dist/gui-experimental.cjs` — the prebuilt bundle behind the `./gui-experimental` export, i.e. what the desktop app actually loads.

The desktop sidecar stream does **not** deliver `session.execution.*` events, so execution boundaries are reconstructed from the synced `session.status` store on every render (`reconcileIdle`) plus user-interaction boundaries: `form.created` / `form.replied` / `form.cancelled` act as execution boundaries, and `permission.asked` pauses the displayed speeds.

## Development

Prerequisites: Node 22+ (used with `--experimental-strip-types` for the tests), npm.

```bash
npm install
npm test          # 53 tests: events + metrics (TDD suite)
npm run typecheck # tsc --noEmit over the GUI part (tsconfig.gui.json)
npm run build     # vite build -> dist/gui-experimental.cjs (single CJS bundle, externals kept)
```

The `gui()` preset from `@opencode/plugin/gui/vite` compiles Solid JSX and keeps the app-provided modules (`solid-js`, `@opencode/plugin`, …) external. Only the GUI part is typechecked and bundled here; commit the rebuilt `dist/gui-experimental.cjs` so installs stay build-free.

## Known limitations

- The live `≈` speed is a heuristic (chars/4 over a 3 s window), not a tokenizer — treat the number as indicative.
- The `session.execution.*` events are not delivered to desktop plugin listeners; boundaries are reconstructed from the session store and form/permission events (see above).
- Per-session state is never pruned (a few hundred bytes per session id — negligible in practice).

## License

[GNU GPL v3.0](LICENSE)
