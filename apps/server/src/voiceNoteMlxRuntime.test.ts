// @effect-diagnostics nodeBuiltinImport:off - Isolated fixture files verify the host installer.
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeNet from "node:net";
import * as NodeChildProcess from "node:child_process";
import {
  isVoiceMlxSupported,
  makeVoiceMlxRuntimeManager,
  resolveVoiceMlxRuntime,
  runVoiceMlxSetupProcess,
  VOICE_MLX_ENGINE,
} from "./voiceNoteMlxRuntime.ts";
import { VOICE_MLX_REQUIREMENTS } from "./voiceNoteMlxRequirements.ts";

const temporaryDirectories: string[] = [];
async function temporaryBase() {
  const path = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "solla-mlx-runtime-test-"));
  temporaryDirectories.push(path);
  return path;
}
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => NodeFSP.rm(path, { recursive: true, force: true })),
  );
});

function successfulInstaller() {
  const runProcess = vi.fn<typeof runVoiceMlxSetupProcess>(async (_command, args, options) => {
    options.signal.throwIfAborted();
    if (args[0] === "venv") {
      const venv = args.at(-1)!;
      await NodeFSP.mkdir(NodePath.join(venv, "bin"), { recursive: true });
      await NodeFSP.writeFile(NodePath.join(venv, "bin", "python"), "verified-test-interpreter", {
        mode: 0o700,
      });
    }
    if (args[2]?.includes("snapshot_download")) {
      const request = JSON.parse(options.input!) as { modelPath: string };
      await NodeFSP.writeFile(NodePath.join(request.modelPath, "config.json"), "{}");
      await NodeFSP.writeFile(
        NodePath.join(request.modelPath, "model.safetensors"),
        "verified-test-model",
      );
    }
    return { stdout: '{"verified":true}', stderr: "" };
  });
  const acquireUv = vi.fn(async () => "/isolated-test/uv");
  return { runProcess, acquireUv };
}

const location = (baseDir: string) => ({ baseDir, platform: "darwin" as const, arch: "arm64" });

describe("managed local speech runtime", () => {
  it.each([
    ["win32", "arm64"],
    ["linux", "arm64"],
    ["darwin", "x64"],
  ] as const)("never starts unsupported %s/%s setup", async (platform, arch) => {
    const baseDir = await temporaryBase();
    const dependencies = successfulInstaller();
    expect(isVoiceMlxSupported(platform, arch)).toBe(false);
    await expect(resolveVoiceMlxRuntime({ baseDir, platform, arch })).resolves.toBeNull();
    await expect(
      makeVoiceMlxRuntimeManager(dependencies)({ baseDir, platform, arch }),
    ).rejects.toThrow("Apple Silicon");
    expect(dependencies.acquireUv).not.toHaveBeenCalled();
    expect(await NodeFSP.readdir(baseDir)).toEqual([]);
  });

  it("keeps lookup read-only and does not treat unverified files as ready", async () => {
    const baseDir = await temporaryBase();
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(resolveVoiceMlxRuntime(location(baseDir))).resolves.toBeNull();
    expect(await NodeFSP.readdir(baseDir)).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("installs pinned dependencies and verifies offline inference before publishing readiness", async () => {
    const baseDir = await temporaryBase();
    const dependencies = successfulInstaller();
    const onProgress = vi.fn();
    const ensure = makeVoiceMlxRuntimeManager(dependencies);
    const runtime = await ensure({ ...location(baseDir), onProgress });
    expect(runtime.pythonPath).toContain(NodePath.join(baseDir, "voice-runtime"));
    expect(runtime.pythonPath).not.toContain("userdata");
    expect(runtime.modelPath).toContain(VOICE_MLX_ENGINE.revision);
    expect(runtime.engine).toBe("parakeet-tdt-0.6b-v3");
    expect(await resolveVoiceMlxRuntime(location(baseDir))).toEqual(runtime);
    const calls = dependencies.runProcess.mock.calls;
    expect(calls[0]?.[1]).toEqual(
      expect.arrayContaining(["python", "install", "3.12.12", "--no-bin", "--no-config"]),
    );
    expect(calls[1]?.[1]).toEqual(
      expect.arrayContaining(["--managed-python", "--no-python-downloads"]),
    );
    expect(calls[2]?.[1]).toEqual(
      expect.arrayContaining(["sync", "--require-hashes", "--only-binary", ":all:"]),
    );
    expect(JSON.parse(calls[3]?.[2].input ?? "{}")).toMatchObject({
      repository: VOICE_MLX_ENGINE.repository,
      revision: VOICE_MLX_ENGINE.revision,
    });
    expect(calls[4]?.[2].env).toMatchObject({ HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1" });
    expect(calls[4]?.[1][2]).toContain("model.generate");
    expect(onProgress.mock.calls.at(-1)?.[0]).toContain("ready");
    expect(await ensure(location(baseDir))).toEqual(runtime);
    expect(dependencies.runProcess).toHaveBeenCalledTimes(5);
    const requirementPath = calls[2]?.[1].at(-1)!;
    expect(await NodeFSP.readFile(requirementPath, "utf8")).toBe(VOICE_MLX_REQUIREMENTS);
  });

  it("does not publish readiness after a failed inference check and allows retry", async () => {
    const baseDir = await temporaryBase();
    const dependencies = successfulInstaller();
    const original = dependencies.runProcess.getMockImplementation()!;
    dependencies.runProcess.mockImplementation(async (...args) => {
      const result = await original(...args);
      return args[1][2]?.includes("model.generate")
        ? { stdout: '{"verified":false}', stderr: "" }
        : result;
    });
    const ensure = makeVoiceMlxRuntimeManager(dependencies);
    await expect(ensure(location(baseDir))).rejects.toThrow("inference check");
    expect(await resolveVoiceMlxRuntime(location(baseDir))).toBeNull();
    dependencies.runProcess.mockImplementation(original);
    await expect(ensure(location(baseDir))).resolves.toMatchObject({
      engine: VOICE_MLX_ENGINE.key,
    });
  });

  it("rejects a stale model revision or missing artifact even with a readiness marker", async () => {
    const baseDir = await temporaryBase();
    const runtime = await makeVoiceMlxRuntimeManager(successfulInstaller())(location(baseDir));
    const sentinel = NodePath.resolve(runtime.pythonPath, "../../../ready.json");
    const ready = JSON.parse(await NodeFSP.readFile(sentinel, "utf8")) as { modelRevision: string };
    ready.modelRevision = "old-model";
    await NodeFSP.writeFile(sentinel, JSON.stringify(ready));
    expect(await resolveVoiceMlxRuntime(location(baseDir))).toBeNull();
    ready.modelRevision = VOICE_MLX_ENGINE.revision;
    await NodeFSP.writeFile(sentinel, JSON.stringify(ready));
    await NodeFSP.rm(NodePath.join(runtime.modelPath, "model.safetensors"));
    expect(await resolveVoiceMlxRuntime(location(baseDir))).toBeNull();
  });

  it("shares one preparation within a process", async () => {
    const baseDir = await temporaryBase();
    const dependencies = successfulInstaller();
    const ensure = makeVoiceMlxRuntimeManager(dependencies);
    const [first, second] = await Promise.all([
      ensure(location(baseDir)),
      ensure(location(baseDir)),
    ]);
    expect(first).toEqual(second);
    expect(dependencies.acquireUv).toHaveBeenCalledTimes(1);
    expect(dependencies.runProcess).toHaveBeenCalledTimes(5);
  });

  it("replaces an old empty setup lock atomically", async () => {
    const baseDir = await temporaryBase();
    await NodeFSP.mkdir(NodePath.join(baseDir, "voice-runtime", ".setup-lock"), {
      recursive: true,
    });
    await expect(
      makeVoiceMlxRuntimeManager(successfulInstaller())(location(baseDir)),
    ).resolves.toMatchObject({
      engine: VOICE_MLX_ENGINE.key,
    });
  });

  it("does not disturb another live process's setup lock", async () => {
    const baseDir = await temporaryBase();
    const lockPath = NodePath.join(baseDir, "voice-runtime", ".setup-lock");
    await NodeFSP.mkdir(lockPath, { recursive: true });
    await NodeFSP.writeFile(NodePath.join(lockPath, "pid"), String(process.pid));
    const dependencies = successfulInstaller();
    await expect(makeVoiceMlxRuntimeManager(dependencies)(location(baseDir))).rejects.toThrow(
      "Another Solla process",
    );
    expect(await NodeFSP.readFile(NodePath.join(lockPath, "pid"), "utf8")).toBe(
      String(process.pid),
    );
    expect(dependencies.acquireUv).not.toHaveBeenCalled();
  });

  it("recovers the lock left by a process that has exited", async () => {
    const baseDir = await temporaryBase();
    const lockPath = NodePath.join(baseDir, "voice-runtime", ".setup-lock");
    const exited = NodeChildProcess.spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    expect(exited.status).toBe(0);
    await NodeFSP.mkdir(lockPath, { recursive: true });
    await NodeFSP.writeFile(NodePath.join(lockPath, "pid"), String(exited.pid));
    await expect(
      makeVoiceMlxRuntimeManager(successfulInstaller())(location(baseDir)),
    ).resolves.toMatchObject({
      engine: VOICE_MLX_ENGINE.key,
    });
  });

  it("clears an aborted preparation only after its owned operation settles, then accepts retry", async () => {
    const baseDir = await temporaryBase();
    const dependencies = successfulInstaller();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    dependencies.runProcess.mockImplementationOnce(
      (_command, _args, options) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(options.signal.reason), {
            once: true,
          });
          started();
        }),
    );
    const ensure = makeVoiceMlxRuntimeManager(dependencies);
    const cancellation = new AbortController();
    const first = ensure({ ...location(baseDir), signal: cancellation.signal });
    const rejected = expect(first).rejects.toThrow("cancelled");
    await ready;
    cancellation.abort(new Error("cancelled"));
    await rejected;
    expect(await resolveVoiceMlxRuntime(location(baseDir))).toBeNull();
    await expect(ensure(location(baseDir))).resolves.toMatchObject({
      engine: VOICE_MLX_ENGINE.key,
    });
  });

  it("bounds preparation independently of a recording deadline", async () => {
    const baseDir = await temporaryBase();
    vi.useFakeTimers();
    const dependencies = successfulInstaller();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    dependencies.runProcess.mockImplementationOnce(
      (_command, _args, options) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(options.signal.reason), {
            once: true,
          });
          started();
        }),
    );
    const first = makeVoiceMlxRuntimeManager(dependencies)(location(baseDir));
    const rejected = expect(first).rejects.toThrow("timed out");
    await ready;
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    await rejected;
    expect(await resolveVoiceMlxRuntime(location(baseDir))).toBeNull();
  });

  it("rejects an installer with the wrong checksum before executing it", async () => {
    const baseDir = await temporaryBase();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("wrong archive")),
    );
    const runProcess = vi.fn();
    await expect(makeVoiceMlxRuntimeManager({ runProcess })(location(baseDir))).rejects.toThrow(
      "checksum",
    );
    expect(runProcess).not.toHaveBeenCalled();
    expect(await resolveVoiceMlxRuntime(location(baseDir))).toBeNull();
  });
});

describe("setup process ownership", () => {
  // eslint-disable-next-line t3code/no-global-process-runtime -- This integration case spawns actual POSIX processes on the test host.
  it.skipIf(NodeOS.platform() === "win32")(
    "aborts the owned process and its child before settling",
    async () => {
      const baseDir = await temporaryBase();
      const socketPath = NodePath.join(baseDir, "ready.sock");
      const server = NodeNet.createServer();
      const connection = new Promise<NodeNet.Socket>((resolve) =>
        server.once("connection", resolve),
      );
      server.listen(socketPath);
      await new Promise<void>((resolve) => server.once("listening", resolve));
      const cancellation = new AbortController();
      const childSource = 'require("node:net").connect(' + JSON.stringify(socketPath) + ")";
      const parentSource =
        'require("node:child_process").spawn(process.execPath, ["-e", ' +
        JSON.stringify(childSource) +
        '], {stdio: ["ignore", "inherit", "inherit"]});';
      const running = runVoiceMlxSetupProcess(process.execPath, ["-e", parentSource], {
        signal: cancellation.signal,
        env: process.env,
      });
      const rejected = expect(running).rejects.toThrow("cancelled setup");
      try {
        const socket = await connection;
        const descendantClosed = new Promise<void>((resolve) =>
          socket.once("close", () => resolve()),
        );
        cancellation.abort(new Error("cancelled setup"));
        await rejected;
        await descendantClosed;
        expect(socket.destroyed).toBe(true);
        await expect(
          runVoiceMlxSetupProcess(process.execPath, ["-e", 'process.stdout.write("next setup")'], {
            signal: new AbortController().signal,
            env: process.env,
          }),
        ).resolves.toMatchObject({ stdout: "next setup" });
      } finally {
        cancellation.abort();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );
});
