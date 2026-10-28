import { AGENT_CALL_NATIVE_MESSAGE_TYPE, type AgentCallNativeMessage } from "@t3tools/contracts";

interface NativeWebViewBridge {
  postMessage(message: string): void;
}

function nativeBridge(): NativeWebViewBridge | null {
  if (typeof window === "undefined") return null;
  const candidate = (window as { readonly ReactNativeWebView?: unknown }).ReactNativeWebView;
  return typeof candidate === "object" &&
    candidate !== null &&
    typeof (candidate as { postMessage?: unknown }).postMessage === "function"
    ? (candidate as NativeWebViewBridge)
    : null;
}

/**
 * Whether this page runs inside one of the phone app's WebViews. The native
 * app owns incoming calls there: it buzzes and presents its own call screen,
 * so the page never rings.
 */
export function isPhoneAppWebView(): boolean {
  return nativeBridge() !== null;
}

/**
 * Tells the phone app hosting this page what happened to a call, so its
 * native call screen knows which calls this phone holds. A no-op in browsers
 * and the desktop app.
 */
export function postAgentCallNativeMessage(
  event: AgentCallNativeMessage["event"],
  callId: string,
  detail?: string | null,
): void {
  const bridge = nativeBridge();
  if (bridge === null) return;
  const message: AgentCallNativeMessage = {
    type: AGENT_CALL_NATIVE_MESSAGE_TYPE,
    event,
    callId,
    ...(detail ? { detail } : {}),
  };
  try {
    // eslint-disable-next-line unicorn/require-post-message-target-origin -- React Native's bridge takes one string, not a window target origin.
    bridge.postMessage(JSON.stringify(message));
  } catch {
    // The WebView is going away with the screen.
  }
}
