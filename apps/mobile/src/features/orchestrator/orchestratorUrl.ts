/**
 * Where the phone loads the orchestrator from.
 *
 * The voice session is WebRTC talking straight to OpenAI, and it already exists
 * in the web client — tools, thread routing, the language pin, waking on awaited
 * work, ending by voice. Reimplementing that natively would mean a second
 * realtime client to keep in step with the first, so the phone loads the web
 * client's `/orchestrator` route instead and the microphone and audio stay on
 * the phone, which is the only arrangement that helps someone with headphones.
 *
 * Pure, so the URL shaping is testable without a WebView or a live environment.
 */

/** Path the web client serves the full-screen voice view from. */
export const ORCHESTRATOR_ROUTE_PATH = "/orchestrator";

/**
 * Builds the orchestrator URL for a connected environment.
 *
 * Returns null rather than a half-formed URL when there is nothing to connect
 * to: a WebView pointed at "undefined/orchestrator" shows a browser error page,
 * which reads as the feature being broken rather than the phone being offline.
 */
export function buildOrchestratorUrl(httpBaseUrl: string | null | undefined): string | null {
  if (typeof httpBaseUrl !== "string") return null;
  const trimmed = httpBaseUrl.trim();
  if (trimmed.length === 0) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  // Only ever an http(s) app server. A `file:` or custom-scheme base would let
  // a malformed stored connection point the WebView somewhere unexpected.
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;

  // Preserve any base path the environment is served under, but drop a trailing
  // slash so the join never produces "//orchestrator".
  const basePath = parsed.pathname.replace(/\/+$/, "");
  parsed.pathname = `${basePath}${ORCHESTRATOR_ROUTE_PATH}`;
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

/**
 * Whether a URL the WebView is trying to reach belongs to the environment.
 *
 * The orchestrator view is the whole surface here; anything navigating away
 * from the environment's own origin is a link that should open in the system
 * browser rather than silently replacing the voice UI with a web page.
 */
export function isSameEnvironmentOrigin(
  candidateUrl: string,
  httpBaseUrl: string | null | undefined,
): boolean {
  if (typeof httpBaseUrl !== "string") return false;
  try {
    return new URL(candidateUrl).origin === new URL(httpBaseUrl).origin;
  } catch {
    return false;
  }
}
