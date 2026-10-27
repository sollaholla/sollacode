// @effect-diagnostics nodeBuiltinImport:off - simctl, adb, and the emulator are host tools.
// @effect-diagnostics globalTimers:off - Polls child processes that live outside the Effect runtime.
// @effect-diagnostics globalDate:off - Short host-side caches and grace periods, not domain time.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  DeviceError,
  type DeviceCatalog,
  type DeviceCreateInput,
  type DeviceListResult,
  type DeviceModelOption,
  type DevicePlatformCatalog,
  type DevicePlatformStatus,
  type DevicePowerInput,
  type DeviceRef,
  type DeviceState,
  type DeviceSummary,
  type DeviceSystemOption,
  type DeviceViewResult,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  androidJavaHomeCandidates,
  androidSdkCandidates,
  avdNameFromDisplayName,
  parseAdbDevices,
  parseAvd,
  parseAvdmanagerDevices,
  parseEmulatorAvdName,
  parseIni,
  parseSystemImage,
} from "./androidEmulators.ts";
import {
  EmulatorControl,
  emulatorDiscoveryDirs,
  readEmulatorDiscovery,
  type EmulatorDiscovery,
} from "./androidEmulatorControl.ts";
import { adbAndroidScreen, grpcAndroidScreen } from "./androidScreens.ts";
import { startAndroidViewer, type AndroidScreen, type AndroidViewer } from "./androidViewer.ts";
import {
  parseServeSimServerState,
  parseSimulators,
  serveSimViewerUrl,
  simulatorCatalog,
  type ServeSimServerState,
  type SimctlList,
} from "./iosSimulators.ts";

/** Pinned so a new serve-sim release can't change the viewer under people. */
const SERVE_SIM_PACKAGE = "serve-sim@0.1.45";
const SERVE_SIM_START_TIMEOUT_MS = 120_000;
const SIMULATOR_BOOT_TIMEOUT_MS = 180_000;
const EMULATOR_EARLY_EXIT_MS = 5_000;
const EMULATOR_STARTING_GRACE_MS = 5 * 60_000;
const EMULATOR_STOPPING_GRACE_MS = 30_000;
const ANDROID_SERIAL_CACHE_MS = 2_000;
const ANDROID_PROFILE_CACHE_MS = 10 * 60_000;

const SIMULATOR_UDID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/iu;
const AVD_NAME = /^[\w.-]+$/u;

export class DeviceManager extends Context.Service<
  DeviceManager,
  {
    readonly list: Effect.Effect<DeviceListResult, DeviceError>;
    readonly catalog: Effect.Effect<DeviceCatalog, DeviceError>;
    readonly create: (input: DeviceCreateInput) => Effect.Effect<DeviceSummary, DeviceError>;
    readonly remove: (ref: DeviceRef) => Effect.Effect<void, DeviceError>;
    readonly setPower: (input: DevicePowerInput) => Effect.Effect<void, DeviceError>;
    readonly view: (ref: DeviceRef) => Effect.Effect<DeviceViewResult, DeviceError>;
  }
>()("t3/devices/DeviceManager") {}

/** A failure whose message is already written for the person reading it. */
class DeviceToolError extends Error {}

interface CommandResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
  /** Set when the command could not run at all, such as ENOENT. */
  readonly spawnError: string | null;
}

function quoteForCmd(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function runCommand(
  command: string,
  args: ReadonlyArray<string>,
  options: {
    readonly timeoutMs?: number;
    readonly env?: NodeJS.ProcessEnv;
    readonly input?: string;
    readonly platform?: NodeJS.Platform;
  } = {},
): Promise<CommandResult> {
  // Windows refuses to spawn .bat files (avdmanager) without a shell.
  const viaCmd = options.platform === "win32" && /\.(bat|cmd)$/iu.test(command);
  return new Promise((resolve) => {
    const child = NodeChildProcess.execFile(
      viaCmd ? quoteForCmd(command) : command,
      viaCmd ? args.map(quoteForCmd) : args,
      {
        timeout: options.timeoutMs ?? 30_000,
        maxBuffer: 16 * 1024 * 1024,
        env: options.env ?? process.env,
        windowsHide: true,
        shell: viaCmd,
      },
      (error, stdout, stderr) => {
        const code = (error as NodeJS.ErrnoException | null)?.code;
        resolve({
          ok: error === null,
          stdout: String(stdout),
          stderr: String(stderr),
          spawnError: typeof code === "string" ? code : null,
        });
      },
    );
    if (options.input !== undefined) child.stdin?.end(options.input);
  });
}

function runBinary(
  command: string,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    NodeChildProcess.execFile(
      command,
      args,
      { encoding: "buffer", timeout: 10_000, maxBuffer: 64 * 1024 * 1024, env, windowsHide: true },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
}

function firstLine(text: string): string {
  return (
    text
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ""
  );
}

async function readLogTail(path: string): Promise<string> {
  const text = await NodeFSP.readFile(path, "utf8").catch(() => "");
  return text
    .replaceAll(String.fromCharCode(27), "")
    .replaceAll(/\[[0-9;]*m/gu, "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-3)
    .join(" ");
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === "EPERM";
  }
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function exists(path: string): Promise<boolean> {
  return NodeFSP.access(path).then(
    () => true,
    () => false,
  );
}

interface AndroidSdk {
  readonly root: string;
  readonly adb: string;
  readonly emulator: string | null;
  readonly avdmanager: string | null;
  readonly javaHome: string | null;
  readonly env: NodeJS.ProcessEnv;
}

interface RunningEmulator {
  readonly serial: string;
  readonly booted: boolean;
  readonly discovery: EmulatorDiscovery | null;
}

/**
 * iOS simulators through `xcrun simctl` and serve-sim, Android emulators
 * through the Android SDK's adb, emulator, and avdmanager. Simulators and
 * emulators keep running when the server stops; the serve-sim viewers this
 * server started do not.
 */
export function makeDeviceTools(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly home: string;
  readonly platform: NodeJS.Platform;
}) {
  const run: typeof runCommand = (command, args, options = {}) =>
    runCommand(command, args, { ...options, platform: input.platform });
  const logDir = NodePath.join(NodeOS.tmpdir(), "solla-devices");
  const serveSimStateDir = NodePath.join(NodeOS.tmpdir(), "serve-sim");
  const serveSimProcesses = new Map<string, NodeChildProcess.ChildProcess>();
  const launchedEmulators = new Map<string, { child: NodeChildProcess.ChildProcess; at: number }>();
  const stoppingEmulators = new Map<string, number>();
  const queues = new Map<string, Promise<unknown>>();
  let runningCache: { at: number; value: Map<string, RunningEmulator> } | null = null;
  let profileCache: { at: number; value: DeviceModelOption[] } | null = null;
  let androidViewer: Promise<AndroidViewer> | null = null;
  const androidScreens = new Map<
    string,
    { key: string; screen: AndroidScreen; control: EmulatorControl | null }
  >();
  const handwritingOff = new Set<string>();

  /** Runs one change per device at a time, so a double click can't boot twice. */
  const serialized = <A>(key: string, task: () => Promise<A>): Promise<A> => {
    const previous = queues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    queues.set(key, next);
    void next
      .finally(() => {
        if (queues.get(key) === next) queues.delete(key);
      })
      .catch(() => undefined);
    return next;
  };

  const logPathFor = async (name: string) => {
    await NodeFSP.mkdir(logDir, { recursive: true });
    return NodePath.join(logDir, `${name.replace(/[^\w.-]+/gu, "_")}.log`);
  };

  // ---- iOS -----------------------------------------------------------------

  const readSimctl = async (): Promise<SimctlList | null> => {
    if (input.platform !== "darwin") return null;
    const result = await run("xcrun", ["simctl", "list", "-j"], { timeoutMs: 20_000 });
    if (!result.ok) return null;
    try {
      return JSON.parse(result.stdout) as SimctlList;
    } catch {
      return null;
    }
  };

  const iosStatus = (list: SimctlList | null): DevicePlatformStatus => {
    if (input.platform !== "darwin") {
      return {
        platform: "ios",
        available: false,
        detail: "iOS simulators need a Mac with Xcode.",
      };
    }
    if (list === null) {
      return {
        platform: "ios",
        available: false,
        detail: "Install Xcode from the App Store, then open it once to finish setup.",
      };
    }
    return { platform: "ios", available: true, detail: null };
  };

  const requireSimulator = async (udid: string): Promise<DeviceSummary> => {
    if (!SIMULATOR_UDID.test(udid)) throw new DeviceToolError("That simulator id is not valid.");
    const list = await readSimctl();
    const device = list ? parseSimulators(list).find((candidate) => candidate.id === udid) : null;
    if (!device) throw new DeviceToolError("This simulator no longer exists.");
    return device;
  };

  const simctl = async (args: ReadonlyArray<string>, failure: string, timeoutMs = 60_000) => {
    const result = await run("xcrun", ["simctl", ...args], { timeoutMs });
    if (!result.ok) {
      const reason = firstLine(result.stderr) || firstLine(result.stdout);
      throw new DeviceToolError(reason ? `${failure}: ${reason}` : `${failure}.`);
    }
    return result.stdout;
  };

  const readServeSimState = async (udid: string): Promise<ServeSimServerState | null> => {
    const text = await NodeFSP.readFile(
      NodePath.join(serveSimStateDir, `server-${udid}.json`),
      "utf8",
    ).catch(() => null);
    const state = text === null ? null : parseServeSimServerState(text);
    return state !== null && state.device === udid && isProcessAlive(state.pid) ? state : null;
  };

  const stopServeSim = (udid: string) => {
    const child = serveSimProcesses.get(udid);
    serveSimProcesses.delete(udid);
    if (child?.pid === undefined || child.exitCode !== null) return;
    try {
      // Detached at spawn, so the npx wrapper and serve-sim share this group.
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  };

  const startServeSim = async (device: DeviceSummary): Promise<DeviceViewResult> => {
    const running = await readServeSimState(device.id);
    if (running !== null) return { url: serveSimViewerUrl(running) };
    stopServeSim(device.id);

    const logPath = await logPathFor(`serve-sim-${device.id}`);
    const log = NodeFS.openSync(logPath, "w");
    let child: NodeChildProcess.ChildProcess;
    try {
      child = NodeChildProcess.spawn(
        "npx",
        ["--yes", SERVE_SIM_PACKAGE, "--quiet", "--panes", "none", "--fit", device.id],
        {
          cwd: NodeOS.tmpdir(),
          detached: true,
          stdio: ["ignore", log, log],
          env: input.env,
        },
      );
    } finally {
      NodeFS.closeSync(log);
    }
    let spawnError: Error | null = null;
    child.once("error", (cause) => {
      spawnError = cause;
    });
    child.once("exit", () => {
      if (serveSimProcesses.get(device.id) === child) serveSimProcesses.delete(device.id);
    });
    serveSimProcesses.set(device.id, child);

    const deadline = Date.now() + SERVE_SIM_START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const state = await readServeSimState(device.id);
      if (state !== null) return { url: serveSimViewerUrl(state) };
      if (spawnError !== null) {
        stopServeSim(device.id);
        throw new DeviceToolError(
          (spawnError as NodeJS.ErrnoException).code === "ENOENT"
            ? "Showing simulators needs Node.js (npx) on this computer."
            : `Couldn't start the simulator view: ${(spawnError as Error).message}`,
        );
      }
      if (child.exitCode !== null) {
        const tail = await readLogTail(logPath);
        throw new DeviceToolError(
          tail ? `The simulator view stopped: ${tail}` : "The simulator view stopped on its own.",
        );
      }
      await delay(300);
    }
    stopServeSim(device.id);
    throw new DeviceToolError("The simulator view took too long to start. Try again.");
  };

  const viewSimulator = async (udid: string): Promise<DeviceViewResult> => {
    const device = await requireSimulator(udid);
    if (device.state !== "on") {
      // Boots it if needed and waits until it can run apps.
      await simctl(
        ["bootstatus", udid, "-b"],
        `Couldn't start ${device.name}`,
        SIMULATOR_BOOT_TIMEOUT_MS,
      );
    }
    return startServeSim(device);
  };

  const setSimulatorPower = async (udid: string, on: boolean) => {
    const device = await requireSimulator(udid);
    if (on) {
      if (device.state === "off") await simctl(["boot", udid], `Couldn't start ${device.name}`);
      return;
    }
    stopServeSim(udid);
    if (device.state !== "off") {
      await simctl(["shutdown", udid], `Couldn't shut down ${device.name}`);
    }
  };

  const createSimulator = async (request: DeviceCreateInput): Promise<DeviceSummary> => {
    const list = await readSimctl();
    if (list === null) throw new DeviceToolError(iosStatus(list).detail ?? "Xcode is unavailable.");
    const catalog = simulatorCatalog(list);
    const system = catalog.systems.find((candidate) => candidate.id === request.systemId);
    if (!system) throw new DeviceToolError("That iOS version isn't installed.");
    if (!system.modelIds.includes(request.modelId)) {
      throw new DeviceToolError(`${system.name} can't run that model.`);
    }
    const udid = firstLine(
      await simctl(
        ["create", request.name, request.modelId, request.systemId],
        "Couldn't add the simulator",
      ),
    );
    const created = parseSimulators((await readSimctl()) ?? {}).find(
      (candidate) => candidate.id === udid,
    );
    if (!created) throw new DeviceToolError("The simulator was added but couldn't be read back.");
    return created;
  };

  const deleteSimulator = async (udid: string) => {
    const device = await requireSimulator(udid);
    stopServeSim(udid);
    if (device.state !== "off") {
      await simctl(["shutdown", udid], `Couldn't shut down ${device.name}`);
    }
    await simctl(["delete", udid], `Couldn't remove ${device.name}`);
  };

  // ---- Android -------------------------------------------------------------

  const executable = (dir: string, name: string, windowsExtension: string) =>
    NodePath.join(dir, input.platform === "win32" ? `${name}${windowsExtension}` : name);

  const findAndroidSdk = async (): Promise<AndroidSdk | null> => {
    for (const root of androidSdkCandidates(input)) {
      const adb = executable(NodePath.join(root, "platform-tools"), "adb", ".exe");
      if (!(await exists(adb))) continue;
      const emulator = executable(NodePath.join(root, "emulator"), "emulator", ".exe");
      const avdmanager = executable(
        NodePath.join(root, "cmdline-tools", "latest", "bin"),
        "avdmanager",
        ".bat",
      );
      let javaHome: string | null = null;
      for (const candidate of androidJavaHomeCandidates(input)) {
        if (await exists(executable(NodePath.join(candidate, "bin"), "java", ".exe"))) {
          javaHome = candidate;
          break;
        }
      }
      return {
        root,
        adb,
        emulator: (await exists(emulator)) ? emulator : null,
        avdmanager: (await exists(avdmanager)) ? avdmanager : null,
        javaHome,
        env: {
          ...input.env,
          ANDROID_HOME: root,
          ANDROID_SDK_ROOT: root,
          ...(javaHome ? { JAVA_HOME: javaHome } : {}),
        },
      };
    }
    return null;
  };

  const avdHome = () => {
    if (input.env.ANDROID_AVD_HOME) return input.env.ANDROID_AVD_HOME;
    if (input.env.ANDROID_USER_HOME) return NodePath.join(input.env.ANDROID_USER_HOME, "avd");
    return NodePath.join(input.home, ".android", "avd");
  };

  const avdDirectory = async (name: string): Promise<string> => {
    const ini = parseIni(
      await NodeFSP.readFile(NodePath.join(avdHome(), `${name}.ini`), "utf8").catch(() => ""),
    );
    return ini.get("path") ?? NodePath.join(avdHome(), `${name}.avd`);
  };

  const listAvds = async (): Promise<Array<Omit<DeviceSummary, "state">>> => {
    const entries = await NodeFSP.readdir(avdHome()).catch(() => [] as string[]);
    const avds = await Promise.all(
      entries
        .filter((entry) => entry.endsWith(".ini"))
        .map(async (entry) => {
          const name = entry.slice(0, -".ini".length);
          if (!AVD_NAME.test(name)) return null;
          const config = await NodeFSP.readFile(
            NodePath.join(await avdDirectory(name), "config.ini"),
            "utf8",
          ).catch(() => null);
          return config === null ? null : parseAvd({ name, config });
        }),
    );
    return avds
      .filter((avd): avd is Omit<DeviceSummary, "state"> => avd !== null)
      .toSorted((left, right) => left.name.localeCompare(right.name));
  };

  const readRunningEmulators = async (sdk: AndroidSdk): Promise<Map<string, RunningEmulator>> => {
    if (runningCache && Date.now() - runningCache.at < ANDROID_SERIAL_CACHE_MS) {
      return runningCache.value;
    }
    const [devices, discovered] = await Promise.all([
      run(sdk.adb, ["devices"], { env: sdk.env, timeoutMs: 15_000 }),
      readEmulatorDiscovery(emulatorDiscoveryDirs(input), isProcessAlive),
    ]);
    const adbSerials = parseAdbDevices(devices.stdout);
    const isBooted = async (serial: string) => {
      if (!adbSerials.some((entry) => entry.serial === serial && entry.online)) return false;
      const boot = await run(sdk.adb, ["-s", serial, "shell", "getprop", "sys.boot_completed"], {
        env: sdk.env,
        timeoutMs: 5_000,
      });
      return boot.stdout.trim() === "1";
    };
    const running = new Map<string, RunningEmulator>();
    await Promise.all([
      // Emulators write a discovery file with their name, serial, and control port.
      ...discovered.map(async (discovery) => {
        running.set(discovery.avdName, {
          serial: discovery.serial,
          booted: await isBooted(discovery.serial),
          discovery,
        });
      }),
      // Older emulators without one are asked their name over adb.
      ...adbSerials
        .filter(({ serial }) => !discovered.some((discovery) => discovery.serial === serial))
        .map(async ({ serial }) => {
          const nameResult = await run(sdk.adb, ["-s", serial, "emu", "avd", "name"], {
            env: sdk.env,
            timeoutMs: 5_000,
          });
          const name = parseEmulatorAvdName(nameResult.stdout);
          if (name !== null && !running.has(name)) {
            running.set(name, { serial, booted: await isBooted(serial), discovery: null });
          }
        }),
    ]);
    runningCache = { at: Date.now(), value: running };
    return running;
  };

  const emulatorState = (name: string, running: RunningEmulator | undefined): DeviceState => {
    const stoppingSince = stoppingEmulators.get(name);
    if (stoppingSince !== undefined) {
      if (running !== undefined && Date.now() - stoppingSince < EMULATOR_STOPPING_GRACE_MS) {
        return "stopping";
      }
      stoppingEmulators.delete(name);
    }
    if (running?.booted) return "on";
    if (running !== undefined) return "starting";
    const launched = launchedEmulators.get(name);
    if (
      launched &&
      launched.child.exitCode === null &&
      Date.now() - launched.at < EMULATOR_STARTING_GRACE_MS
    ) {
      return "starting";
    }
    return "off";
  };

  const androidStatus = (sdk: AndroidSdk | null): DevicePlatformStatus => {
    if (sdk === null) {
      return {
        platform: "android",
        available: false,
        detail: "Install Android Studio, then open it once so it downloads the Android SDK.",
      };
    }
    if (sdk.emulator === null) {
      return {
        platform: "android",
        available: false,
        detail: "Install the Android Emulator from Android Studio's SDK Manager.",
      };
    }
    return { platform: "android", available: true, detail: null };
  };

  const requireAndroid = async (): Promise<AndroidSdk & { readonly emulator: string }> => {
    const sdk = await findAndroidSdk();
    const status = androidStatus(sdk);
    if (sdk === null || sdk.emulator === null) {
      throw new DeviceToolError(status.detail ?? "The Android SDK is unavailable.");
    }
    return { ...sdk, emulator: sdk.emulator };
  };

  const requireAvd = async (name: string) => {
    if (!AVD_NAME.test(name)) throw new DeviceToolError("That emulator name is not valid.");
    const avd = (await listAvds()).find((candidate) => candidate.id === name);
    if (!avd) throw new DeviceToolError("This emulator no longer exists.");
    return avd;
  };

  const startEmulator = async (name: string) => {
    const sdk = await requireAndroid();
    const avd = await requireAvd(name);
    runningCache = null;
    const running = await readRunningEmulators(sdk);
    if (running.has(name)) return;
    const launched = launchedEmulators.get(name);
    if (launched && launched.child.exitCode === null) return;

    const logPath = await logPathFor(`emulator-${name}`);
    const log = NodeFS.openSync(logPath, "w");
    let child: NodeChildProcess.ChildProcess;
    try {
      // No window: the device is shown in Solla Code. Detached so the emulator,
      // like a simulator, keeps running across server restarts.
      child = NodeChildProcess.spawn(
        sdk.emulator,
        ["-avd", name, "-no-window", "-no-audio", "-no-boot-anim"],
        { detached: true, stdio: ["ignore", log, log], env: sdk.env, windowsHide: true },
      );
    } finally {
      NodeFS.closeSync(log);
    }
    child.unref();
    stoppingEmulators.delete(name);
    launchedEmulators.set(name, { child, at: Date.now() });

    const exited = await Promise.race([
      new Promise<boolean>((resolve) => {
        child.once("exit", () => resolve(true));
        child.once("error", () => resolve(true));
      }),
      delay(EMULATOR_EARLY_EXIT_MS).then(() => false),
    ]);
    if (exited) {
      launchedEmulators.delete(name);
      const tail = await readLogTail(logPath);
      throw new DeviceToolError(
        tail ? `${avd.name} didn't start: ${tail}` : `${avd.name} didn't start.`,
      );
    }
  };

  const stopEmulator = async (name: string) => {
    const sdk = await requireAndroid();
    runningCache = null;
    const running = (await readRunningEmulators(sdk)).get(name);
    launchedEmulators.delete(name);
    if (!running) return;
    stoppingEmulators.set(name, Date.now());
    const result = await run(sdk.adb, ["-s", running.serial, "emu", "kill"], {
      env: sdk.env,
      timeoutMs: 15_000,
    });
    runningCache = null;
    if (!result.ok) {
      stoppingEmulators.delete(name);
      throw new DeviceToolError(
        `Couldn't shut down the emulator: ${firstLine(result.stderr) || "adb did not answer"}`,
      );
    }
  };

  const androidModels = async (sdk: AndroidSdk): Promise<DeviceModelOption[]> => {
    if (profileCache && Date.now() - profileCache.at < ANDROID_PROFILE_CACHE_MS) {
      return profileCache.value;
    }
    if (sdk.avdmanager === null || sdk.javaHome === null) return [];
    const result = await run(sdk.avdmanager, ["list", "device"], {
      env: sdk.env,
      timeoutMs: 60_000,
    });
    const models = parseAvdmanagerDevices(result.stdout);
    if (models.length > 0) profileCache = { at: Date.now(), value: models };
    return models;
  };

  const androidSystems = async (sdk: AndroidSdk): Promise<DeviceSystemOption[]> => {
    const imagesRoot = NodePath.join(sdk.root, "system-images");
    const images: Array<{ id: string; name: string; apiLevel: number }> = [];
    for (const platformDir of await NodeFSP.readdir(imagesRoot).catch(() => [] as string[])) {
      for (const tagDir of await NodeFSP.readdir(NodePath.join(imagesRoot, platformDir)).catch(
        () => [] as string[],
      )) {
        for (const abiDir of await NodeFSP.readdir(
          NodePath.join(imagesRoot, platformDir, tagDir),
        ).catch(() => [] as string[])) {
          const properties = await NodeFSP.readFile(
            NodePath.join(imagesRoot, platformDir, tagDir, abiDir, "source.properties"),
            "utf8",
          ).catch(() => null);
          if (properties === null) continue;
          const image = parseSystemImage(
            ["system-images", platformDir, tagDir, abiDir].join("/"),
            properties,
          );
          if (image) images.push(image);
        }
      }
    }
    return images
      .toSorted(
        (left, right) => right.apiLevel - left.apiLevel || left.name.localeCompare(right.name),
      )
      .map(({ id, name }) => ({ id, name, modelIds: [] }));
  };

  const androidCatalog = async (): Promise<DevicePlatformCatalog | null> => {
    const sdk = await findAndroidSdk();
    if (sdk === null || sdk.emulator === null) return null;
    const [models, systems] = await Promise.all([androidModels(sdk), androidSystems(sdk)]);
    let detail: string | null = null;
    if (sdk.avdmanager === null) {
      detail =
        "Adding emulators needs the Android SDK Command-line Tools. Install them from Android Studio's SDK Manager, under SDK Tools.";
    } else if (sdk.javaHome === null) {
      detail = "Adding emulators needs Java. Android Studio includes it; install Android Studio.";
    } else if (systems.length === 0) {
      detail = "Install an Android system image from Android Studio's SDK Manager first.";
    }
    return { platform: "android", models, systems, detail };
  };

  const createEmulator = async (request: DeviceCreateInput): Promise<DeviceSummary> => {
    const sdk = await requireAndroid();
    const catalog = await androidCatalog();
    if (catalog?.detail) throw new DeviceToolError(catalog.detail);
    if (!catalog?.systems.some((system) => system.id === request.systemId)) {
      throw new DeviceToolError("That Android system image isn't installed.");
    }
    if (!catalog.models.some((model) => model.id === request.modelId)) {
      throw new DeviceToolError("That device model isn't available.");
    }
    const taken = new Set((await listAvds()).map((avd) => avd.id.toLowerCase()));
    const base = avdNameFromDisplayName(request.name);
    let name = base;
    for (let suffix = 2; taken.has(name.toLowerCase()); suffix += 1) name = `${base}_${suffix}`;

    const result = await run(
      sdk.avdmanager!,
      ["create", "avd", "-n", name, "-k", request.systemId, "-d", request.modelId],
      // Answers "Do you wish to create a custom hardware profile?"
      { env: sdk.env, timeoutMs: 120_000, input: "no\n" },
    );
    if (!result.ok) {
      const reason =
        firstLine(result.stderr.replace(/^Warning:.*$/gmu, "")) || firstLine(result.stdout);
      throw new DeviceToolError(
        reason ? `Couldn't add the emulator: ${reason}` : "Couldn't add the emulator.",
      );
    }
    const configPath = NodePath.join(await avdDirectory(name), "config.ini");
    const config = await NodeFSP.readFile(configPath, "utf8").catch(() => null);
    if (config !== null) {
      const lines = config
        .split(/\r?\n/u)
        .filter((line) => line.length > 0 && !line.startsWith("avd.ini.displayname="));
      lines.push(`avd.ini.displayname=${request.name.replaceAll(/[\r\n]/gu, " ")}`);
      await NodeFSP.writeFile(configPath, `${lines.join("\n")}\n`);
    }
    const created = (await listAvds()).find((avd) => avd.id === name);
    if (!created) throw new DeviceToolError("The emulator was added but couldn't be read back.");
    return { ...created, state: "off" };
  };

  const deleteEmulator = async (name: string) => {
    const sdk = await requireAndroid();
    const avd = await requireAvd(name);
    await stopEmulator(name);
    for (let attempt = 0; attempt < 30; attempt += 1) {
      runningCache = null;
      if (!(await readRunningEmulators(sdk)).has(name)) break;
      await delay(500);
    }
    if (sdk.avdmanager !== null && sdk.javaHome !== null) {
      const result = await run(sdk.avdmanager, ["delete", "avd", "-n", name], {
        env: sdk.env,
        timeoutMs: 60_000,
      });
      if (result.ok) return;
    }
    // avdmanager deletes exactly these two: the AVD's folder and its pointer file.
    const directory = await avdDirectory(name);
    if (!directory.endsWith(".avd")) {
      throw new DeviceToolError(
        `Couldn't remove ${avd.name}: its folder is not an emulator folder.`,
      );
    }
    await NodeFSP.rm(directory, { recursive: true, force: true });
    await NodeFSP.rm(NodePath.join(avdHome(), `${name}.ini`), { force: true });
  };

  const screenFor = async (name: string): Promise<AndroidScreen | null> => {
    const sdk = await findAndroidSdk();
    if (sdk === null) return null;
    const running = (await readRunningEmulators(sdk)).get(name);
    if (!running) return null;
    const key = `${running.serial}:${running.discovery?.pid ?? "adb"}`;
    if (running.booted && !handwritingOff.has(key)) {
      // The emulator's touchscreen reports stylus buttons, so Android reads
      // mouse clicks as a pen and interrupts with its handwriting tutorial.
      handwritingOff.add(key);
      void run(
        sdk.adb,
        [
          "-s",
          running.serial,
          "shell",
          "settings",
          "put",
          "secure",
          "stylus_handwriting_enabled",
          "0",
        ],
        { env: sdk.env, timeoutMs: 10_000 },
      );
    }
    const cached = androidScreens.get(name);
    if (cached?.key === key) return cached.screen;
    cached?.control?.close();

    const adb = async (args: ReadonlyArray<string>) => {
      await run(sdk.adb, ["-s", running.serial, ...args], {
        env: sdk.env,
        timeoutMs: 10_000,
      });
    };
    let control: EmulatorControl | null = null;
    let screen: AndroidScreen;
    const port = running.discovery?.grpcPort;
    const token = running.discovery?.grpcToken;
    if (port && token) {
      control = new EmulatorControl(port, token);
      const config = parseIni(
        await NodeFSP.readFile(NodePath.join(await avdDirectory(name), "config.ini"), "utf8").catch(
          () => "",
        ),
      );
      const width = Number(config.get("hw.lcd.width"));
      const height = Number(config.get("hw.lcd.height"));
      screen = grpcAndroidScreen({
        control,
        panel: width > 0 && height > 0 ? { width, height } : null,
        adb,
      });
    } else {
      screen = adbAndroidScreen({
        capture: async () => {
          const png = await runBinary(
            sdk.adb,
            ["-s", running.serial, "exec-out", "screencap", "-p"],
            sdk.env,
          );
          if (png.length < 8 || png.readUInt32BE(0) !== 0x89504e47) {
            throw new Error("The emulator returned no screen yet.");
          }
          return png;
        },
        adb,
      });
    }
    androidScreens.set(name, { key, screen, control });
    return screen;
  };

  const ensureAndroidViewer = () => {
    androidViewer ??= startAndroidViewer({ screenFor }).catch((cause: unknown) => {
      androidViewer = null;
      throw cause;
    });
    return androidViewer;
  };

  const viewEmulator = async (name: string): Promise<DeviceViewResult> => {
    await requireAvd(name);
    await startEmulator(name);
    const viewer = await ensureAndroidViewer();
    return { url: viewer.urlFor(name) };
  };

  // ---- Public --------------------------------------------------------------

  return {
    list: async (): Promise<DeviceListResult> => {
      const [simctlList, sdk] = await Promise.all([readSimctl(), findAndroidSdk()]);
      const ios = iosStatus(simctlList);
      const android = androidStatus(sdk);
      const devices: DeviceSummary[] = simctlList ? parseSimulators(simctlList) : [];
      if (sdk !== null && android.available) {
        const [avds, running] = await Promise.all([listAvds(), readRunningEmulators(sdk)]);
        for (const avd of avds)
          devices.push({ ...avd, state: emulatorState(avd.id, running.get(avd.id)) });
      }
      return { platforms: [ios, android], devices };
    },
    catalog: async (): Promise<DeviceCatalog> => {
      const [simctlList, android] = await Promise.all([readSimctl(), androidCatalog()]);
      const platforms: DevicePlatformCatalog[] = [];
      if (simctlList !== null) platforms.push(simulatorCatalog(simctlList));
      if (android !== null) platforms.push(android);
      return { platforms };
    },
    create: (request: DeviceCreateInput) =>
      request.platform === "ios" ? createSimulator(request) : createEmulator(request),
    remove: (ref: DeviceRef) =>
      serialized(`${ref.platform}:${ref.id}`, () =>
        ref.platform === "ios" ? deleteSimulator(ref.id) : deleteEmulator(ref.id),
      ),
    setPower: (request: DevicePowerInput) =>
      serialized(`${request.platform}:${request.id}`, () => {
        if (request.platform === "ios") return setSimulatorPower(request.id, request.on);
        return request.on ? startEmulator(request.id) : stopEmulator(request.id);
      }),
    view: (ref: DeviceRef) =>
      serialized(`${ref.platform}:${ref.id}`, () =>
        ref.platform === "ios" ? viewSimulator(ref.id) : viewEmulator(ref.id),
      ),
    dispose: async () => {
      for (const udid of serveSimProcesses.keys()) stopServeSim(udid);
      for (const { control } of androidScreens.values()) control?.close();
      androidScreens.clear();
      const viewer = await androidViewer?.catch(() => null);
      await viewer?.close();
    },
  };
}

function toDeviceError(action: string, cause: unknown): DeviceError {
  if (cause instanceof DeviceToolError) return new DeviceError({ message: cause.message });
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new DeviceError({ message: `Couldn't ${action}: ${detail}` });
}

export const layer = Layer.effect(
  DeviceManager,
  Effect.gen(function* () {
    const platform = yield* HostProcessPlatform;
    const tools = makeDeviceTools({ env: process.env, home: NodeOS.homedir(), platform });
    yield* Effect.addFinalizer(() => Effect.promise(() => tools.dispose()));
    const call = <A>(action: string, task: () => Promise<A>) =>
      Effect.tryPromise({ try: task, catch: (cause) => toDeviceError(action, cause) });
    return DeviceManager.of({
      list: call("list devices", tools.list),
      catalog: call("read the device catalog", tools.catalog),
      create: (request) => call("add the device", () => tools.create(request)),
      remove: (ref) => call("remove the device", () => tools.remove(ref)),
      setPower: (request) =>
        call(request.on ? "start the device" : "shut down the device", () =>
          tools.setPower(request),
        ),
      view: (ref) => call("open the device", () => tools.view(ref)),
    });
  }),
);
