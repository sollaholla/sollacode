/**
 * Chromium writes the port it actually bound to into `DevToolsActivePort` in
 * the user-data directory: the port on the first line, the browser's own
 * target path on the second. We ask for port 0 so the OS picks a free one,
 * which makes this file the only way to learn it.
 */
export interface DevToolsActivePort {
  readonly port: number;
  readonly browserTargetPath: string | null;
}

/**
 * Reading this is also how we know the switch took effect. A build launched
 * without it has no file at all, and DevTools stays unavailable rather than
 * being aimed at whatever else happens to be listening.
 */
export function parseDevToolsActivePort(contents: string): DevToolsActivePort | null {
  const [portLine, targetLine] = contents.split("\n");
  if (portLine === undefined) return null;
  const port = Number.parseInt(portLine.trim(), 10);
  // Port 0 is Chromium saying it never bound one; anything non-numeric means
  // this is not the file we think it is.
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) return null;
  const browserTargetPath = targetLine?.trim();
  return {
    port,
    browserTargetPath:
      browserTargetPath === undefined || browserTargetPath.length === 0 ? null : browserTargetPath,
  };
}
