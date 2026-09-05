/** Real production-app voice capture using a formant-synthesized microphone fixture. */
import { chromium } from "playwright-core";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { readCaptureConfig } from "./captureConfig.ts";

const root = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../../../..",
);
const output = NodePath.join(root, "output/playwright/voice");
await NodeFSP.mkdir(output, { recursive: true });
const { baseDir, origin, environmentId, searchId, executablePath } = await readCaptureConfig();
const log = NodeChildProcess.execFileSync(
  process.execPath,
  [
    "apps/server/src/bin.ts",
    "auth",
    "pairing",
    "create",
    "--base-dir",
    baseDir,
    "--base-url",
    origin,
  ],
  { cwd: root, encoding: "utf8", timeout: 20000 },
);
const pairingUrl = log.match(/Pair URL: (\S+)/)?.[1];
if (!pairingUrl)
  throw new Error("Start the disposable production server and obtain a pairing URL.");
const microphone = process.env.SOLLA_DEMO_MICROPHONE;
if (!microphone || !NodeFS.existsSync(microphone))
  throw new Error("Set SOLLA_DEMO_MICROPHONE to the non-ML microphone WAV fixture.");
const browser = await chromium.launch({
  executablePath,
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    `--use-file-for-fake-audio-capture=${NodePath.resolve(microphone)}`,
    "--autoplay-policy=no-user-gesture-required",
  ],
});
const context = await browser.newContext({
  colorScheme: "dark",
  viewport: { width: 880, height: 832 },
  hasTouch: true,
  permissions: ["microphone"],
  recordVideo: { dir: output, size: { width: 880, height: 832 } },
});
const page = await context.newPage();
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
try {
  await page.goto(pairingUrl);
  await page.waitForURL((url) => !url.pathname.startsWith("/pair"), { timeout: 20000 });
  await page.goto(`${origin}/${environmentId}/${searchId}`);
  await page.getByTestId("orchestrator-voice-toggle").waitFor({ timeout: 20000 });
  await page.screenshot({ path: NodePath.join(output, "before.png") });
  await NodeFSP.writeFile(
    NodePath.join(output, "before.txt"),
    await page.locator("body").innerText(),
  );
  const started = Date.now();
  await page.getByTestId("orchestrator-voice-toggle").click();
  const stop = page.getByRole("button", { name: "Stop listening", exact: true });
  const overlay = page.locator('div[aria-live="polite"]').filter({ has: stop });
  await stop.waitFor({ timeout: 20000 });
  await page.screenshot({ path: NodePath.join(output, "listening.png") });
  // Wait for the actual speech transcription, then the provider's response.
  await overlay.getByText(/Which projects are in this workspace/i).waitFor({ timeout: 30000 });
  const transcribedMs = Date.now() - started;
  await page.screenshot({ path: NodePath.join(output, "transcribed.png") });
  await overlay
    .getByText(/Lumen.*(?:Orbit|Fieldnotes)|(?:Orbit|Fieldnotes).*Lumen/i)
    .waitFor({ timeout: 30000 });
  await overlay.getByText("Listening", { exact: true }).waitFor({ timeout: 30000 });
  await page.screenshot({ path: NodePath.join(output, "response.png") });
  await NodeFSP.writeFile(
    NodePath.join(output, "result.json"),
    JSON.stringify(
      {
        elapsedMs: Date.now() - started,
        transcribedMs,
        text: await overlay.innerText(),
        errors,
        input: "Which projects are in this workspace? Keep it to one sentence.",
        inputMethod: "eSpeak NG formant synthesis through Chromium's file microphone",
      },
      null,
      2,
    ),
  );
  await stop.click();
  await page
    .getByRole("button", { name: "Stop listening", exact: true })
    .waitFor({ state: "hidden" });
  process.stdout.write("Voice transcription, response, and Stop verified.\n");
} catch (error) {
  await page.screenshot({ path: NodePath.join(output, "failure.png") });
  await NodeFSP.writeFile(
    NodePath.join(output, "failure.txt"),
    await page.locator("body").innerText(),
  );
  throw error;
} finally {
  await context.close();
  const video = await page.video()?.path();
  if (video) process.stdout.write(`Recording: ${video}\n`);
  await browser.close();
}
