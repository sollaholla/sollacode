// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalTimers:off globalDate:off globalFetch:off - Standalone release check under plain node; it drives real processes with real timeouts.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

/**
 * Proves a packaged desktop artifact works the way users receive it, on the
 * machine that built it. Run after `dist:desktop:artifact`:
 *
 *   node scripts/smoke-packaged-desktop.ts --platform mac|linux|win --artifacts release-publish
 *
 * 1. Unpacks the artifact itself: the mac zip, the Linux AppImage, or the
 *    Windows installer run silently.
 * 2. Runs the shipped server on the shipped Electron runtime: native modules,
 *    the database migrations, and the bundled web client all load.
 * 3. Spawns a shell through the shipped node-pty, which is what terminals use.
 * 4. Launches the whole app with its own home directory and waits for the
 *    backend it starts to answer.
 */

export type SmokePlatform = "mac" | "linux" | "win";

const ARTIFACT_EXTENSION: Record<SmokePlatform, string> = {
  mac: ".zip",
  linux: ".AppImage",
  win: ".exe",
};

const SERVER_READY_TIMEOUT_MS = 180_000;
const DESKTOP_READY_TIMEOUT_MS = 240_000;
const PTY_MARKER = "solla-pty-ok";

export function isSmokePlatform(value: string | undefined): value is SmokePlatform {
  return value === "mac" || value === "linux" || value === "win";
}

/** The one artifact of this platform's kind, ignoring blockmaps and the like. */
export function pickArtifact(platform: SmokePlatform, fileNames: ReadonlyArray<string>): string {
  const extension = ARTIFACT_EXTENSION[platform];
  const matches = fileNames.filter((name) => name.endsWith(extension));
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one ${extension} artifact, found ${matches.length}: ${matches.join(", ") || "none"}.`,
    );
  }
  return matches[0]!;
}

interface InstalledApp {
  readonly executable: string;
  readonly resourcesDir: string;
}

function run(command: string, args: ReadonlyArray<string>, options: { cwd?: string } = {}) {
  const result = NodeChildProcess.spawnSync(command, args, {
    cwd: options.cwd,
    stdio: "inherit",
    timeout: 600_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status ?? result.signal}.`);
  }
}

function onlyEntry(directory: string, predicate: (name: string) => boolean): string {
  const matches = NodeFS.readdirSync(directory).filter(predicate);
  if (matches.length !== 1) {
    throw new Error(`Expected one match in ${directory}, found: ${matches.join(", ") || "none"}.`);
  }
  return NodePath.join(directory, matches[0]!);
}

function installMac(artifact: string, workDir: string): InstalledApp {
  const target = NodePath.join(workDir, "app");
  run("ditto", ["-x", "-k", artifact, target]);
  const bundle = onlyEntry(target, (name) => name.endsWith(".app"));
  const macOSDir = NodePath.join(bundle, "Contents", "MacOS");
  return {
    executable: onlyEntry(macOSDir, () => true),
    resourcesDir: NodePath.join(bundle, "Contents", "Resources"),
  };
}

function installLinux(artifact: string, workDir: string): InstalledApp {
  NodeFS.chmodSync(artifact, 0o755);
  run(artifact, ["--appimage-extract"], { cwd: workDir });
  const root = NodePath.join(workDir, "squashfs-root");
  return {
    executable: NodePath.join(root, "solla-code"),
    resourcesDir: NodePath.join(root, "resources"),
  };
}

function installWindows(artifact: string, workDir: string): InstalledApp {
  // NSIS wants `/D=` last and unquoted, so the directory must not contain spaces.
  const target = NodePath.join(workDir, "installed");
  if (target.includes(" ")) throw new Error(`Install path must not contain spaces: ${target}`);
  run(artifact, ["/S", `/D=${target}`]);
  // One-click installers may ignore /D and use the per-user default.
  const localAppData =
    process.env.LOCALAPPDATA ?? NodePath.join(NodeOS.homedir(), "AppData", "Local");
  const candidates = [target, NodePath.join(localAppData, "Programs", "solla-code")];
  for (const directory of candidates) {
    const executable = NodePath.join(directory, "Solla Code.exe");
    if (NodeFS.existsSync(executable)) {
      return { executable, resourcesDir: NodePath.join(directory, "resources") };
    }
  }
  throw new Error(
    `The installer finished but no Solla Code.exe exists in ${candidates.join(" or ")}.`,
  );
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = NodeNet.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/** Keeps the last output of a child for the failure message. */
function captureTail(child: NodeChildProcess.ChildProcess): () => string {
  let tail = "";
  const append = (chunk: Buffer) => {
    tail = (tail + chunk.toString("utf8")).slice(-8_000);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  return () => tail;
}

async function waitFor<T>(
  label: string,
  timeoutMs: number,
  attempt: () => Promise<T | undefined>,
  exited: () => string | undefined,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    const exit = exited();
    if (exit !== undefined) throw new Error(`${label}: the process exited early (${exit}).`);
    const value = await attempt().catch((error: unknown) => {
      lastError = error;
      return undefined;
    });
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  const detail =
    lastError instanceof Error
      ? `${lastError.message}${lastError.cause ? ` (${String(lastError.cause)})` : ""}`
      : "no answer";
  throw new Error(`${label}: not ready after ${timeoutMs / 1000}s; last attempt: ${detail}.`);
}

async function fetchEnvironment(origin: string): Promise<Record<string, unknown> | undefined> {
  const response = await fetch(`${origin}/.well-known/t3/environment`, {
    signal: AbortSignal.timeout(5_000),
  });
  if (response.status !== 200) return undefined;
  const body = (await response.json()) as unknown;
  return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : undefined;
}

function watchExit(child: NodeChildProcess.ChildProcess): () => string | undefined {
  let exit: string | undefined;
  child.once("exit", (code, signal) => {
    exit = `code ${code ?? "none"}, signal ${signal ?? "none"}`;
  });
  child.once("error", (error) => {
    exit = error.message;
  });
  return () => exit;
}

/** Stops a child and everything it started, by the pid captured at spawn. */
function stopTree(child: NodeChildProcess.ChildProcess, platform: SmokePlatform): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (platform === "win") {
    NodeChildProcess.spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
    });
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

/**
 * A fresh home for everything the app starts: no provider CLIs, sessions, or
 * credentials from whatever machine runs the smoke test leak into it (and a
 * developer's large provider history cannot slow startup).
 */
function isolatedEnv(workDir: string, name: string): NodeJS.ProcessEnv {
  const home = NodePath.join(workDir, `${name}-user-home`);
  NodeFS.mkdirSync(home, { recursive: true });
  return { ...process.env, HOME: home, ELECTRON_RUN_AS_NODE: undefined };
}

async function smokeServer(app: InstalledApp, platform: SmokePlatform, workDir: string) {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const entry = NodePath.join(app.resourcesDir, "app.asar", "apps", "server", "dist", "bin.mjs");
  const child = NodeChildProcess.spawn(
    app.executable,
    [
      entry,
      "--port",
      String(port),
      "--host",
      "127.0.0.1",
      "--base-dir",
      NodePath.join(workDir, "server-home"),
      "--no-browser",
    ],
    {
      env: { ...isolatedEnv(workDir, "server"), ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      detached: platform !== "win",
    },
  );
  const tail = captureTail(child);
  const exited = watchExit(child);
  try {
    const environment = await waitFor(
      "packaged server",
      SERVER_READY_TIMEOUT_MS,
      () => fetchEnvironment(origin),
      exited,
    );
    console.log(`server answered: ${JSON.stringify(environment).slice(0, 300)}`);
    const index = await fetch(`${origin}/`, { signal: AbortSignal.timeout(15_000) });
    const html = await index.text();
    if (index.status !== 200 || !html.includes("<script")) {
      throw new Error(`The bundled web client did not load (HTTP ${index.status}).`);
    }
    console.log("server serves the web client");
  } catch (error) {
    console.error(tail());
    throw error;
  } finally {
    stopTree(child, platform);
  }
}

function smokePty(app: InstalledApp, platform: SmokePlatform, workDir: string) {
  const script = NodePath.join(workDir, "pty-smoke.cjs");
  const ptyModule = NodePath.join(app.resourcesDir, "app.asar", "node_modules", "node-pty");
  const [shell, args] =
    platform === "win"
      ? ["cmd.exe", ["/c", `echo ${PTY_MARKER}`]]
      : ["/bin/sh", ["-c", `echo ${PTY_MARKER}`]];
  NodeFS.writeFileSync(
    script,
    [
      `const pty = require(${JSON.stringify(ptyModule)});`,
      `const term = pty.spawn(${JSON.stringify(shell)}, ${JSON.stringify(args)}, { cols: 80, rows: 24 });`,
      `let out = "";`,
      `term.onData((data) => { out += data; });`,
      `term.onExit(() => { process.stdout.write(out); process.exit(out.includes(${JSON.stringify(PTY_MARKER)}) ? 0 : 3); });`,
      `setTimeout(() => { process.stdout.write("timed out: " + out); process.exit(4); }, 30000);`,
    ].join("\n"),
  );
  const result = NodeChildProcess.spawnSync(app.executable, [script], {
    env: { ...isolatedEnv(workDir, "pty"), ELECTRON_RUN_AS_NODE: "1" },
    encoding: "utf8",
    timeout: 60_000,
  });
  if (result.status !== 0) {
    throw new Error(
      `The packaged node-pty could not run a shell (exit ${result.status ?? result.signal}).\n${result.stdout}\n${result.stderr}`,
    );
  }
  console.log("node-pty spawned a shell");
}

async function smokeDesktop(app: InstalledApp, platform: SmokePlatform, workDir: string) {
  const home = NodePath.join(workDir, "desktop-home");
  const runtimeState = NodePath.join(home, "userdata", "server-runtime.json");
  const [command, args] =
    platform === "linux"
      ? // No display on the runner, and Ubuntu blocks the setuid sandbox of an extracted AppImage.
        ["xvfb-run", ["-a", app.executable, "--no-sandbox"]]
      : [app.executable, []];
  // On macOS the app keeps the real home: its first act after "ready" is a
  // synchronous safeStorage (Keychain) write, and with a made-up HOME there is
  // no login keychain, so the main thread waits on a prompt nobody can answer.
  // T3CODE_HOME still keeps Solla's own state isolated.
  const env =
    platform === "mac"
      ? { ...process.env, ELECTRON_RUN_AS_NODE: undefined, T3CODE_HOME: home }
      : { ...isolatedEnv(workDir, "desktop"), T3CODE_HOME: home };
  const child = NodeChildProcess.spawn(command, args, {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: platform !== "win",
  });
  const tail = captureTail(child);
  const exited = watchExit(child);
  try {
    const environment = await waitFor(
      "desktop app backend",
      DESKTOP_READY_TIMEOUT_MS,
      async () => {
        if (!NodeFS.existsSync(runtimeState)) return undefined;
        const state = JSON.parse(NodeFS.readFileSync(runtimeState, "utf8")) as { port?: number };
        return typeof state.port === "number"
          ? fetchEnvironment(`http://127.0.0.1:${state.port}`)
          : undefined;
      },
      exited,
    );
    console.log(`desktop app started its backend: ${JSON.stringify(environment).slice(0, 300)}`);
  } catch (error) {
    console.error(tail());
    console.error(desktopLogTail(NodePath.join(home, "userdata", "logs")));
    throw error;
  } finally {
    stopTree(child, platform);
  }
}

/** The end of the app's own trace, which says where startup stopped. */
function desktopLogTail(logsDir: string): string {
  const trace = NodePath.join(logsDir, "desktop.trace.ndjson");
  if (!NodeFS.existsSync(trace)) return `(no desktop trace at ${trace})`;
  return NodeFS.readFileSync(trace, "utf8")
    .trim()
    .split("\n")
    .slice(-25)
    .map((line) => line.slice(0, 400))
    .join("\n");
}

async function main() {
  const { values } = NodeUtil.parseArgs({
    options: {
      platform: { type: "string" },
      artifacts: { type: "string", default: "release-publish" },
      "skip-desktop": { type: "boolean", default: false },
    },
  });
  if (!isSmokePlatform(values.platform)) {
    throw new Error("--platform must be mac, linux, or win.");
  }
  const platform = values.platform;
  const artifactsDir = NodePath.resolve(values.artifacts);
  const artifact = NodePath.join(
    artifactsDir,
    pickArtifact(platform, NodeFS.readdirSync(artifactsDir)),
  );
  // Short and space-free: NSIS and the unix socket paths both care.
  const workDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "solla-smoke-"));
  console.log(`smoke-testing ${artifact} in ${workDir}`);

  const install = { mac: installMac, linux: installLinux, win: installWindows }[platform];
  const app = install(artifact, workDir);
  console.log(`installed: ${app.executable}`);

  await smokeServer(app, platform, workDir);
  smokePty(app, platform, workDir);
  if (!values["skip-desktop"]) await smokeDesktop(app, platform, workDir);
  console.log("packaged app smoke test passed");
}

if (import.meta.main) {
  main().then(
    () => process.exit(0),
    (error: unknown) => {
      console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
      process.exit(1);
    },
  );
}
