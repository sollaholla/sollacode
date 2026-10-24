// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type { HostBattery, HostStorage, HostVitals } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ServerConfig from "../config.ts";

/** Battery and disk move slowly; a glance never needs fresher than this. */
const HOST_VITALS_INTERVAL = Duration.seconds(30);
const PROBE_TIMEOUT = Duration.seconds(5);

export class HostVitalsMonitor extends Context.Service<
  HostVitalsMonitor,
  {
    /** The current reading, then one every interval for as long as it is consumed. */
    readonly stream: Stream.Stream<HostVitals>;
  }
>()("t3/hostVitals/HostVitalsMonitor") {}

const clampPercent = (value: number): number => Math.min(100, Math.max(0, Math.round(value)));

/**
 * `pmset -g batt` on macOS. A desktop prints the "Now drawing from" line but
 * no battery line, which is how "has no battery" is told from "unreadable".
 */
export function parsePmsetBattery(output: string): HostBattery | null {
  const reading = /(\d{1,3})%;\s*([^;\n]+)/u.exec(output);
  if (reading === null) return null;
  return {
    percent: clampPercent(Number(reading[1])),
    pluggedIn: /drawing from 'AC Power'/u.test(output),
  };
}

/** `Win32_Battery` as JSON; BatteryStatus 1 is discharging, everything else is on power. */
export function parseWindowsBattery(output: string): HostBattery | null {
  const trimmed = output.trim();
  if (trimmed.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    const first = Array.isArray(parsed) ? parsed[0] : parsed;
    if (typeof first !== "object" || first === null) return null;
    const { EstimatedChargeRemaining: charge, BatteryStatus: status } = first as Record<
      string,
      unknown
    >;
    if (typeof charge !== "number") return null;
    return { percent: clampPercent(charge), pluggedIn: status !== 1 };
  } catch {
    return null;
  }
}

export function parseLinuxBattery(input: {
  readonly capacity: string;
  readonly status: string;
}): HostBattery | null {
  const percent = Number.parseInt(input.capacity.trim(), 10);
  if (!Number.isFinite(percent)) return null;
  return { percent: clampPercent(percent), pluggedIn: input.status.trim() !== "Discharging" };
}

async function readLinuxBattery(): Promise<HostBattery | null> {
  const root = "/sys/class/power_supply";
  try {
    for (const name of (await NodeFSP.readdir(root)).toSorted()) {
      const directory = NodePath.join(root, name);
      if ((await NodeFSP.readFile(NodePath.join(directory, "type"), "utf8")).trim() !== "Battery") {
        continue;
      }
      return parseLinuxBattery({
        capacity: await NodeFSP.readFile(NodePath.join(directory, "capacity"), "utf8"),
        status: await NodeFSP.readFile(NodePath.join(directory, "status"), "utf8"),
      });
    }
  } catch {
    // No power_supply class at all: a server or a container.
  }
  return null;
}

/** Free space as the user would be blocked by it: `bavail`, not `bfree`. */
export async function readStorage(directory: string): Promise<HostStorage | null> {
  try {
    const stats = await NodeFSP.statfs(directory);
    return {
      totalBytes: Math.round(stats.blocks * stats.bsize),
      freeBytes: Math.round(stats.bavail * stats.bsize),
    };
  } catch {
    return null;
  }
}

export const layer = Layer.effect(
  HostVitalsMonitor,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const platform = yield* HostProcessPlatform;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const run = (command: string, args: ReadonlyArray<string>) =>
      spawner.string(ChildProcess.make(command, args)).pipe(
        Effect.timeout(PROBE_TIMEOUT),
        Effect.orElseSucceed(() => ""),
      );

    const readBattery: Effect.Effect<HostBattery | null> = (() => {
      switch (platform) {
        case "darwin":
          return run("pmset", ["-g", "batt"]).pipe(Effect.map(parsePmsetBattery));
        case "win32":
          return run("powershell.exe", [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Get-CimInstance Win32_Battery | Select-Object EstimatedChargeRemaining,BatteryStatus | ConvertTo-Json -Compress",
          ]).pipe(Effect.map(parseWindowsBattery));
        case "linux":
          return Effect.promise(readLinuxBattery);
        default:
          return Effect.succeed(null);
      }
    })();

    const sample = Effect.gen(function* () {
      const [storage, battery, nowMs] = yield* Effect.all(
        [Effect.promise(() => readStorage(config.stateDir)), readBattery, Clock.currentTimeMillis],
        { concurrency: "unbounded" },
      );
      return { readAt: DateTime.makeUnsafe(nowMs), storage, battery } satisfies HostVitals;
    });

    return HostVitalsMonitor.of({
      stream: Stream.concat(
        Stream.fromEffect(sample),
        Stream.fromSchedule(Schedule.spaced(HOST_VITALS_INTERVAL)).pipe(
          Stream.mapEffect(() => sample),
        ),
      ),
    });
  }),
);
