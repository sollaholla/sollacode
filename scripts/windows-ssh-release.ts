// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Standalone release orchestration needs hard subprocess timeouts.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTimers from "node:timers";

interface CommandResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

interface DockerRuntime {
  readonly args: ReadonlyArray<string>;
  readonly cleanUp: () => Promise<void>;
}

interface WindowsSshProbe {
  readonly computerName: string;
  readonly destination: string;
  readonly host: string;
}

interface TailscalePeer {
  readonly DNSName?: unknown;
  readonly OS?: unknown;
  readonly Online?: unknown;
  readonly TailscaleIPs?: unknown;
}

export interface WindowsReleaseBuildContext {
  readonly artifactBuildScript: string;
  readonly buildEnvironment: NodeJS.ProcessEnv;
  readonly repoRoot: string;
  readonly version: string;
}

const WINDOWS_ARCH = "x64";
const WINDOWS_INSTALLER_SCRIPT = "windows-release-install.ps1";
const SSH_OPTIONS = [
  "-o",
  "BatchMode=yes",
  "-o",
  "ConnectTimeout=4",
  "-o",
  "ConnectionAttempts=1",
  "-o",
  "StrictHostKeyChecking=accept-new",
  "-o",
  "LogLevel=ERROR",
] as const;
const WINDOWS_PROBE_COMMAND =
  'powershell -NoProfile -NonInteractive -Command "$result = [ordered]@{ Platform = [System.Environment]::OSVersion.Platform.ToString(); ComputerName = $env:COMPUTERNAME; UserProfile = $env:USERPROFILE }; $result | ConvertTo-Json -Compress"';

function runCommandCapture(
  command: string,
  args: ReadonlyArray<string>,
  options: NodeChildProcess.SpawnOptions = {},
  timeoutMs?: number,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(command, args, {
      ...options,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout =
      timeoutMs === undefined
        ? undefined
        : NodeTimers.setTimeout(() => {
            if (settled) return;
            child.kill("SIGTERM");
            settled = true;
            reject(new Error(`${command} timed out after ${String(timeoutMs)}ms.`));
          }, timeoutMs);
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      if (timeout) NodeTimers.clearTimeout(timeout);
      callback();
    };
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error) => finish(() => reject(error)));
    child.once("exit", (code) => {
      finish(() => resolve({ exitCode: code ?? 1, stdout, stderr }));
    });
  });
}

function runCommand(
  command: string,
  args: ReadonlyArray<string>,
  options: NodeChildProcess.SpawnOptions = {},
  timeoutMs?: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(command, args, {
      ...options,
      stdio: "inherit",
    });
    let settled = false;
    const timeout =
      timeoutMs === undefined
        ? undefined
        : NodeTimers.setTimeout(() => {
            if (settled) return;
            child.kill("SIGTERM");
            settled = true;
            reject(new Error(`${command} timed out after ${String(timeoutMs)}ms.`));
          }, timeoutMs);
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      if (timeout) NodeTimers.clearTimeout(timeout);
      callback();
    };
    child.once("error", (error) => finish(() => reject(error)));
    child.once("exit", (code, signal) => {
      finish(() => {
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
  });
}

function unique(values: ReadonlyArray<string>): ReadonlyArray<string> {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export function parseConfiguredWindowsSshTargets(
  configuredTargets: string | undefined,
): ReadonlyArray<string> {
  const value = configuredTargets?.trim();
  if (!value || value.toLowerCase() === "off" || value.toLowerCase() === "none") return [];
  return unique(value.split(","));
}

export function parseTailscaleWindowsHosts(statusJson: string): ReadonlyArray<string> {
  if (!statusJson.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(statusJson);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null || !("Peer" in parsed)) return [];
  const peerContainer = parsed.Peer;
  const peers: ReadonlyArray<unknown> = Array.isArray(peerContainer)
    ? peerContainer
    : typeof peerContainer === "object" && peerContainer !== null
      ? Object.values(peerContainer)
      : [];
  const hosts: string[] = [];
  for (const value of peers) {
    if (typeof value !== "object" || value === null) continue;
    const peer = value as TailscalePeer;
    if (peer.Online !== true || String(peer.OS).toLowerCase() !== "windows") continue;
    if (typeof peer.DNSName === "string" && peer.DNSName.trim()) {
      hosts.push(peer.DNSName.trim().replace(/\.$/, ""));
    }
    if (Array.isArray(peer.TailscaleIPs)) {
      const ipv4 = peer.TailscaleIPs.find(
        (address): address is string => typeof address === "string" && address.includes("."),
      );
      if (ipv4) hosts.push(ipv4);
    }
  }
  return unique(hosts);
}

export function resolveWindowsSshUsers(input: {
  readonly configuredUser?: string;
  readonly fullName?: string;
  readonly loginUser?: string;
}): ReadonlyArray<string> {
  const firstName = input.fullName?.trim().split(/\s+/)[0]?.toLowerCase();
  return unique([input.configuredUser ?? "", input.loginUser ?? "", firstName ?? ""]);
}

function targetIncludesUser(target: string): boolean {
  return target.lastIndexOf("@") > 0;
}

export function resolveWindowsSshDestinations(input: {
  readonly configuredTargets: ReadonlyArray<string>;
  readonly discoveredHosts: ReadonlyArray<string>;
  readonly users: ReadonlyArray<string>;
}): ReadonlyArray<string> {
  const targets =
    input.configuredTargets.length > 0 ? input.configuredTargets : input.discoveredHosts;
  return unique(
    targets.flatMap((target) =>
      targetIncludesUser(target) ? [target] : input.users.map((user) => `${user}@${target}`),
    ),
  );
}

export function buildWindowsArtifactArgs(input: {
  readonly artifactBuildScript: string;
  readonly outputDirectory: string;
  readonly resourceMonitorPrebuild: string;
  readonly wslPrebuild: string;
}): ReadonlyArray<string> {
  return [
    input.artifactBuildScript,
    "--platform",
    "win",
    "--target",
    "nsis",
    "--arch",
    WINDOWS_ARCH,
    "--output-dir",
    input.outputDirectory,
    "--resource-monitor-prebuild",
    input.resourceMonitorPrebuild,
    "--wsl-prebuild",
    input.wslPrebuild,
  ];
}

export async function runWindowsThenMacRelease(input: {
  readonly mac: (windowsBuilt: boolean) => Promise<void>;
  readonly onWindowsFailure?: (error: unknown) => void;
  readonly windows: () => Promise<boolean>;
}): Promise<void> {
  let windowsBuilt = false;
  let windowsFailure: unknown;
  try {
    windowsBuilt = await input.windows();
  } catch (error) {
    windowsFailure = error;
    input.onWindowsFailure?.(error);
  }

  try {
    await input.mac(windowsBuilt);
  } catch (macFailure) {
    if (windowsFailure === undefined) throw macFailure;
    const windowsMessage =
      windowsFailure instanceof Error ? windowsFailure.message : String(windowsFailure);
    const macMessage = macFailure instanceof Error ? macFailure.message : String(macFailure);
    throw new Error(
      `Windows release failed: ${windowsMessage}\nmacOS release also failed: ${macMessage}`,
      { cause: macFailure },
    );
  }

  if (windowsFailure !== undefined) {
    const message =
      windowsFailure instanceof Error ? windowsFailure.message : String(windowsFailure);
    throw new Error(`Windows release failed, but the macOS release was scheduled: ${message}`, {
      cause: windowsFailure,
    });
  }
}

function readLocalFullName(): string | undefined {
  const result = NodeChildProcess.spawnSync("/usr/bin/id", ["-F"], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

function hostFromDestination(destination: string): string {
  const at = destination.lastIndexOf("@");
  return (at >= 0 ? destination.slice(at + 1) : destination).replace(/^\[|\]$/g, "");
}

function parseProbeOutput(destination: string, output: string): WindowsSshProbe | undefined {
  const jsonLine = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .findLast((line) => line.startsWith("{") && line.endsWith("}"));
  if (!jsonLine) return undefined;
  try {
    const parsed: unknown = JSON.parse(jsonLine);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const platform = "Platform" in parsed ? parsed.Platform : undefined;
    const computerName = "ComputerName" in parsed ? parsed.ComputerName : undefined;
    const userProfile = "UserProfile" in parsed ? parsed.UserProfile : undefined;
    if (
      platform !== "Win32NT" ||
      typeof computerName !== "string" ||
      !computerName ||
      typeof userProfile !== "string" ||
      !userProfile
    ) {
      return undefined;
    }
    return {
      computerName,
      destination,
      host: hostFromDestination(destination),
    };
  } catch {
    return undefined;
  }
}

async function discoverWindowsSshProbe(): Promise<WindowsSshProbe | undefined> {
  const configuredValue = process.env.T3CODE_WINDOWS_SSH_TARGET;
  const configuredTargets = parseConfiguredWindowsSshTargets(configuredValue);
  if (
    configuredValue?.trim().toLowerCase() === "off" ||
    configuredValue?.trim().toLowerCase() === "none"
  ) {
    return undefined;
  }

  const tailscaleStatus = await runCommandCapture("tailscale", ["status", "--json"]).catch(() => ({
    exitCode: 1,
    stderr: "",
    stdout: "",
  }));
  const configuredUser = process.env.T3CODE_WINDOWS_SSH_USER;
  const fullName = readLocalFullName();
  const users = resolveWindowsSshUsers({
    ...(configuredUser !== undefined ? { configuredUser } : {}),
    ...(fullName !== undefined ? { fullName } : {}),
    loginUser: NodeOS.userInfo().username,
  });
  const destinations = resolveWindowsSshDestinations({
    configuredTargets,
    discoveredHosts: parseTailscaleWindowsHosts(
      tailscaleStatus.exitCode === 0 ? tailscaleStatus.stdout : "",
    ),
    users,
  });

  for (const destination of destinations) {
    const result = await runCommandCapture("ssh", [
      ...SSH_OPTIONS,
      destination,
      WINDOWS_PROBE_COMMAND,
    ]).catch(() => undefined);
    if (!result || result.exitCode !== 0) continue;
    const probe = parseProbeOutput(destination, result.stdout);
    if (probe) return probe;
  }
  return undefined;
}

function assertExistingFile(filePath: string, description: string): string {
  const resolved = NodePath.resolve(filePath);
  if (!NodeFS.existsSync(resolved) || !NodeFS.statSync(resolved).isFile()) {
    throw new Error(`${description} is missing at ${resolved}.`);
  }
  return resolved;
}

function resolveResourceMonitorPrebuild(repoRoot: string): string {
  const configured = process.env.T3CODE_DESKTOP_RESOURCE_MONITOR_PREBUILD?.trim();
  if (configured) return assertExistingFile(configured, "The Windows resource-monitor prebuild");
  const prebuild = assertExistingFile(
    NodePath.join(
      repoRoot,
      "native",
      "resource-monitor",
      "target",
      "x86_64-pc-windows-msvc",
      "release",
      "t3-resource-monitor.exe",
    ),
    "The Windows resource-monitor prebuild",
  );
  const sourceDirectory = NodePath.join(repoRoot, "native", "resource-monitor");
  const sourceFiles = [
    NodePath.join(sourceDirectory, "Cargo.toml"),
    NodePath.join(sourceDirectory, "Cargo.lock"),
    ...NodeFS.readdirSync(NodePath.join(sourceDirectory, "src"), { recursive: true })
      .map((entry) => NodePath.join(sourceDirectory, "src", String(entry)))
      .filter((entry) => NodeFS.existsSync(entry) && NodeFS.statSync(entry).isFile()),
  ];
  const prebuildModifiedAt = NodeFS.statSync(prebuild).mtimeMs;
  const newerSource = sourceFiles.find(
    (sourceFile) => NodeFS.statSync(sourceFile).mtimeMs > prebuildModifiedAt,
  );
  if (newerSource) {
    throw new Error(
      `The Windows resource-monitor prebuild is older than ${newerSource}. Rebuild it on Windows or set T3CODE_DESKTOP_RESOURCE_MONITOR_PREBUILD to a current x64 binary.`,
    );
  }
  return prebuild;
}

function assertLinuxX64Binary(filePath: string): string {
  const resolved = assertExistingFile(filePath, "The WSL node-pty prebuild");
  const header = NodeFS.readFileSync(resolved).subarray(0, 20);
  const isElfX64 =
    header.length >= 20 &&
    header[0] === 0x7f &&
    header.subarray(1, 4).toString("ascii") === "ELF" &&
    header.readUInt16LE(18) === 0x3e;
  if (!isElfX64) {
    throw new Error(`The WSL node-pty prebuild is not a Linux x64 ELF binary: ${resolved}`);
  }
  return resolved;
}

async function resolveDockerRuntime(): Promise<DockerRuntime> {
  const dockerInfo = await runCommandCapture("docker", ["info"], {}, 10_000).catch(() => undefined);
  if (dockerInfo?.exitCode === 0) {
    return { args: [], cleanUp: async () => undefined };
  }
  const colimaVersion = await runCommandCapture("colima", ["version"]).catch(() => undefined);
  if (!colimaVersion || colimaVersion.exitCode !== 0) {
    throw new Error(
      "A Linux x64 WSL node-pty prebuild is required. Start Docker or set T3CODE_DESKTOP_WSL_PREBUILD to a verified pty.node.",
    );
  }

  const profile = "t3code-release-build";
  const context = `colima-${profile}`;
  const existingStatus = await runCommandCapture(
    "docker",
    ["--context", context, "info"],
    {},
    10_000,
  ).catch(() => undefined);
  const wasRunning = existingStatus?.exitCode === 0;
  process.stdout.write(
    `${wasRunning ? "Reusing" : "Starting"} isolated Colima profile ${profile} to build the required Linux x64 WSL node-pty payload...\n`,
  );
  const cleanUp = async () => {
    if (!wasRunning) {
      await runCommandCapture("colima", ["stop", profile, "--force"], {}, 30_000).catch(
        () => undefined,
      );
    }
  };
  try {
    if (!wasRunning) {
      let started = false;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          await runCommand(
            "colima",
            [
              "start",
              profile,
              "--activate=false",
              "--runtime",
              "docker",
              "--cpus",
              "2",
              "--memory",
              "4",
              "--disk",
              "10",
              "--mount-inotify=false",
              "--ssh-config=false",
            ],
            {},
            120_000,
          );
          started = true;
          break;
        } catch (error) {
          await cleanUp();
          if (attempt === 2) throw error;
          process.stderr.write("Colima did not become ready; retrying the release profile once.\n");
        }
      }
      if (!started) throw new Error("The isolated Colima release profile did not start.");
    }
    const args = ["--context", context];
    const ready = await runCommandCapture("docker", [...args, "info"], {}, 10_000);
    if (ready.exitCode !== 0) {
      throw new Error("The isolated Colima profile started, but Docker did not become available.");
    }
    return { args, cleanUp };
  } catch (error) {
    await cleanUp();
    throw error;
  }
}

async function buildWslNodePtyPrebuild(repoRoot: string, outputPath: string): Promise<string> {
  const configured = process.env.T3CODE_DESKTOP_WSL_PREBUILD?.trim();
  if (configured) return assertLinuxX64Binary(configured);

  const nodePtyDirectory = NodeFS.realpathSync(
    NodePath.join(repoRoot, "apps", "server", "node_modules", "node-pty"),
  );
  const nodeAddonApiDirectory = NodeFS.realpathSync(
    NodePath.join(NodePath.dirname(nodePtyDirectory), "node-addon-api"),
  );
  const nodePtyManifest = JSON.parse(
    NodeFS.readFileSync(NodePath.join(nodePtyDirectory, "package.json"), "utf8"),
  ) as { readonly version?: unknown };
  if (typeof nodePtyManifest.version !== "string" || !nodePtyManifest.version) {
    throw new Error("Could not resolve the installed node-pty version for the WSL prebuild.");
  }
  const cachePath = NodePath.join(
    repoRoot,
    "release",
    ".native-cache",
    `node-pty-${nodePtyManifest.version}-linux-x64`,
    "pty.node",
  );
  if (NodeFS.existsSync(cachePath)) {
    try {
      process.stdout.write(`Reusing cached Linux x64 WSL node-pty payload: ${cachePath}\n`);
      return assertLinuxX64Binary(cachePath);
    } catch {
      process.stderr.write(`Ignoring invalid cached WSL node-pty payload: ${cachePath}\n`);
    }
  }
  const outputDirectory = NodePath.dirname(outputPath);
  let dockerRuntime: DockerRuntime | undefined;
  try {
    dockerRuntime = await resolveDockerRuntime();
    process.stdout.write(
      "Building the Linux x64 WSL node-pty payload in an isolated container...\n",
    );
    await runCommand(
      "docker",
      [
        ...dockerRuntime.args,
        "run",
        "--rm",
        "--platform",
        "linux/amd64",
        "--volume",
        `${nodePtyDirectory}:/source:ro`,
        "--volume",
        `${nodeAddonApiDirectory}:/node-addon-api:ro`,
        "--volume",
        `${outputDirectory}:/out`,
        "node:24-bookworm",
        "bash",
        "-lc",
        "set -euo pipefail; cp -R /source /tmp/node-pty; mkdir -p /tmp/node-pty/node_modules; cp -R /node-addon-api /tmp/node-pty/node_modules/node-addon-api; cd /tmp/node-pty; npx --yes node-gyp rebuild; cp build/Release/pty.node /out/pty.node",
      ],
      {},
      10 * 60_000,
    );
    assertLinuxX64Binary(outputPath);
    NodeFS.mkdirSync(NodePath.dirname(cachePath), { recursive: true });
    NodeFS.copyFileSync(outputPath, cachePath);
    return assertLinuxX64Binary(cachePath);
  } finally {
    if (dockerRuntime) {
      await dockerRuntime.cleanUp().catch((error: unknown) => {
        process.stderr.write(
          `The temporary container runtime could not be cleaned up: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      });
    }
  }
}

function sha256(filePath: string): string {
  const hash = NodeCrypto.createHash("sha256");
  hash.update(NodeFS.readFileSync(filePath));
  return hash.digest("hex");
}

function powerShellLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function createRemoteDirectory(probe: WindowsSshProbe, relativePath: string): Promise<void> {
  const command = `powershell -NoProfile -NonInteractive -Command "New-Item -ItemType Directory -Force -Path (Join-Path $env:USERPROFILE ${powerShellLiteral(relativePath)}) | Out-Null"`;
  await runCommand("ssh", [...SSH_OPTIONS, probe.destination, command]);
}

async function copyToWindows(
  probe: WindowsSshProbe,
  localPath: string,
  remoteRelativePath: string,
): Promise<void> {
  await runCommand("scp", [
    ...SSH_OPTIONS,
    localPath,
    `${probe.destination}:${remoteRelativePath}`,
  ]);
}

async function cleanRemoteDirectory(probe: WindowsSshProbe, relativePath: string): Promise<void> {
  const command = `powershell -NoProfile -NonInteractive -Command "Remove-Item -LiteralPath (Join-Path $env:USERPROFILE ${powerShellLiteral(relativePath)}) -Recurse -Force -ErrorAction SilentlyContinue"`;
  await runCommandCapture("ssh", [...SSH_OPTIONS, probe.destination, command]).catch(
    () => undefined,
  );
}

function windowsHealthUrl(host: string): string {
  const urlHost = host.includes(":") ? `[${host}]` : host;
  return `http://${urlHost}:3773/`;
}

async function verifyExternalWindowsHealth(probe: WindowsSshProbe): Promise<void> {
  const healthUrl = windowsHealthUrl(probe.host);
  await new Promise<void>((resolve, reject) => {
    const request = NodeHttp.get(healthUrl, (response) => {
      response.resume();
      if (response.statusCode === 200) {
        resolve();
        return;
      }
      reject(
        new Error(
          `Windows relaunched locally, but its remote health check failed at ${healthUrl}: returned HTTP ${String(response.statusCode ?? "unknown")}`,
        ),
      );
    });
    request.setTimeout(10_000, () => {
      request.destroy(new Error("timed out after 10 seconds"));
    });
    request.once("error", (error) => {
      reject(
        new Error(
          `Windows relaunched locally, but its remote health check failed at ${healthUrl}: ${error.message}`,
        ),
      );
    });
  });
}

export async function installWindowsReleaseOverSshIfAvailable(
  context: WindowsReleaseBuildContext,
): Promise<boolean> {
  const probe = await discoverWindowsSshProbe();
  if (!probe) {
    process.stdout.write(
      "No reachable Windows machine was detected over non-interactive SSH; continuing with the macOS release.\n",
    );
    return false;
  }

  process.stdout.write(
    `Detected Windows SSH host ${probe.computerName}. Building and installing Windows before macOS...\n`,
  );
  const releaseDirectory = NodePath.join(context.repoRoot, "release");
  NodeFS.mkdirSync(releaseDirectory, { recursive: true });
  const temporaryDirectory = NodeFS.mkdtempSync(
    NodePath.join(releaseDirectory, ".windows-release-"),
  );
  const remoteDirectory = `t3code-release-${NodeCrypto.randomBytes(6).toString("hex")}`;
  let remoteDirectoryCreated = false;
  try {
    const wslPrebuild = await buildWslNodePtyPrebuild(
      context.repoRoot,
      NodePath.join(temporaryDirectory, "pty.node"),
    );
    const resourceMonitorPrebuild = resolveResourceMonitorPrebuild(context.repoRoot);
    const outputDirectory = releaseDirectory;
    const artifactPath = NodePath.join(
      outputDirectory,
      `Solla-Code-${context.version}-${WINDOWS_ARCH}.exe`,
    );

    await runCommand(
      process.execPath,
      buildWindowsArtifactArgs({
        artifactBuildScript: context.artifactBuildScript,
        outputDirectory,
        resourceMonitorPrebuild,
        wslPrebuild,
      }),
      {
        cwd: context.repoRoot,
        env: context.buildEnvironment,
      },
    );
    assertExistingFile(artifactPath, "The Windows NSIS release artifact");

    await createRemoteDirectory(probe, remoteDirectory);
    remoteDirectoryCreated = true;
    const installerName = NodePath.basename(artifactPath);
    const installerScriptPath = assertExistingFile(
      NodePath.join(context.repoRoot, "scripts", WINDOWS_INSTALLER_SCRIPT),
      "The Windows guarded installer",
    );
    await copyToWindows(probe, artifactPath, `${remoteDirectory}/${installerName}`);
    await copyToWindows(
      probe,
      installerScriptPath,
      `${remoteDirectory}/${WINDOWS_INSTALLER_SCRIPT}`,
    );

    const installerCommand = [
      "powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command",
      `"& (Join-Path $env:USERPROFILE ${powerShellLiteral(`${remoteDirectory}/${WINDOWS_INSTALLER_SCRIPT}`)})`,
      `-InstallerPath (Join-Path $env:USERPROFILE ${powerShellLiteral(`${remoteDirectory}/${installerName}`)})`,
      `-ExpectedVersion ${powerShellLiteral(context.version)}`,
      `-ExpectedSha256 ${powerShellLiteral(sha256(artifactPath))}"`,
    ].join(" ");
    await runCommand("ssh", [...SSH_OPTIONS, probe.destination, installerCommand]);
    await verifyExternalWindowsHealth(probe);
    process.stdout.write(
      `Windows ${context.version} is installed, running with --auto-resume, and remotely healthy.\n`,
    );
    return true;
  } finally {
    if (remoteDirectoryCreated) {
      await cleanRemoteDirectory(probe, remoteDirectory);
    }
    NodeFS.rmSync(temporaryDirectory, { force: true, recursive: true });
  }
}
