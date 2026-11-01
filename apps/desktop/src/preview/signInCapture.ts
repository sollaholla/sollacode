// @effect-diagnostics globalTimers:off - Runs in the guest preload, which has no Effect runtime.
import type {
  SignInAttemptSignal,
  SignInPageSignal,
  SignInUsernameSignal,
} from "./GuestProtocol.ts";

const SETTLE_MS = 2_000;
const USERNAME_INPUT_TYPES = new Set(["text", "email", "tel", ""]);

export interface SignInCaptureSink {
  readonly username: (signal: SignInUsernameSignal) => void;
  readonly attempt: (signal: SignInAttemptSignal) => void;
  readonly page: (signal: SignInPageSignal) => void;
}

function inputOf(target: EventTarget | null): HTMLInputElement | null {
  // Tag name, not instanceof: the guest's elements can come from another realm.
  const element = target as { tagName?: unknown } | null;
  return element?.tagName === "INPUT" ? (target as HTMLInputElement) : null;
}

function isVisible(element: HTMLElement): boolean {
  return element.getClientRects().length > 0 || element.offsetParent !== null;
}

function isSignInTrigger(target: EventTarget | null): boolean {
  const start = target as { closest?: (selector: string) => unknown } | null;
  return (
    typeof start?.closest === "function" &&
    start.closest("button, input[type=submit], input[type=button], [role=button]") !== null
  );
}

/**
 * Watch a page for a person signing in, only on trusted input and only over
 * https or a local address. Nothing is reported until the person submits, the
 * password stays in this closure until then, and scripted fills do not count.
 */
export function installSignInCapture(input: {
  readonly document: Document;
  readonly origin: () => string;
  readonly isSecure: () => boolean;
  readonly sink: SignInCaptureSink;
}): void {
  const { document, sink } = input;
  let username = "";
  let password = "";
  let settleTimer: ReturnType<typeof setTimeout> | null = null;

  const reportPage = () => {
    settleTimer = null;
    if (!input.isSecure()) return;
    const hasPasswordField = [
      ...document.querySelectorAll<HTMLInputElement>("input[type=password]"),
    ].some(isVisible);
    sink.page({ origin: input.origin(), hasPasswordField });
  };
  // A timer rather than an observer: this only needs one answer after each
  // event, and must not run for as long as the page does.
  const reportPageSoon = () => {
    if (settleTimer !== null) clearTimeout(settleTimer);
    settleTimer = setTimeout(reportPage, SETTLE_MS);
  };

  const sendUsername = () => {
    if (username.length > 0 && input.isSecure()) {
      sink.username({ origin: input.origin(), username });
    }
  };

  const submit = () => {
    if (!input.isSecure()) return;
    sendUsername();
    if (password.length === 0) return;
    sink.attempt({ origin: input.origin(), username, password });
    password = "";
    reportPageSoon();
  };

  document.addEventListener(
    "input",
    (event) => {
      if (!event.isTrusted) return;
      const field = inputOf(event.target);
      if (!field) return;
      if (field.type === "password") {
        password = field.value;
      } else if (USERNAME_INPUT_TYPES.has(field.type)) {
        username = field.value.trim();
      }
    },
    { capture: true, passive: true },
  );
  document.addEventListener(
    "keydown",
    (event) => {
      if (event.isTrusted && event.key === "Enter" && inputOf(event.target)) submit();
    },
    { capture: true, passive: true },
  );
  document.addEventListener(
    "click",
    (event) => {
      if (event.isTrusted && isSignInTrigger(event.target)) submit();
    },
    { capture: true, passive: true },
  );
  document.addEventListener(
    "submit",
    (event) => {
      if (event.isTrusted) submit();
    },
    { capture: true, passive: true },
  );
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", reportPageSoon, { once: true });
  } else {
    reportPageSoon();
  }
}
