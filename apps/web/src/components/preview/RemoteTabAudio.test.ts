import type { PreviewTabAudioEvent } from "@t3tools/contracts";
import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { listenToTabAudio } from "./RemoteTabAudio";

const packets = (timestamp: number): PreviewTabAudioEvent => ({
  type: "packets",
  format: { codec: "opus", sampleRate: 48_000, numberOfChannels: 2 },
  packets: [{ timestamp, duration: 20_000, data: "AAEC" }],
});

describe("listenToTabAudio", () => {
  it("opens the stream itself and hands over every event, batches included", async () => {
    let opened = 0;
    let events: Queue.Queue<PreviewTabAudioEvent, Cause.Done> | null = null;
    // Shaped like the real family: one element per arrival batch.
    const atom = Atom.make(
      Stream.callback<PreviewTabAudioEvent>((queue) =>
        Effect.sync(() => {
          opened += 1;
          events = queue;
        }),
      ).pipe(Stream.chunks),
    );
    const registry = AtomRegistry.make();
    const heard: PreviewTabAudioEvent[] = [];

    const stop = listenToTabAudio(registry, atom, (event) => heard.push(event));
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Nobody else reads the atom; the listener alone must start the stream.
    expect(opened).toBe(1);

    Queue.offerAllUnsafe(events!, [
      { type: "audible", audible: true },
      packets(0),
      packets(20_000),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(heard).toEqual([{ type: "audible", audible: true }, packets(0), packets(20_000)]);

    stop();
    registry.dispose();
  });
});
