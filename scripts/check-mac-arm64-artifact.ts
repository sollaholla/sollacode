// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - a standalone release check
/**
 * Checks a cross-built macOS arm64 app without running it: an Intel runner
 * cannot start one, so this proves each binary the app needs is really arm64.
 * Run by `.github/workflows/release.yml`.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

/** The binaries an arm64 app cannot start or work without, relative to `.app/Contents`. */
export const REQUIRED_ARM64_BINARIES = [
  "Frameworks/Electron Framework.framework/Electron Framework",
  "Resources/resource-monitor/t3-resource-monitor",
  "Resources/macos-speech-transcriber",
  "Resources/app.asar.unpacked/node_modules/node-pty/prebuilds/darwin-arm64/pty.node",
] as const;

/** Whether `lipo -archs` output says a binary runs on Apple silicon. */
export const hasArm64Slice = (archs: string) => archs.trim().split(/\s+/u).includes("arm64");

const archsOf = (binary: string) => {
  const result = NodeChildProcess.spawnSync("lipo", ["-archs", binary], { encoding: "utf8" });
  return result.status === 0 ? result.stdout : "";
};

function main(): number {
  const directory = process.argv[2];
  if (!directory) throw new Error("Pass the directory holding the arm64 zip.");
  const zip = NodeFS.readdirSync(directory).find((name) => name.endsWith("-arm64.zip"));
  if (!zip) throw new Error(`No arm64 zip in ${directory}.`);
  const unpacked = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "arm64-check-"));
  const ditto = NodeChildProcess.spawnSync("ditto", [
    "-x",
    "-k",
    NodePath.join(directory, zip),
    unpacked,
  ]);
  if (ditto.status !== 0) throw new Error(`Could not unpack ${zip}.`);
  const app = NodeFS.readdirSync(unpacked).find((name) => name.endsWith(".app"));
  if (!app) throw new Error(`${zip} holds no app.`);
  const contents = NodePath.join(unpacked, app, "Contents");
  const executable = NodePath.join("MacOS", app.replace(/\.app$/u, ""));
  const wrong = [executable, ...REQUIRED_ARM64_BINARIES].filter(
    (binary) => !hasArm64Slice(archsOf(NodePath.join(contents, binary))),
  );
  NodeFS.rmSync(unpacked, { recursive: true, force: true });
  if (wrong.length > 0) {
    console.error(`Not arm64, or missing:\n${wrong.join("\n")}`);
    return 1;
  }
  console.log(`${zip}: every required binary is arm64.`);
  return 0;
}

if (process.argv[1] && NodePath.resolve(process.argv[1]) === import.meta.filename) {
  process.exitCode = main();
}
