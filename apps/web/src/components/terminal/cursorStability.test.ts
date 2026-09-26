import { describe, expect, it } from "vite-plus/test";
import { ConptyCursorStabilizer, CONPTY_CURSOR_SETTLE_MS } from "./cursorStability";

const input = { x: 2, y: 23, buffer: "normal" as const };
const stray = { x: 95, y: 24, buffer: "normal" as const };
function setup() {
  const guard = new ConptyCursorStabilizer();
  guard.resolve({ position: input, framed: false, now: 0 });
  return guard;
}
describe("Windows Codex cursor presentation", () => {
  it("keeps the input caret during a completed frame's transient animation-row cursor", () => {
    const guard = setup();
    expect(guard.resolve({ position: stray, framed: true, now: 1 })).toEqual({
      position: input,
      retryAfter: 80,
    });
    expect(guard.resolve({ position: input, framed: false, now: 64 })).toEqual({
      position: input,
      retryAfter: null,
    });
  });
  it("does not confirm a succession of different stray positions", () => {
    const guard = setup();
    for (let n = 0; n < 50; n++) {
      expect(
        guard.resolve({
          position: { ...stray, x: 40 + n },
          framed: true,
          now: n * 30,
        }).position,
      ).toEqual(input);
    }
  });
  it("also holds a particle cursor far across the same input row", () => {
    const guard = setup();
    expect(guard.resolve({ position: { ...input, x: 85 }, framed: true, now: 1 }).position).toEqual(
      input,
    );
    const typed = { ...input, x: 3 };
    expect(guard.resolve({ position: typed, framed: false, now: 17 }).position).toEqual(typed);
  });
  it("keeps the last committed caret visible throughout repeated redraws", () => {
    const guard = setup();
    for (let now = 0; now < 80; now += 10) {
      expect(guard.resolve({ position: stray, framed: true, now }).position).toEqual(input);
    }
  });
  it("confirms a genuine framed vertical move after the bounded settling interval", () => {
    const guard = setup();
    guard.resolve({ position: stray, framed: true, now: 10 });
    expect(
      guard.resolve({
        position: stray,
        framed: true,
        now: 10 + CONPTY_CURSOR_SETTLE_MS,
      }),
    ).toEqual({ position: stray, retryAfter: null });
  });
  it("typing and horizontal arrow movement paint immediately inside a frame", () => {
    const guard = setup();
    for (const x of [3, 4, 6, 4, 3, 2]) {
      const position = { ...input, x };
      expect(guard.resolve({ position, framed: true, now: x }).position).toEqual(position);
    }
  });
  it("unframed moves, including shell line feeds, are immediate", () => {
    expect(setup().resolve({ position: stray, framed: false, now: 1 })).toEqual({
      position: stray,
      retryAfter: null,
    });
  });
  it("alternate screen switches and reset do not retain the previous cursor", () => {
    const guard = setup();
    const alternate = { ...stray, buffer: "alternate" as const };
    expect(guard.resolve({ position: alternate, framed: true, now: 1 }).position).toEqual(
      alternate,
    );
    guard.reset();
    expect(guard.resolve({ position: input, framed: true, now: 2 }).position).toEqual(input);
  });
});
