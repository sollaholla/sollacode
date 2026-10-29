import { describe, expect, it } from "vite-plus/test";
import {
  createDeskSounds,
  createPhoneLine,
  deskBeats,
  lineDriveCurve,
  type DeskBeat,
} from "./phoneLine";
import { createFakeAudioGraph } from "./testing/fakeAudioGraph";

/** A small deterministic generator, so a sequence can be replayed. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}

/** Longer than any gap between keys, typos included: the gaps that are pauses. */
const PAUSE_SECONDS = 0.6;

function take(count: number, random: () => number): DeskBeat[] {
  const beats = deskBeats(random);
  return Array.from({ length: count }, () => beats.next().value);
}

describe("phone line", () => {
  it("soft-clips within full scale, symmetric and close to linear for speech", () => {
    const curve = lineDriveCurve(1_025);
    expect(curve[0]).toBeCloseTo(-1, 6);
    expect(curve[1_024]).toBeCloseTo(1, 6);
    expect(curve[512]).toBeCloseTo(0, 6);
    for (let index = 0; index < curve.length; index += 1) {
      expect(Math.abs(curve[index]!)).toBeLessThanOrEqual(1 + 1e-6);
      expect(curve[index]!).toBeCloseTo(-curve[curve.length - 1 - index]!, 6);
    }
    // A quiet sample comes out a little louder, never folded or inverted.
    const quiet = curve[512 + 51]!;
    expect(quiet).toBeGreaterThan(0.1);
    expect(quiet).toBeLessThan(0.2);
  });

  it("band-limits to a handset's range and ends in the speakers", () => {
    const graph = createFakeAudioGraph();
    const line = createPhoneLine(graph.context);
    const filters = graph.ofKind("biquad");
    const highpass = filters.filter((node) => node.type === "highpass");
    const lowpass = filters.filter((node) => node.type === "lowpass");
    expect(highpass.map((node) => node.frequency.value)).toEqual([300, 300]);
    expect(lowpass.map((node) => node.frequency.value)).toEqual([3_400, 3_400]);
    expect(line.input).toBe(highpass[0]);
    const last = graph.nodes.at(-1)!;
    expect(last.connections).toEqual([graph.destination]);

    line.setMuted(true);
    expect(last.gain.calls.at(-1)).toMatchObject({ method: "set", value: 0 });
    line.setMuted(false);
    expect(last.gain.calls.at(-1)).toMatchObject({ method: "set", value: 1 });
    line.disconnect();
    expect(graph.nodes.every((node) => node.disconnected)).toBe(true);
  });
});

describe("desk beats", () => {
  it("starts with a click into the window, then types words separated by spaces", () => {
    const beats = take(400, seeded(7));
    expect(beats[0]!.sound).toBe("click");
    const sounds = new Set(beats.map((beat) => beat.sound));
    expect(sounds).toEqual(new Set(["click", "key", "space", "backspace"]));
    for (const beat of beats) expect(beat.gap).toBeGreaterThan(0);
    // No word runs on for ever: at most eight letters, and a typo of three
    // backed out and retyped, before the space.
    let sinceSpace = 0;
    for (const beat of beats) {
      if (beat.sound === "click") continue;
      sinceSpace = beat.sound === "space" ? 0 : sinceSpace + 1;
      expect(sinceSpace).toBeLessThanOrEqual(14);
    }
  });

  it("types at a human pace", () => {
    const beats = take(2_000, seeded(42));
    const keyGaps = beats
      .filter((beat) => beat.sound === "key" || beat.sound === "space")
      .map((beat) => beat.gap)
      .filter((gap) => gap < PAUSE_SECONDS)
      .sort((a, b) => a - b);
    const median = keyGaps[Math.floor(keyGaps.length / 2)]!;
    expect(median).toBeGreaterThan(0.09);
    expect(median).toBeLessThan(0.2);
  });

  it("types in bursts of about two seconds, with a pause of random length after each", () => {
    const beats = take(4_000, seeded(42));
    const bursts: number[] = [];
    const pauses: number[] = [];
    let burst = 0;
    for (const beat of beats.slice(1)) {
      if (beat.gap >= PAUSE_SECONDS) {
        if (burst > 0) bursts.push(burst);
        pauses.push(beat.gap);
        burst = 0;
      } else if (beat.sound !== "click") {
        burst += beat.gap;
      }
    }
    expect(bursts.length).toBeGreaterThan(50);
    const mean = bursts.reduce((sum, value) => sum + value, 0) / bursts.length;
    expect(mean).toBeGreaterThan(1.6);
    expect(mean).toBeLessThan(3.2);
    // A burst runs past its length only to finish the word it is in.
    expect(Math.max(...bursts)).toBeLessThan(5.5);
    // Pauses vary rather than repeating one length, and none abandons the desk.
    expect(new Set(pauses.map((pause) => pause.toFixed(1))).size).toBeGreaterThan(10);
    expect(Math.max(...pauses)).toBeLessThan(4.6);
  });

  it("leaves a clear gap either side of every click", () => {
    const beats = take(4_000, seeded(9));
    beats.forEach((beat, index) => {
      if (index === 0 || beat.sound !== "click") return;
      const previous = beats[index - 1]!;
      // The second click of a double-click follows the first at once.
      if (previous.sound !== "click") expect(beat.gap).toBeGreaterThanOrEqual(0.6);
      const next = beats[index + 1];
      if (next && next.sound !== "click") expect(next.gap).toBeGreaterThanOrEqual(0.8);
    });
    expect(beats.filter((beat) => beat.sound === "click").length).toBeGreaterThan(20);
  });

  it("is the same sequence for the same randomness", () => {
    expect(take(200, seeded(3))).toEqual(take(200, seeded(3)));
  });
});

describe("desk sounds", () => {
  function desk(volume = 1) {
    let now = 0;
    const graph = createFakeAudioGraph(() => now);
    const destination = graph.context.createGain();
    const sounds = createDeskSounds({
      context: graph.context,
      destination,
      volume: () => volume,
      random: seeded(11),
    });
    const sources = () => graph.ofKind("source");
    return {
      graph,
      sounds,
      sources,
      advance: (seconds: number) => {
        // The session pumps every 100 ms.
        for (let step = 0; step < Math.round(seconds * 10); step += 1) {
          now += 0.1;
          sounds.pump();
        }
      },
    };
  }

  it("plays only while active, scheduled a fraction of a second ahead", () => {
    const d = desk();
    d.sounds.pump();
    expect(d.sources()).toHaveLength(0);
    d.sounds.setActive(true);
    d.advance(10);
    const starts = d.sources().flatMap((source) => source.starts);
    expect(starts.length).toBeGreaterThan(40);
    for (const start of starts) expect(start.at).toBeLessThanOrEqual(10 + 0.35 + 1e-9);
    // Every burst stays inside the shared noise buffer.
    for (const start of starts) expect(start.offset + start.duration).toBeLessThanOrEqual(0.25);

    d.sounds.setActive(false);
    const scheduled = d.sources().length;
    d.advance(5);
    expect(d.sources()).toHaveLength(scheduled);
  });

  it("fades what is already scheduled when work stops", () => {
    const d = desk();
    d.sounds.setActive(true);
    d.advance(2);
    const runGain = d.graph.ofKind("gain")[1]!;
    d.sounds.setActive(false);
    expect(runGain.gain.calls.at(-1)).toMatchObject({ method: "linear", value: 0 });
    // The next run gets its own gain, and the faded one is let go.
    d.sounds.setActive(true);
    expect(runGain.disconnected).toBe(true);
    d.sounds.dispose();
  });

  it("plays nothing at zero volume", () => {
    const d = desk(0);
    d.sounds.setActive(true);
    d.advance(5);
    expect(d.sources()).toHaveLength(0);
  });

  it("skips ahead after the clock stalls rather than playing the backlog at once", () => {
    let now = 0;
    const graph = createFakeAudioGraph(() => now);
    const sounds = createDeskSounds({
      context: graph.context,
      destination: graph.context.createGain(),
      volume: () => 1,
      random: seeded(5),
    });
    sounds.setActive(true);
    sounds.pump();
    now = 60;
    sounds.pump();
    const late = graph
      .ofKind("source")
      .flatMap((source) => source.starts)
      .filter((start) => start.at >= 60);
    for (const start of late) expect(start.at).toBeLessThanOrEqual(60.35 + 1e-9);
    expect(late.length).toBeLessThan(30);
  });
});
