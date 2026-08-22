#!/usr/bin/env node

// @effect-diagnostics nodeBuiltinImport:off
// This release helper is a Node entry point that has to outlive the Electron
// environment it was launched from while it schedules the guarded installer.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import {
  installWindowsReleaseOverSshIfAvailable,
  runWindowsThenMacRelease,
} from "./windows-ssh-release.ts";

interface ProcessRow {
  readonly pid: number;
  readonly parentPid: number;
  readonly command: string;
}

export interface DesktopReleaseContext {
  readonly appPath: string;
  readonly artifactPath: string;
  readonly backendPid: number;
  readonly desktopPid: number;
  readonly healthUrl: string;
  readonly installerPath: string;
  readonly logPath: string;
}

const PRODUCT_NAME = "Solla Code";
const DEFAULT_MAC_APP_PATH = `/Applications/${PRODUCT_NAME}.app`;
const DEFAULT_DESKTOP_HEALTH_URL = "http://127.0.0.1:3773/";

function commandRunsExecutable(command: string, executablePath: string): boolean {
  return command === executablePath || command.startsWith(`${executablePath} `);
}

export function resolveDesktopAppPath(configuredPath: string | undefined): string {
  const value = configuredPath?.trim() || DEFAULT_MAC_APP_PATH;
  if (!NodePath.isAbsolute(value)) {
    throw new Error(`The configured Solla Code application path is not absolute: ${value}`);
  }
  return value;
}

export function resolveDesktopHealthUrl(configuredUrl: string | undefined): string {
  const value = configuredUrl?.trim() || DEFAULT_DESKTOP_HEALTH_URL;
  if (!URL.canParse(value)) {
    throw new Error(`The configured Solla Code health URL is invalid: ${value}`);
  }
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`The configured Solla Code health URL must use HTTP or HTTPS: ${value}`);
  }
  return url.toString();
}

export function resolveConfiguredDesktopPid(configuredPid: string | undefined): number | undefined {
  const value = configuredPid?.trim();
  if (!value) return undefined;
  const pid = Number(value);
  if (!Number.isSafeInteger(pid) || pid <= 1) {
    throw new Error(`The configured Solla Code desktop PID is invalid: ${value}`);
  }
  return pid;
}

export function resolveMacBuildArch(architecture: string): "arm64" | "x64" {
  if (architecture === "arm64" || architecture === "x64") return architecture;
  throw new Error(`Local macOS release installs do not support architecture "${architecture}".`);
}

export function resolveReleaseArtifactPath(input: {
  readonly repoRoot: string;
  readonly version: string;
  readonly architecture: "arm64" | "x64";
}): string {
  return NodePath.join(
    input.repoRoot,
    "release",
    `Solla-Code-${input.version}-${input.architecture}.zip`,
  );
}

export function parseProcessTable(output: string): ReadonlyArray<ProcessRow> {
  const rows: ProcessRow[] = [];
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const parentPid = Number(match[2]);
    const command = match[3]?.trim() ?? "";
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(parentPid) || command.length === 0) {
      continue;
    }
    rows.push({ pid, parentPid, command });
  }
  return rows;
}

export function resolveDesktopBackendPid(input: {
  readonly processes: ReadonlyArray<ProcessRow>;
  readonly desktopPid: number;
  readonly appPath: string;
}): number {
  const expectedExecutable = NodePath.join(input.appPath, "Contents", "MacOS", PRODUCT_NAME);
  const matches = input.processes.filter(
    (process) =>
      process.parentPid === input.desktopPid &&
      commandRunsExecutable(process.command, expectedExecutable) &&
      process.command.includes("apps/server/dist/bin.mjs"),
  );
  if (matches.length !== 1) {
    throw new Error(
      `Expected one Solla Code desktop backend owned by PID ${String(input.desktopPid)}, found ${String(matches.length)}.`,
    );
  }
  return matches[0]!.pid;
}

export function resolveDesktopRuntimePids(input: {
  readonly processes: ReadonlyArray<ProcessRow>;
  readonly appPath: string;
  readonly configuredDesktopPid?: number;
}): { readonly desktopPid: number; readonly backendPid: number } {
  if (input.configuredDesktopPid !== undefined) {
    return {
      desktopPid: input.configuredDesktopPid,
      backendPid: resolveDesktopBackendPid({
        processes: input.processes,
        desktopPid: input.configuredDesktopPid,
        appPath: input.appPath,
      }),
    };
  }

  const expectedExecutable = NodePath.join(input.appPath, "Contents", "MacOS", PRODUCT_NAME);
  const processesByPid = new Map(input.processes.map((process) => [process.pid, process]));
  const matches = input.processes.flatMap((backend) => {
    if (
      !commandRunsExecutable(backend.command, expectedExecutable) ||
      !backend.command.includes("apps/server/dist/bin.mjs")
    ) {
      return [];
    }
    const desktop = processesByPid.get(backend.parentPid);
    if (!desktop || !commandRunsExecutable(desktop.command, expectedExecutable)) return [];
    return [{ desktopPid: desktop.pid, backendPid: backend.pid }];
  });
  if (matches.length !== 1) {
    throw new Error(
      `Expected one running ${input.appPath} desktop/backend pair, found ${String(matches.length)}.`,
    );
  }
  return matches[0]!;
}

export function buildInstallerArgs(context: DesktopReleaseContext): ReadonlyArray<string> {
  return [
    context.installerPath,
    "--mode",
    "install",
    "--artifact",
    context.artifactPath,
    "--target",
    context.appPath,
    "--wait-pid",
    String(context.desktopPid),
    "--wait-backend-pid",
    String(context.backendPid),
    "--health-url",
    context.healthUrl,
    "--log-path",
    context.logPath,
  ];
}

function runCommand(
  command: string,
  args: ReadonlyArray<string>,
  options: NodeChildProcess.SpawnOptions,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(command, args, options);
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `${command} exited ${code === null ? `from signal ${signal ?? "unknown"}` : `with code ${String(code)}`}.`,
        ),
      );
    });
  });
}

function spawnDetached(command: string, args: ReadonlyArray<string>, env: NodeJS.ProcessEnv) {
  return new Promise<void>((resolve, reject) => {
    const child = NodeChildProcess.spawn(command, args, {
      detached: true,
      env,
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

function readPackageVersion(packagePath: string): string {
  const parsed: unknown = JSON.parse(NodeFS.readFileSync(packagePath, "utf8"));
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("version" in parsed) ||
    typeof parsed.version !== "string" ||
    parsed.version.length === 0
  ) {
    throw new Error(`Could not read the release version from ${packagePath}.`);
  }
  return parsed.version;
}

export async function buildAndInstallDesktopRelease(): Promise<void> {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone release entry point has no Effect runtime.
  if (process.platform !== "darwin") {
    throw new Error("Build & Relaunch Release currently supports Solla Code Desktop on macOS.");
  }

  const repoRoot = process.cwd();
  const installerPath = NodePath.join(
    repoRoot,
    "apps",
    "desktop",
    "resources",
    "app-update",
    "install-solla-code-update.sh",
  );
  if (!NodeFS.existsSync(installerPath)) {
    throw new Error(`The guarded Solla Code installer is missing at ${installerPath}.`);
  }

  const appPath = resolveDesktopAppPath(process.env.T3CODE_DESKTOP_APP_PATH);
  const appExecutable = NodePath.join(appPath, "Contents", "MacOS", PRODUCT_NAME);
  if (!NodeFS.existsSync(appExecutable)) {
    throw new Error(`The installed Solla Code application is missing at ${appPath}.`);
  }
  const configuredDesktopPid = resolveConfiguredDesktopPid(process.env.T3CODE_DESKTOP_ROOT_PID);
  const healthUrl = resolveDesktopHealthUrl(process.env.T3CODE_DESKTOP_UPDATE_HEALTH_URL);
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone release entry point has no Effect runtime.
  const architecture = resolveMacBuildArch(process.arch);
  const version = readPackageVersion(NodePath.join(repoRoot, "apps", "server", "package.json"));
  const artifactPath = resolveReleaseArtifactPath({ repoRoot, version, architecture });
  const logPath = NodePath.join(repoRoot, "release", "desktop-release-install.log");

  const buildEnvironment = { ...process.env };
  delete buildEnvironment.ELECTRON_RUN_AS_NODE;
  buildEnvironment.PATH = [NodePath.join(repoRoot, "node_modules", ".bin"), process.env.PATH]
    .filter((entry): entry is string => Boolean(entry))
    .join(NodePath.delimiter);

  const readDesktopRuntime = () => {
    const processTable = NodeChildProcess.execFileSync("/bin/ps", ["-axo", "pid=,ppid=,command="], {
      encoding: "utf8",
    });
    return resolveDesktopRuntimePids({
      processes: parseProcessTable(processTable),
      appPath,
      ...(configuredDesktopPid !== undefined ? { configuredDesktopPid } : {}),
    });
  };
  const initialRuntime = readDesktopRuntime();

  const artifactBuildScript = NodePath.join(repoRoot, "scripts", "build-desktop-artifact.ts");
  await runWindowsThenMacRelease({
    windows: () =>
      installWindowsReleaseOverSshIfAvailable({
        artifactBuildScript,
        buildEnvironment,
        repoRoot,
        version,
      }),
    onWindowsFailure: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(
        `Windows release failed; continuing with a full macOS build before reporting the failure.\n${message}\n`,
      );
    },
    mac: async (windowsBuilt) => {
      process.stdout.write(
        `Building Solla Code ${version} for macOS ${architecture} in release mode (installed app PID ${String(initialRuntime.desktopPid)})...\n`,
      );
      await runCommand(
        process.execPath,
        [
          artifactBuildScript,
          "--platform",
          "mac",
          "--target",
          "zip",
          "--arch",
          architecture,
          "--output-dir",
          NodePath.dirname(artifactPath),
          // The Windows package already built the shared server, web, and
          // desktop output from this exact working tree. Reuse it for the Mac
          // package instead of compiling the same platform-neutral inputs twice.
          ...(windowsBuilt ? ["--skip-build"] : []),
        ],
        { cwd: repoRoot, env: buildEnvironment, stdio: "inherit" },
      );
      if (!NodeFS.existsSync(artifactPath)) {
        throw new Error(`The release build completed without producing ${artifactPath}.`);
      }

      process.stdout.write("Verifying the release bundle before installation...\n");
      await runCommand(
        "/bin/zsh",
        [installerPath, "--mode", "preflight", "--artifact", artifactPath, "--target", appPath],
        { cwd: repoRoot, env: buildEnvironment, stdio: "inherit" },
      );

      const { backendPid, desktopPid } = readDesktopRuntime();
      const context: DesktopReleaseContext = {
        appPath,
        artifactPath,
        backendPid,
        desktopPid,
        healthUrl,
        installerPath,
        logPath,
      };

      await spawnDetached("/bin/zsh", buildInstallerArgs(context), buildEnvironment);
      process.stdout.write(
        `Release install scheduled. Solla Code will close, install ${NodePath.basename(artifactPath)}, and relaunch with --auto-resume.`,
      );
      process.stdout.write(`\nInstaller log: ${logPath}\n`);
    },
  });
}

const isMain =
  process.argv[1] !== undefined &&
  NodePath.resolve(process.argv[1]) === NodePath.resolve(NodeURL.fileURLToPath(import.meta.url));

if (isMain) {
  void buildAndInstallDesktopRelease().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
