import { defineConfig } from "vite"
import { gui } from "@opencode/plugin/gui/vite"

// The gui() preset compiles Solid JSX, writes the single CJS bundle to
// dist/gui-experimental.cjs (the ./gui-experimental export) and keeps the
// app-provided modules (solid-js, @opencode/client, effect, @opencode/plugin) external.
export default defineConfig({ plugins: [gui({ entry: "gui.tsx" })] })
