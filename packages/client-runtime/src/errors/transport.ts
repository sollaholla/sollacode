const TRANSPORT_ERROR_PATTERNS = [
  /\bSocketCloseError\b/i,
  /\bSocketOpenError\b/i,
  /\bSocket is not connected\b/i,
  /Unable to connect to the T3 server WebSocket\./i,
  /\bis not connected\.$/i,
  /\bdisconnected\.$/i,
  /\bcould not establish a WebSocket connection\.$/i,
  /\bClientProtocolError\b/i,
  /\bRpcClientError\b/i,
  /\bping timeout\b/i,
] as const;

/**
 * Check whether an error message originates from a transport-level connection
 * failure (socket close, socket open, ping timeout, etc.) rather than a
 * business-logic error.
 */
export function isTransportConnectionErrorMessage(message: string | null | undefined): boolean {
  if (typeof message !== "string") {
    return false;
  }

  const normalizedMessage = message.trim();
  if (normalizedMessage.length === 0) {
    return false;
  }

  return TRANSPORT_ERROR_PATTERNS.some((pattern) => pattern.test(normalizedMessage));
}

/**
 * Strip transport connection errors from user-facing error messages.
 * Returns `null` for transport errors so the UI can distinguish between
 * real errors and transient connection issues.
 */
const STACK_FRAME_LINE = /^\s*at\s+/u;

function stripErrorStack(message: string): string {
  const lines: string[] = [];
  for (const line of message.split(/\r?\n/u)) {
    if (STACK_FRAME_LINE.test(line)) break;
    lines.push(line);
  }
  const cleaned = lines.join("\n").trim();
  return cleaned.length > 0 ? cleaned : message.trim();
}

export function sanitizeThreadErrorMessage(message: string | null | undefined): string | null {
  if (isTransportConnectionErrorMessage(message)) {
    return null;
  }
  if (typeof message !== "string") {
    return message ?? null;
  }
  const trimmed = message.trim();
  if (trimmed.length === 0) {
    return null;
  }
  return stripErrorStack(trimmed);
}
