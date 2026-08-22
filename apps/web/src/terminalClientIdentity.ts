/**
 * Stable per-app-instance id sent with terminal open/write/resize so the
 * server can arbitrate shared-PTY geometry: the last client to open, type
 * into, or successfully resize a terminal owns its grid, and other clients
 * render that grid scaled instead of resizing the PTY. Without this, two
 * machines viewing the same terminal ping-pong the PTY between their pane
 * sizes — every width swap makes ConPTY rewrap its whole buffer and
 * full-screen TUIs repaint, which reads as the cursor jumping wildly.
 */
let cachedTerminalClientId: string | null = null;

export function terminalClientId(): string {
  if (cachedTerminalClientId === null) {
    // Uniqueness across a handful of concurrently-running app instances is
    // all that is needed; collisions only weaken resize arbitration.
    cachedTerminalClientId = `t3c-${Math.random().toString(36).slice(2)}${Math.random()
      .toString(36)
      .slice(2)}`;
  }
  return cachedTerminalClientId;
}

/**
 * Whether this client may drive the shared PTY's geometry given the
 * server-reported owner. An unowned grid is up for grabs; a grid owned by
 * another client must be mirrored (rendered at the server geometry, scaled),
 * never resized.
 */
export function clientOwnsTerminalGeometry(
  geometryOwner: string | undefined,
  clientId: string,
): boolean {
  return geometryOwner === undefined || geometryOwner === clientId;
}
