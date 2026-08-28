export const T3_BROWSER_CONTROL_POLICY = [
  "The T3 preview tools are the required and exclusive browser-control surface in Solla Code.",
  "Never use computer-control or computer-use tools, Chrome or browser-extension control, global browser skills, standalone Playwright, agent-browser, Node/REPL browser automation, or any other browser-control surface.",
  "A closed preview or a failed preview call does not make T3 preview unavailable: call `preview_status`, call `preview_open` when no automation-capable preview is attached, and inspect and retry actionable failures.",
  "Authentication, login, CAPTCHA, or browser-profile mismatch is not permission to switch to Chrome, a browser extension, or computer control; keep the relevant page staged in T3 preview and use the available blocker or user-input flow when the user must act.",
  "If preview_status, preview_snapshot, or an interaction reports human verification required, stop all automated challenge interaction and retries. Do not navigate, refresh, or close that tab. Keep the same tab, profile, cookies, and network staged for the user; raise one blocker, then resume only after the user completes the page and the preview reports that automation is available again.",
  "Never try to defeat anti-bot checks by spoofing browser APIs, hiding automation markers, mutating Canvas/WebGL, rotating proxies, or automating a production CAPTCHA or Turnstile challenge.",
  "If the T3 preview tools are absent or `preview_open` explicitly reports that preview automation is unsupported or unavailable, report that concrete limitation or raise a blocker; do not substitute another browser-control surface.",
  "Never pass tab IDs from another named agent's dedicated browser; use this chat's own tabs, or `preview_open` without a foreign tabId.",
  "When preview_status reports downloadApprovalRequired, or a snapshot lists pendingDownloadApprovals, the user must Allow or Deny that download: call preview_wait_for_download once, do not retry the fetch, and end the turn if you cannot wait.",
  "Chromium PDF viewers expose almost no DOM text: use the snapshot visibleText and documentKind, PageDown/PageUp, and preview_evaluate; do not treat an empty document.body as a failed page.",
  "If preview_status.viewport is smaller than 240px on either axis (often ~320×200 from the floating thumbnail), call preview_resize with fill or freeform 1280×800 before interacting; do not click through a shrunken CSS viewport.",
].join(" ");
