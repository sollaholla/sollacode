import { readHostedPairingRequest, resolveRemotePairingTarget } from "@t3tools/shared/remote";
import * as Schema from "effect/Schema";

const MOBILE_PAIRING_URL_PARAM = "pairingUrl";
const MOBILE_SCHEMES = new Set(["t3code:", "t3code-dev:", "t3code-preview:"]);

export function cameraPermissionAction(
  permission: { readonly granted: boolean; readonly canAskAgain: boolean } | null,
): "scan" | "request" | "settings" {
  if (permission?.granted) return "scan";
  return permission?.canAskAgain === false ? "settings" : "request";
}

export class PairingQrPayloadEmptyError extends Schema.TaggedErrorClass<PairingQrPayloadEmptyError>()(
  "PairingQrPayloadEmptyError",
  {},
) {
  override get message(): string {
    return "Scanned QR code did not contain a pairing URL.";
  }
}

export function buildPairingUrl(host: string, code: string): string {
  const h = host.trim();
  const c = code.trim();
  if (!h) return "";
  if (!c) return h;

  try {
    const url = new URL(h.includes("://") ? h : `https://${h}`);
    url.hash = new URLSearchParams([["token", c]]).toString();
    return url.toString();
  } catch {
    return `${h}#token=${c}`;
  }
}

export function parsePairingUrl(url: string): { host: string; code: string } {
  const trimmed = url.trim();
  if (!trimmed) return { host: "", code: "" };

  try {
    const parsed = new URL(trimmed);
    const hostedPairingRequest = readHostedPairingRequest(parsed);
    if (hostedPairingRequest) {
      return {
        host: hostedPairingRequest.host.replace(/\/$/, ""),
        code: hostedPairingRequest.token,
      };
    }

    const hashParams = new URLSearchParams(parsed.hash.slice(1));
    const hashToken = hashParams.get("token");
    const queryToken = parsed.searchParams.get("token");
    const code = hashToken || queryToken || "";

    parsed.hash = "";
    parsed.search = "";
    parsed.pathname = "/";
    return { host: parsed.toString().replace(/\/$/, ""), code };
  } catch {
    return { host: trimmed, code: "" };
  }
}

export function extractPairingUrlFromQrPayload(payload: string): string {
  const trimmed = payload.trim();
  if (!trimmed) {
    throw new PairingQrPayloadEmptyError({});
  }

  return readPairingLink(trimmed);
}

/** Accept the same direct and hosted links as the connection runtime. */
export function readPairingLink(value: string): string {
  let pairingUrl = value.trim();
  // Parsing errors and missing credentials are reported by the shared validator.
  let url: URL | undefined;
  try {
    url = new URL(pairingUrl);
  } catch {}
  if (url && MOBILE_SCHEMES.has(url.protocol)) {
    pairingUrl = url.searchParams.get(MOBILE_PAIRING_URL_PARAM)?.trim() ?? "";
  }
  resolveRemotePairingTarget({ pairingUrl });
  return pairingUrl;
}
