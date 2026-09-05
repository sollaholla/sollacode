/** Explicit, disposable workspace configuration for production-client captures. */
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { chromium } from "playwright-core";

export async function readCaptureConfig() {
  const configuredHome = process.env.SOLLA_DEMO_HOME;
  if (!configuredHome)
    throw new Error("Set SOLLA_DEMO_HOME to a disposable demonstration workspace.");
  const baseDir = NodePath.resolve(configuredHome);
  for (const liveHome of [".solla-code", ".t3"]) {
    const protectedRoot = NodePath.join(NodeOS.homedir(), liveHome);
    if (baseDir === protectedRoot || baseDir.startsWith(protectedRoot + NodePath.sep)) {
      throw new Error("Capture against a disposable copy, never the installed app's home.");
    }
  }
  const origin = new URL(process.env.SOLLA_DEMO_ORIGIN ?? "http://127.0.0.1:13773").origin;
  const metadataResponse = await fetch(`${origin}/.well-known/t3/environment`);
  if (!metadataResponse.ok) throw new Error(`Demo server returned HTTP ${metadataResponse.status}`);
  const metadata = (await metadataResponse.json()) as { environmentId?: unknown };
  if (typeof metadata.environmentId !== "string")
    throw new Error("Demo server has no environment identity.");
  const showcase = JSON.parse(
    await NodeFSP.readFile(NodePath.join(baseDir, "showcase.json"), "utf8"),
  ) as {
    threadIds?: unknown;
  };
  if (
    !Array.isArray(showcase.threadIds) ||
    showcase.threadIds.length < 2 ||
    showcase.threadIds.some((id) => typeof id !== "string")
  ) {
    throw new Error(
      "showcase.json must list the search and dashboard thread IDs first in threadIds.",
    );
  }
  const executablePath = [
    process.env.SOLLA_CHROMIUM,
    chromium.executablePath(),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].find((candidate) => candidate && NodeFS.existsSync(candidate));
  if (!executablePath) throw new Error("Install Chromium or set SOLLA_CHROMIUM.");
  return {
    baseDir,
    origin,
    environmentId: metadata.environmentId,
    searchId: showcase.threadIds[0] as string,
    dashboardId: showcase.threadIds[1] as string,
    executablePath,
  };
}
