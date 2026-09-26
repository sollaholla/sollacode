// @effect-diagnostics nodeBuiltinImport:off - A host-owned, optional local speech runtime.
// @effect-diagnostics globalTimers:off - Setup has a separate bounded process deadline.
// @effect-diagnostics globalFetch:off - Installer download shares the setup AbortSignal.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import { VOICE_MLX_REQUIREMENTS } from "./voiceNoteMlxRequirements.ts";

const UV_VERSION = "0.9.28";
const UV_ARCHIVE_SHA256 = "12163fe09eb292d3ad1ea0f132a84485c902e2ff360d57562bf676e6615fcba0";
const UV_BINARY_SHA256 = "ff9abd2affc410ed2a51f468d19fb281fa02d9ca1bd5c74633c2ceb71e97f6c2";
const PYTHON_VERSION = "3.12.12";
const SETUP_TIMEOUT_MS = 15 * 60_000;
const REQUIREMENTS_SHA256 = NodeCrypto.createHash("sha256")
  .update(VOICE_MLX_REQUIREMENTS)
  .digest("hex");

/** Only reviewed local engines belong here; callers cannot supply Python code or model URLs. */
export const VOICE_MLX_ENGINE = {
  key: "parakeet-tdt-0.6b-v3",
  repository: "mlx-community/parakeet-tdt-0.6b-v3",
  revision: "ed2b7e8c15f9aaa0b5772e2efb986255eaef7e15",
} as const;

export interface VoiceMlxRuntime {
  readonly pythonPath: string;
  readonly modelPath: string;
  readonly engine: typeof VOICE_MLX_ENGINE.key;
  readonly runtimeKey: string;
}

interface RuntimeLocation {
  readonly baseDir: string;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
}

interface SetupInput extends RuntimeLocation {
  readonly signal?: AbortSignal;
  readonly onProgress?: (phase: string) => void;
}

export function isVoiceMlxSupported(
  // eslint-disable-next-line t3code/no-global-process-runtime -- Standalone installer default; server callers pass the host platform.
  platform: NodeJS.Platform = process.platform,
  // eslint-disable-next-line t3code/no-global-process-runtime -- Standalone installer default; server callers pass the host architecture.
  arch: string = process.arch,
) {
  return platform === "darwin" && arch === "arm64";
}

function runtimePaths(baseDir: string) {
  if (!NodePath.isAbsolute(baseDir))
    throw new Error("The local speech runtime needs an absolute Solla base directory.");
  const root = NodePath.join(baseDir, "voice-runtime");
  const runtimeKey =
    "parakeet-mlx-0.5.2-python-" + PYTHON_VERSION + "-" + REQUIREMENTS_SHA256.slice(0, 16);
  const versionDir = NodePath.join(root, runtimeKey);
  return {
    root,
    versionDir,
    pythonInstallDir: NodePath.join(root, "python"),
    venvPath: NodePath.join(versionDir, "venv"),
    sentinelPath: NodePath.join(versionDir, "ready.json"),
    lockPath: NodePath.join(root, ".setup-lock"),
    runtime: {
      pythonPath: NodePath.join(versionDir, "venv", "bin", "python"),
      modelPath: NodePath.join(
        root,
        "models",
        VOICE_MLX_ENGINE.key + "-" + VOICE_MLX_ENGINE.revision,
      ),
      engine: VOICE_MLX_ENGINE.key,
      runtimeKey,
    } satisfies VoiceMlxRuntime,
  };
}

async function nonemptyFile(path: string) {
  return NodeFSP.stat(path).then(
    (stat) => stat.isFile() && stat.size > 0,
    () => false,
  );
}

/** Fast, read-only readiness check. This never starts setup or downloads on a recording's deadline. */
export async function resolveVoiceMlxRuntime(
  input: RuntimeLocation,
): Promise<VoiceMlxRuntime | null> {
  if (!isVoiceMlxSupported(input.platform, input.arch)) return null;
  const paths = runtimePaths(input.baseDir);
  try {
    const ready: unknown = JSON.parse(await NodeFSP.readFile(paths.sentinelPath, "utf8"));
    if (
      typeof ready !== "object" ||
      ready === null ||
      !("runtimeKey" in ready) ||
      ready.runtimeKey !== paths.runtime.runtimeKey ||
      !("requirementsSha256" in ready) ||
      ready.requirementsSha256 !== REQUIREMENTS_SHA256 ||
      !("modelRevision" in ready) ||
      ready.modelRevision !== VOICE_MLX_ENGINE.revision ||
      !("verified" in ready) ||
      ready.verified !== true
    )
      return null;
    const files = await Promise.all([
      nonemptyFile(paths.runtime.pythonPath),
      nonemptyFile(NodePath.join(paths.runtime.modelPath, "config.json")),
      nonemptyFile(NodePath.join(paths.runtime.modelPath, "model.safetensors")),
    ]);
    return files.every(Boolean) ? paths.runtime : null;
  } catch {
    return null;
  }
}

interface SetupProcessInput {
  readonly signal: AbortSignal;
  readonly env: NodeJS.ProcessEnv;
  readonly input?: string;
}

/** All setup commands run in an owned process group, including uv's interpreter probes. */
export function runVoiceMlxSetupProcess(
  command: string,
  args: readonly string[],
  options: SetupProcessInput,
) {
  options.signal.throwIfAborted();
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = NodeChildProcess.spawn(command, [...args], {
      detached: true,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let failure: Error | undefined;
    const terminate = () => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (cause) {
        if (!(cause instanceof Error && "code" in cause && cause.code === "ESRCH")) {
          failure ??= new Error("The local speech setup process could not be stopped.");
        }
      }
    };
    const collect = (chunk: Buffer, output: "stdout" | "stderr") => {
      if (output === "stdout") stdout += chunk.toString();
      else stderr += chunk.toString();
      if (stdout.length + stderr.length > 1024 * 1024) {
        failure = new Error("The local speech setup returned too much diagnostic output.");
        terminate();
      }
    };
    child.stdout.on("data", (chunk: Buffer) => collect(chunk, "stdout"));
    child.stderr.on("data", (chunk: Buffer) => collect(chunk, "stderr"));
    child.stdin.on("error", () => undefined);
    child.once("error", (cause) => {
      failure = cause;
    });
    options.signal.addEventListener("abort", terminate, { once: true });
    if (options.signal.aborted) terminate();
    child.once("close", (code) => {
      options.signal.removeEventListener("abort", terminate);
      if (options.signal.aborted) reject(options.signal.reason);
      else if (failure) reject(failure);
      else if (code !== 0)
        reject(
          new Error(
            "Local speech setup failed (exit " +
              (code ?? "unknown") +
              "). " +
              stderr.trim().slice(-2000),
          ),
        );
      else resolve({ stdout, stderr });
    });
    child.stdin.end(options.input);
  });
}

function setupEnvironment(root: string): NodeJS.ProcessEnv {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/^(?:UV_|PIP_|PYTHON|HF_|HUGGING_FACE_|VIRTUAL_ENV$)/u.test(key),
    ),
  );
  return {
    ...environment,
    UV_PYTHON_INSTALL_DIR: NodePath.join(root, "python"),
    UV_CACHE_DIR: NodePath.join(root, "downloads"),
    UV_NO_PROGRESS: "1",
    HF_HOME: NodePath.join(root, "huggingface"),
    HF_HUB_DISABLE_TELEMETRY: "1",
    PYTHONNOUSERSITE: "1",
    TOKENIZERS_PARALLELISM: "false",
  };
}

async function acquireSetupLock(root: string, lockPath: string) {
  // Publish a directory containing its owner atomically. A crash cannot leave a
  // visible empty lock between mkdir and writing the PID.
  const candidate = await NodeFSP.mkdtemp(NodePath.join(root, ".setup-owner-"));
  try {
    await NodeFSP.writeFile(NodePath.join(candidate, "pid"), String(process.pid));
    try {
      await NodeFSP.rename(candidate, lockPath);
    } catch (cause) {
      if (
        !(
          cause instanceof Error &&
          "code" in cause &&
          (cause.code === "EEXIST" || cause.code === "ENOTEMPTY")
        )
      )
        throw cause;
      const owner = Number(
        await NodeFSP.readFile(NodePath.join(lockPath, "pid"), "utf8").catch(() => ""),
      );
      let alive = true;
      if (Number.isSafeInteger(owner) && owner > 0) {
        try {
          process.kill(owner, 0);
        } catch (error) {
          if (error instanceof Error && "code" in error && error.code === "ESRCH") alive = false;
        }
      }
      if (alive)
        throw new Error(
          "Another Solla process is preparing the local speech model. Try again after setup completes.",
          { cause },
        );
      await NodeFSP.rm(lockPath, { recursive: true, force: true });
      await NodeFSP.rename(candidate, lockPath);
    }
  } finally {
    await NodeFSP.rm(candidate, { recursive: true, force: true });
  }
}

async function acquireUv(root: string, signal: AbortSignal): Promise<string> {
  const binDir = NodePath.join(root, "bin");
  const executable = NodePath.join(binDir, "uv-" + UV_VERSION);
  const sha256 = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
  const existing = await NodeFSP.readFile(executable).catch(() => null);
  if (existing && sha256(existing) === UV_BINARY_SHA256) return executable;
  await NodeFSP.mkdir(binDir, { recursive: true });
  const temporary = await NodeFSP.mkdtemp(NodePath.join(binDir, ".download-"));
  try {
    const response = await fetch(
      "https://github.com/astral-sh/uv/releases/download/" +
        UV_VERSION +
        "/uv-aarch64-apple-darwin.tar.gz",
      { signal },
    );
    if (!response.ok || !response.body)
      throw new Error("The local speech installer could not be downloaded.");
    const chunks: Uint8Array[] = [];
    let length = 0;
    for await (const chunk of response.body) {
      length += chunk.byteLength;
      if (length > 64 * 1024 * 1024)
        throw new Error("The local speech installer download is too large.");
      chunks.push(chunk);
    }
    const archive = Buffer.concat(chunks);
    if (sha256(archive) !== UV_ARCHIVE_SHA256)
      throw new Error("The local speech installer checksum did not match.");
    const archivePath = NodePath.join(temporary, "uv.tar.gz");
    await NodeFSP.writeFile(archivePath, archive);
    await runVoiceMlxSetupProcess(
      "/usr/bin/tar",
      ["-xzf", archivePath, "-C", temporary, "--strip-components=1", "uv-aarch64-apple-darwin/uv"],
      { signal, env: setupEnvironment(root) },
    );
    const extracted = NodePath.join(temporary, "uv");
    if (sha256(await NodeFSP.readFile(extracted)) !== UV_BINARY_SHA256)
      throw new Error("The local speech installer executable checksum did not match.");
    await NodeFSP.chmod(extracted, 0o700);
    await NodeFSP.rename(extracted, executable);
    return executable;
  } finally {
    await NodeFSP.rm(temporary, { recursive: true, force: true });
  }
}

const DOWNLOAD_MODEL_SOURCE = [
  "import json, sys",
  "from huggingface_hub import snapshot_download",
  "request = json.load(sys.stdin)",
  'snapshot_download(repo_id=request["repository"], revision=request["revision"], local_dir=request["modelPath"], allow_patterns=["config.json", "model.safetensors"], token=False)',
  'print(json.dumps({"downloaded": True}))',
].join("\n");

const VERIFY_MODEL_SOURCE = [
  "import json, sys",
  "import numpy as np",
  "import mlx.core as mx",
  "from parakeet_mlx import from_pretrained",
  "from parakeet_mlx.audio import get_logmel",
  "request = json.load(sys.stdin)",
  'model = from_pretrained(request["modelPath"])',
  "audio = mx.array(np.zeros(16000, dtype=np.float32), dtype=mx.float32)",
  "result = model.generate(get_logmel(audio, model.preprocessor_config))[0]",
  "if not isinstance(result.text, str):",
  '    raise RuntimeError("The local speech inference probe returned an invalid result")',
  'print(json.dumps({"verified": True}))',
].join("\n");

/** Dependency injection keeps installation tests off the network and outside the user's Solla home. */
export function makeVoiceMlxRuntimeManager(
  dependencies: {
    readonly runProcess?: typeof runVoiceMlxSetupProcess;
    readonly acquireUv?: typeof acquireUv;
  } = {},
) {
  const active = new Map<string, Promise<VoiceMlxRuntime>>();
  const runProcess = dependencies.runProcess ?? runVoiceMlxSetupProcess;
  return async function ensure(input: SetupInput): Promise<VoiceMlxRuntime> {
    if (!isVoiceMlxSupported(input.platform, input.arch))
      throw new Error("The accelerated local speech model requires an Apple Silicon Mac.");
    input.signal?.throwIfAborted();
    const paths = runtimePaths(input.baseDir);
    const existing = active.get(paths.root);
    if (existing) return existing;
    const cancellation = new AbortController();
    const abort = () => cancellation.abort(input.signal?.reason);
    input.signal?.addEventListener("abort", abort, { once: true });
    if (input.signal?.aborted) abort();
    const timeout = setTimeout(
      () =>
        cancellation.abort(
          new Error(
            "Preparing the local speech model timed out. It can be retried without losing your recording.",
          ),
        ),
      SETUP_TIMEOUT_MS,
    );
    const run = (async () => {
      const ready = await resolveVoiceMlxRuntime(input);
      cancellation.signal.throwIfAborted();
      if (ready) return ready;
      await NodeFSP.mkdir(paths.root, { recursive: true });
      await acquireSetupLock(paths.root, paths.lockPath);
      try {
        cancellation.signal.throwIfAborted();
        input.onProgress?.("Preparing the local speech installer");
        const uv = await (dependencies.acquireUv ?? acquireUv)(paths.root, cancellation.signal);
        const environment = setupEnvironment(paths.root);
        const command = (executable: string, args: string[], inputText?: string, offline = false) =>
          runProcess(executable, args, {
            signal: cancellation.signal,
            env: offline
              ? { ...environment, HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1" }
              : environment,
            ...(inputText === undefined ? {} : { input: inputText }),
          });
        input.onProgress?.("Installing the private Python speech runtime");
        await command(uv, [
          "python",
          "install",
          PYTHON_VERSION,
          "--install-dir",
          paths.pythonInstallDir,
          "--no-bin",
          "--no-config",
        ]);
        await NodeFSP.mkdir(paths.versionDir, { recursive: true });
        await NodeFSP.rm(paths.sentinelPath, { force: true });
        await command(uv, [
          "venv",
          "--python",
          PYTHON_VERSION,
          "--managed-python",
          "--no-python-downloads",
          "--no-config",
          "--allow-existing",
          paths.venvPath,
        ]);
        const requirementsPath = NodePath.join(paths.versionDir, "requirements.lock");
        await NodeFSP.writeFile(requirementsPath, VOICE_MLX_REQUIREMENTS);
        input.onProgress?.("Installing the local speech engine");
        await command(uv, [
          "pip",
          "sync",
          "--python",
          paths.runtime.pythonPath,
          "--require-hashes",
          "--only-binary",
          ":all:",
          "--no-config",
          "--default-index",
          "https://pypi.org/simple",
          requirementsPath,
        ]);
        input.onProgress?.("Downloading the high quality speech model (about 2.3 GB)");
        await NodeFSP.mkdir(paths.runtime.modelPath, { recursive: true });
        await command(
          paths.runtime.pythonPath,
          ["-I", "-c", DOWNLOAD_MODEL_SOURCE],
          JSON.stringify({ ...VOICE_MLX_ENGINE, modelPath: paths.runtime.modelPath }),
        );
        input.onProgress?.("Verifying local speech recognition");
        const probe = await command(
          paths.runtime.pythonPath,
          ["-I", "-c", VERIFY_MODEL_SOURCE],
          JSON.stringify({ modelPath: paths.runtime.modelPath }),
          true,
        );
        const result: unknown = JSON.parse(probe.stdout.trim());
        if (
          typeof result !== "object" ||
          result === null ||
          !("verified" in result) ||
          result.verified !== true
        )
          throw new Error("The local speech model did not pass its inference check.");
        cancellation.signal.throwIfAborted();
        const sentinel = JSON.stringify({
          runtimeKey: paths.runtime.runtimeKey,
          requirementsSha256: REQUIREMENTS_SHA256,
          modelRevision: VOICE_MLX_ENGINE.revision,
          verified: true,
        });
        const temporarySentinel = paths.sentinelPath + "." + NodeCrypto.randomUUID() + ".tmp";
        await NodeFSP.writeFile(temporarySentinel, sentinel);
        await NodeFSP.rename(temporarySentinel, paths.sentinelPath);
        const installed = await resolveVoiceMlxRuntime(input);
        if (!installed) {
          await NodeFSP.rm(paths.sentinelPath, { force: true });
          throw new Error("The local speech installation is incomplete.");
        }
        input.onProgress?.("High quality local speech recognition is ready");
        return installed;
      } finally {
        await NodeFSP.rm(paths.lockPath, { recursive: true, force: true });
      }
    })();
    active.set(paths.root, run);
    try {
      return await run;
    } finally {
      clearTimeout(timeout);
      input.signal?.removeEventListener("abort", abort);
      if (active.get(paths.root) === run) active.delete(paths.root);
    }
  };
}

/** Preparation is an explicit host operation, independent of individual voice-note sends. */
export const ensureVoiceMlxRuntime = makeVoiceMlxRuntimeManager();
