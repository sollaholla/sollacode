import {
  PREVIEW_HUMAN_VERIFICATION_COMPATIBILITY_URL,
  PREVIEW_HUMAN_VERIFICATION_FEEDBACK_URL,
  type PreviewAutomationSnapshot,
  type PreviewHumanVerification,
} from "@t3tools/contracts";
import { useSyncExternalStore } from "react";

export interface PreviewHumanVerificationProbe {
  readonly url: string;
  readonly title: string;
  readonly visibleText: string;
  readonly browserUserAgent: string | null;
  readonly hasTurnstile: boolean;
  readonly hasFullPageChallenge: boolean;
}

export const PREVIEW_HUMAN_VERIFICATION_PROBE_EXPRESSION = `(() => {
  const text = (document.body?.innerText ?? "").slice(0, 20000);
  const challengeSelector = [
    'iframe[src*="challenges.cloudflare.com"]',
    '.cf-turnstile',
    '[data-sitekey][class*="turnstile" i]',
    '[id*="turnstile" i]'
  ].join(',');
  const isVisible = (element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return (
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      Number(style.opacity || '1') > 0 &&
      rect.width >= 40 &&
      rect.height >= 20 &&
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < innerHeight &&
      rect.left < innerWidth
    );
  };
  const html = document.documentElement?.innerHTML?.slice(0, 50000) ?? "";
  return {
    url: location.href,
    title: document.title,
    visibleText: text,
    browserUserAgent: navigator.userAgent || null,
    hasTurnstile: Array.from(document.querySelectorAll(challengeSelector)).some(isVisible),
    hasFullPageChallenge:
      /(?:cf-chl-|challenge-platform|challenges\\.cloudflare\\.com)/i.test(html) &&
      /(?:just a moment|verify you are human|security verification|checking your browser)/i.test(
        document.title + "\\n" + text,
      ),
  };
})()`;

const ERROR_CODE_PATTERN = /\b([36]\d{5})\b/u;
const RAY_ID_PATTERN = /cloudflare\s+ray\s+id\s*[:#]?\s*([a-z0-9-]{6,128})/iu;
const QR_IDENTIFIER_PATTERN = /(?:qr\s+(?:code\s+)?(?:identifier|id))\s*[:#]?\s*([^\s]{4,256})/iu;
const CHALLENGE_LANGUAGE_PATTERN =
  /(?:verify you are human|security verification|verification failed|checking your browser|challenge failed|turnstile|bot behavior detected)/iu;
const CLOUDFLARE_MARKER_PATTERN =
  /(?:cloudflare|turnstile|challenges\.cloudflare\.com|cf-chl-|ray id)/iu;

const boundedMatch = (match: RegExpMatchArray | null): string | null => match?.[1] ?? null;

const browserIdentity = (
  userAgent: string | null,
): { readonly product: string | null; readonly version: string | null } => {
  if (!userAgent) return { product: null, version: null };
  const match = userAgent.match(/\b(Chrome|Chromium|Edg|Firefox|Version)\/([\d.]+)/u);
  if (!match) return { product: null, version: null };
  const matchedProduct = match[1];
  const product =
    matchedProduct === "Edg"
      ? "Microsoft Edge"
      : matchedProduct === "Version"
        ? "Safari"
        : (matchedProduct ?? null);
  return { product, version: match[2] ?? null };
};

const snapshotProbe = (snapshot: PreviewAutomationSnapshot): PreviewHumanVerificationProbe => ({
  url: snapshot.url,
  title: snapshot.title,
  visibleText: snapshot.visibleText,
  browserUserAgent: null,
  // Network requests and prose mentions cannot prove that an actionable
  // widget is on screen. The DOM probe makes that determination.
  hasTurnstile: false,
  hasFullPageChallenge: false,
});

export function detectPreviewHumanVerification(input: {
  readonly probe?: PreviewHumanVerificationProbe | null;
  readonly snapshot?: PreviewAutomationSnapshot | null;
  readonly now?: string;
}): PreviewHumanVerification | null {
  const probe = input.probe ?? (input.snapshot ? snapshotProbe(input.snapshot) : null);
  if (!probe) return null;

  const combined = `${probe.title}\n${probe.visibleText}`;
  const code = boundedMatch(combined.match(ERROR_CODE_PATTERN));
  const cfMitigated =
    input.snapshot?.networkEntries.some((entry) => entry.cfMitigated === true) ?? null;
  const hasChallengeLanguage = CHALLENGE_LANGUAGE_PATTERN.test(combined);
  const hasCloudflareMarker =
    probe.hasTurnstile || probe.hasFullPageChallenge || CLOUDFLARE_MARKER_PATTERN.test(combined);
  const supportedChallengeCode = code !== null && (hasCloudflareMarker || hasChallengeLanguage);
  const fullPageTitle = /^(?:just a moment|attention required)[.!…\s]*$/iu.test(probe.title.trim());

  if (
    !supportedChallengeCode &&
    !probe.hasTurnstile &&
    !probe.hasFullPageChallenge &&
    !fullPageTitle &&
    !(hasCloudflareMarker && hasChallengeLanguage)
  ) {
    return null;
  }

  const kind = code?.startsWith("6")
    ? ("bot-detection" as const)
    : cfMitigated === true || probe.hasFullPageChallenge || fullPageTitle
      ? ("full-page-challenge" as const)
      : ("embedded-turnstile" as const);
  const detectedAt = input.now ?? new Date().toISOString();
  const identity = browserIdentity(probe.browserUserAgent);
  const challengeResponse = input.snapshot?.networkEntries.find(
    (entry) =>
      entry.cfMitigated === true || entry.url.toLowerCase().includes("challenges.cloudflare.com"),
  );

  return {
    state: "human_verification_required",
    kind,
    code,
    detectedAt,
    url: probe.url.slice(0, 2_048),
    retryCount: 0,
    retryAvailable: false,
    message:
      "Automation is paused for this tab. Complete the verification manually in the same tab, then ask Solla Code to check it again.",
    compatibilityCheckUrl: PREVIEW_HUMAN_VERIFICATION_COMPATIBILITY_URL,
    feedbackUrl: PREVIEW_HUMAN_VERIFICATION_FEEDBACK_URL,
    diagnostic: {
      browserProduct: identity.product,
      browserVersion: identity.version,
      browserUserAgent: probe.browserUserAgent?.slice(0, 1_024) ?? null,
      embeddedBrowser: true,
      headedBrowser: true,
      automationAvailable: true,
      cdpAttached: true,
      viewportMode: null,
      colorSchemeOverride: null,
      userAgentOverride: null,
      canvasOverride: null,
      webglOverride: null,
      extensionsEnabled: null,
      proxyOrVpn: null,
      cfMitigated,
      responseStatusCode: challengeResponse?.status ?? null,
      challengesCloudflareReachable:
        challengeResponse?.status === null || challengeResponse === undefined ? null : true,
      rayId: boundedMatch(combined.match(RAY_ID_PATTERN)),
      qrIdentifier: boundedMatch(combined.match(QR_IDENTIFIER_PATTERN)),
      systemClockIso: detectedAt,
      systemClockCorrect: null,
    },
  };
}

const verificationByRuntimeTabId = new Map<string, PreviewHumanVerification>();
const listeners = new Set<() => void>();

const emit = () => {
  for (const listener of listeners) listener();
};

export function getPreviewHumanVerification(runtimeTabId: string): PreviewHumanVerification | null {
  return verificationByRuntimeTabId.get(runtimeTabId) ?? null;
}

export function setPreviewHumanVerification(
  runtimeTabId: string,
  verification: PreviewHumanVerification,
): PreviewHumanVerification {
  const existing = verificationByRuntimeTabId.get(runtimeTabId);
  const next =
    existing && existing.url === verification.url
      ? { ...verification, detectedAt: existing.detectedAt, retryCount: existing.retryCount }
      : verification;
  verificationByRuntimeTabId.set(runtimeTabId, next);
  emit();
  return next;
}

export function clearPreviewHumanVerification(runtimeTabId: string): void {
  if (!verificationByRuntimeTabId.delete(runtimeTabId)) return;
  emit();
}

export function usePreviewHumanVerification(
  runtimeTabId: string | null,
): PreviewHumanVerification | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => (runtimeTabId ? getPreviewHumanVerification(runtimeTabId) : null),
    () => null,
  );
}

export function parsePreviewHumanVerificationProbe(
  value: unknown,
): PreviewHumanVerificationProbe | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record["url"] !== "string" ||
    typeof record["title"] !== "string" ||
    typeof record["visibleText"] !== "string" ||
    typeof record["hasTurnstile"] !== "boolean" ||
    typeof record["hasFullPageChallenge"] !== "boolean"
  ) {
    return null;
  }
  return {
    url: record["url"],
    title: record["title"],
    visibleText: record["visibleText"],
    browserUserAgent:
      typeof record["browserUserAgent"] === "string" ? record["browserUserAgent"] : null,
    hasTurnstile: record["hasTurnstile"],
    hasFullPageChallenge: record["hasFullPageChallenge"],
  };
}

export async function inspectPreviewHumanVerification(input: {
  readonly runtimeTabId: string;
  readonly evaluate: (expression: string) => Promise<unknown>;
  readonly snapshot?: PreviewAutomationSnapshot | null;
  /** Explicit user re-checks must inspect the page even while the gate is active. */
  readonly force?: boolean;
  /** Tests can make the confirmation boundary immediate without fake timers. */
  readonly waitForConfirmation?: () => Promise<void>;
}): Promise<PreviewHumanVerification | null> {
  const existing = getPreviewHumanVerification(input.runtimeTabId);
  if (existing && input.force !== true) return existing;

  let detected = input.snapshot
    ? detectPreviewHumanVerification({ snapshot: input.snapshot })
    : null;
  if (!detected) {
    const value = await input.evaluate(PREVIEW_HUMAN_VERIFICATION_PROBE_EXPRESSION);
    detected = detectPreviewHumanVerification({ probe: parsePreviewHumanVerificationProbe(value) });
  }
  if (detected) {
    await (input.waitForConfirmation?.() ??
      new Promise<void>((resolve) => globalThis.setTimeout(resolve, 1_000)));
    const confirmationValue = await input.evaluate(PREVIEW_HUMAN_VERIFICATION_PROBE_EXPRESSION);
    const confirmed = detectPreviewHumanVerification({
      probe: parsePreviewHumanVerificationProbe(confirmationValue),
      ...(input.snapshot !== undefined ? { snapshot: input.snapshot } : {}),
    });
    if (confirmed) return setPreviewHumanVerification(input.runtimeTabId, confirmed);
  }
  if (input.force === true) clearPreviewHumanVerification(input.runtimeTabId);
  return null;
}
