export interface RemoteClickMarker {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly state: "pressed" | "pending" | "failed";
}

type Point = { readonly x: number; readonly y: number };

/** Local feedback is created before transport starts; only a matching receipt retires it. */
export class RemoteClickFeedback {
  private markers: readonly RemoteClickMarker[] = [];
  private nextId = 0;
  private contact: Point | null = null;
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

  press(point: Point, contact: Point) {
    this.contact = contact;
    this.update([
      ...this.markers.filter((marker) => marker.state === "pending"),
      { ...point, id: `local-${++this.nextId}`, state: "pressed" },
    ]);
  }

  movePress(contact: Point, slop: number) {
    if (this.contact && Math.hypot(contact.x - this.contact.x, contact.y - this.contact.y) > slop) {
      this.cancelPress();
    }
  }

  cancelPress() {
    this.contact = null;
    if (this.markers.some((marker) => marker.state === "pressed")) {
      this.update(this.markers.filter((marker) => marker.state !== "pressed"));
    }
  }

  submit(point: Point, id = `local-${++this.nextId}`): string {
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
    this.contact = null;
    if (this.markers.length > 0) this.update([]);
  }
}
