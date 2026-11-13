import { Plugin } from "@opencode/plugin"

// Server part (no-op): keeps the package shape valid for auto-loading next to the TUI part.
export default Plugin.define({
  id: "opencode-token-speedometer.server",
  setup() {},
})
