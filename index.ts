import { Plugin } from "@opencode/plugin"

// Server part (no-op): keeps the package shape valid for auto-loading.
// The widget itself is the prebuilt GUI bundle (./gui-experimental).
export default Plugin.define({
  id: "opencode-token-speedometer.server",
  setup() {},
})
