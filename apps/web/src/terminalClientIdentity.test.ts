import { describe, expect, it } from "vite-plus/test";

import { clientOwnsTerminalGeometry, terminalClientId } from "./terminalClientIdentity";

describe("terminalClientIdentity", () => {
  it("is stable within an app instance", () => {
    expect(terminalClientId()).toBe(terminalClientId());
    expect(terminalClientId().length).toBeGreaterThan(8);
  });

  it("only the server-reported owner (or nobody) may drive PTY geometry", () => {
    const me = terminalClientId();
    // Unowned grids are up for grabs — bootstrap and legacy sessions.
    expect(clientOwnsTerminalGeometry(undefined, me)).toBe(true);
    expect(clientOwnsTerminalGeometry(me, me)).toBe(true);
    // A grid owned by another machine is mirrored, never resized.
    expect(clientOwnsTerminalGeometry("someone-else", me)).toBe(false);
  });
});
