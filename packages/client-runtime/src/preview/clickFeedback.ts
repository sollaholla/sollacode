// @effect-diagnostics globalTimers:off
export interface RemoteClickMarker {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly state: "pressed" | "pending" | "failed";
}

type Point = { readonly x: number; readonly y: number };

/** A touch has to last this long to show a dot, so the first finger of a pinch never does. */
export const TOUCH_PRESS_MARKER_DELAY_MS = 120;

/** Local feedback is created before transport starts; only a matching receipt retires it. */
export class RemoteClickFeedback {
  private markers: readonly RemoteClickMarker[] = [];
  private nextId = 0;
  private contact: Point | null = null;
  private pressTimer: ReturnType<typeof setTimeout> | undefined;
  private listeners = new Set<() => void>();

  getSnapshot = () => this.markers;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private update(markers: readonly RemoteClickMarker[]) {
    this.markers = markers;
    for (const listener of this.listeners) listener();
  }

  /** Pass `delayMs` for touch, where a press may yet turn out to be a pinch. */
  press(point: Point, contact: Point, options?: { readonly delayMs?: number }) {
    clearTimeout(this.pressTimer);
    this.contact = contact;
    const kept = this.markers.filter((marker) => marker.state === "pending");
    const show = () => {
      this.update([
        ...this.markers.filter((marker) => marker.state === "pending"),
        { ...point, id: `local-${++this.nextId}`, state: "pressed" },
      ]);
    };
    if (options?.delayMs === undefined) {
      show();
      return;
    }
    if (kept.length !== this.markers.length) this.update(kept);
    this.pressTimer = setTimeout(show, options.delayMs);
  }

  movePress(contact: Point, slop: number) {
    if (this.contact && Math.hypot(contact.x - this.contact.x, contact.y - this.contact.y) > slop) {
      this.cancelPress();
    }
  }

  cancelPress() {
    clearTimeout(this.pressTimer);
    this.contact = null;
    if (this.markers.some((marker) => marker.state === "pressed")) {
      this.update(this.markers.filter((marker) => marker.state !== "pressed"));
    }
  }

  submit(point: Point, id = `local-${++this.nextId}`): string {
    clearTimeout(this.pressTimer);
    this.contact = null;
    this.update([
      ...this.markers.filter((marker) => marker.state === "pending"),
      { ...point, id, state: "pending" },
    ]);
    return id;
  }

  settle(id: string, applied: boolean) {
    if (!this.markers.some((marker) => marker.id === id)) return;
    this.update(
      applied
        ? this.markers.filter((marker) => marker.id !== id)
        : this.markers.map((marker) =>
            marker.id === id ? { ...marker, state: "failed" } : marker,
          ),
    );
  }

  reset() {
    clearTimeout(this.pressTimer);
    this.contact = null;
    if (this.markers.length > 0) this.update([]);
  }
}
