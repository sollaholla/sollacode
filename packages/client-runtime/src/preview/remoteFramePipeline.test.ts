import { describe, expect, it } from "vite-plus/test";

import { createLatestFramePipeline, type PipelineScheduler } from "./remoteFramePipeline.ts";

/** A manual clock: sleeps resolve only when the test advances time past them. */
function manualScheduler() {
  let now = 0;
  const sleepers: Array<{ until: number; resolve: () => void }> = [];
  const scheduler: PipelineScheduler = {
    now: () => now,
    sleep: (ms) =>
      new Promise<void>((resolve) => {
        sleepers.push({ until: now + ms, resolve });
      }),
  };
  const flush = async () => {
    for (let index = 0; index < 10; index++) await Promise.resolve();
  };
  return {
    scheduler,
    flush,
    advance: async (ms: number) => {
      now += ms;
      for (const sleeper of sleepers.splice(0)) {
        if (sleeper.until <= now) sleeper.resolve();
        else sleepers.push(sleeper);
      }
      await flush();
    },
  };
}

/** A process step that finishes only when the test says so. */
function controlledProcess() {
  const started: Array<number> = [];
  const finishers: Array<() => void> = [];
  return {
    started,
    finishNext: () => finishers.shift()?.(),
    process: (frame: number) =>
      new Promise<void>((resolve) => {
        started.push(frame);
        finishers.push(resolve);
      }),
  };
}

describe("createLatestFramePipeline", () => {
  it("processes the newest waiting picture and drops the ones it replaced", async () => {
    const clock = manualScheduler();
    const step = controlledProcess();
    const pipeline = createLatestFramePipeline({
      process: step.process,
      minIntervalMs: 0,
      scheduler: clock.scheduler,
    });
    pipeline.push(1);
    await clock.flush();
    pipeline.push(2);
    pipeline.push(3);
    pipeline.push(4);
    step.finishNext();
    await clock.flush();
    step.finishNext();
    await clock.flush();
    expect(step.started).toEqual([1, 4]);
  });

  it("spaces processing by the minimum interval but always ends on the last picture", async () => {
    const clock = manualScheduler();
    const processed: Array<number> = [];
    const pipeline = createLatestFramePipeline({
      process: async (frame: number) => {
        processed.push(frame);
      },
      minIntervalMs: 100,
      scheduler: clock.scheduler,
    });
    pipeline.push(1);
    await clock.flush();
    pipeline.push(2);
    pipeline.push(3);
    await clock.flush();
    expect(processed).toEqual([1]);
    await clock.advance(99);
    expect(processed).toEqual([1]);
    await clock.advance(1);
    expect(processed).toEqual([1, 3]);
  });

  it("holds the newest picture while paused and sends it once released", async () => {
    const clock = manualScheduler();
    const processed: Array<number> = [];
    const pipeline = createLatestFramePipeline({
      process: async (frame: number) => {
        processed.push(frame);
      },
      minIntervalMs: 0,
      scheduler: clock.scheduler,
    });
    pipeline.setPaused(true);
    pipeline.push(1);
    pipeline.push(2);
    await clock.flush();
    expect(processed).toEqual([]);
    pipeline.setPaused(false);
    await clock.flush();
    expect(processed).toEqual([2]);
  });

  it("keeps going after a failed step and stops for good once disposed", async () => {
    const clock = manualScheduler();
    const errors: Array<unknown> = [];
    const processed: Array<number> = [];
    const pipeline = createLatestFramePipeline({
      process: async (frame: number) => {
        processed.push(frame);
        if (frame === 1) throw new Error("publish failed");
      },
      minIntervalMs: 0,
      scheduler: clock.scheduler,
      onError: (error) => errors.push(error),
    });
    pipeline.push(1);
    await clock.flush();
    pipeline.push(2);
    await clock.flush();
    pipeline.dispose();
    pipeline.push(3);
    await clock.flush();
    expect(processed).toEqual([1, 2]);
    expect(errors).toHaveLength(1);
  });
});
