export const T3_BROWSER_CONTROL_POLICY = [
  "The T3 preview tools are the required and exclusive browser-control surface in Solla Code.",
  "Never use computer-control or computer-use tools, Chrome or browser-extension control, global browser skills, standalone Playwright, agent-browser, Node/REPL browser automation, or any other browser-control surface.",
  "A closed preview or a failed preview call does not make T3 preview unavailable: call `preview_status`, call `preview_open` when no automation-capable preview is attached, and inspect and retry actionable failures.",
  "Authentication, login, CAPTCHA, or browser-profile mismatch is not permission to switch to Chrome, a browser extension, or computer control; keep the relevant page staged in T3 preview and use the available blocker or user-input flow when the user must act.",
  "If the T3 preview tools are absent or `preview_open` explicitly reports that preview automation is unsupported or unavailable, report that concrete limitation or raise a blocker; do not substitute another browser-control surface.",
].join(" ");
