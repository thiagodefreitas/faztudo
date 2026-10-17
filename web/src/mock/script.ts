export const APPROVAL_READY = "diff ready, asking before push"
export const FAIL_LINE = "got exhausted, want conserve"
export const LIVE_PASS = "ok: pushed and verified"
export const SEED_PASS = "ok: run card shows verification"
export const HELD_DETAIL = "Held. Nothing was pushed."

export const SAMPLE_DIFF = [
  "diff --git a/internal/notes.txt b/internal/notes.txt",
  "--- a/internal/notes.txt",
  "+++ b/internal/notes.txt",
  "@@ -1,3 +1,4 @@",
  " lane health",
  "-hidden in the log",
  "+shown on the run card",
  "+with the failing output",
  " end",
].join("\n")

export const MOCK_VERSION = "0.0.0-mock"
