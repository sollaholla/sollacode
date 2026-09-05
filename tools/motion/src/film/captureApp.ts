/** Lossless recordings of the production client, with real pointer-event timing. */
import { chromium, type Locator } from "playwright-core";
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
const output = NodePath.join(root, "output/playwright/product");
const captures = NodePath.join(root, "tools/motion/captures");
const { origin, baseDir, environmentId, searchId, dashboardId, executablePath } =
  await readCaptureConfig();
const selected = process.argv.find((arg) => arg.startsWith("--scene="))?.slice(8);
const route = (id: string) => `${origin}/${environmentId}/${id}`;
await NodeFSP.mkdir(output, { recursive: true });
const pairOutput = NodeChildProcess.execFileSync(
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
const pairingUrl = pairOutput.match(/Pair URL: (\S+)/)?.[1];
if (!pairingUrl) throw new Error("Pairing URL missing");
const browser = await chromium.launch({ executablePath, args: ["--force-color-profile=srgb"] });
const context = await browser.newContext({
  viewport: { width: 1314, height: 912 },
  colorScheme: "dark",
});
const page = await context.newPage();
page.setDefaultTimeout(15000);
page.setDefaultNavigationTimeout(20000);
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
// These holds set the duration of the recorded shot. Assertions wait on UI state.
const hold = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function waitForTerminalOutput(file: string, offset: number, expected: RegExp) {
  return new Promise<void>((resolve, reject) => {
    const watcher = NodeFS.watch(file, async () => {
      if (expected.test((await NodeFSP.readFile(file, "utf8")).slice(offset))) {
        clearTimeout(timeout);
        watcher.close();
        resolve();
      }
    });
    const timeout = setTimeout(() => {
      watcher.close();
      reject(new Error(`Missing terminal output: ${expected}`));
    }, 20000);
  });
}

async function record(
  name: string,
  run: (click: (target: Locator, label: string) => Promise<void>) => Promise<void>,
) {
  const dir = NodePath.join(output, name);
  await NodeFSP.mkdir(dir, { recursive: true });
  const client = await context.newCDPSession(page);
  const frames: { file: string; at: number }[] = [];
  const actions: { at: number; x: number; y: number; name: string }[] = [];
  let label = "";
  await page.exposeBinding(`captureClick_${name}`, (_source, x: number, y: number, at: number) =>
    actions.push({ at: at / 1000, x, y, name: label }),
  );
  await page.evaluate((name) => {
    const binding = `captureClick_${name}`;
    const listener = (event: MouseEvent) =>
      (window as unknown as Record<string, (...args: number[]) => void>)[binding](
        event.clientX,
        event.clientY,
        Date.now(),
      );
    document.addEventListener("pointerdown", listener);
    (window as unknown as Record<string, unknown>)[`removeCapture_${name}`] = () =>
      document.removeEventListener("pointerdown", listener);
  }, name);
  client.on("Page.screencastFrame", async ({ data, metadata, sessionId }) => {
    const file = NodePath.join(dir, `${String(frames.length).padStart(5, "0")}.png`);
    NodeFS.writeFileSync(file, Buffer.from(data, "base64"));
    frames.push({ file, at: metadata.timestamp ?? Date.now() / 1000 });
    await client.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
  });
  await client.send("Page.startScreencast", {
    format: "png",
    maxWidth: 1314,
    maxHeight: 912,
    everyNthFrame: 1,
  });
  const click = async (target: Locator, name: string) => {
    label = name;
    await target.click();
  };
  let end = 0;
  try {
    await hold(1000);
    await run(click);
    await hold(2000);
  } finally {
    end = Date.now() / 1000;
    await client.send("Page.stopScreencast");
    await client.detach();
    await page.evaluate(
      (name) => (window as unknown as Record<string, () => void>)[`removeCapture_${name}`](),
      name,
    );
  }
  // Failed shots remain diagnostic frames and must not replace approved captures.
  if (frames.length === 0) throw new Error(`No frames captured for ${name}`);
  const first = frames[0]!.at;
  if (Math.abs(first - end) > 120) throw new Error("Unexpected capture timestamp clock");
  const concat =
    frames
      .map(
        (frame, index) =>
          `file '${frame.file}'\nduration ${Math.max(0.001, (frames[index + 1]?.at ?? end) - frame.at).toFixed(6)}`,
      )
      .join("\n") + `\nfile '${frames.at(-1)!.file}'\n`;
  await NodeFSP.writeFile(NodePath.join(dir, "frames.txt"), concat);
  NodeChildProcess.execFileSync(
    "ffmpeg",
    [
      "-y",
      "-loglevel",
      "error",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      NodePath.join(dir, "frames.txt"),
      "-vf",
      "fps=30",
      "-c:v",
      "libx264",
      "-crf",
      "14",
      "-preset",
      "fast",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      NodePath.join(captures, `${name}.mp4`),
    ],
    { stdio: "pipe" },
  );
  await NodeFSP.writeFile(
    NodePath.join(captures, `${name}-source.json`),
    JSON.stringify(
      {
        source: "Production client, lossless Chromium compositor frames",
        viewport: { width: 1314, height: 912 },
        duration: end - first,
        actions: actions.map((action) => ({ ...action, at: action.at - first })),
        errors,
      },
      null,
      2,
    ),
  );
  await page.screenshot({ path: NodePath.join(captures, `${name}.png`) });
  process.stdout.write(`Recorded ${name}: ${frames.length} native frames\n`);
}

try {
  process.stdout.write("Pairing production client\n");
  await page.goto(pairingUrl);
  await page.waitForURL((url) => !url.pathname.startsWith("/pair"));
  await page.goto(`${origin}/settings/providers`);
  process.stdout.write("Reading provider settings\n");
  const usage = page.getByRole("switch", { name: "Show provider usage bar", exact: true });
  await usage.waitFor();
  if (await usage.isChecked()) await usage.click();
  if (selected === "failover") {
    await page.getByText("Grok primary", { exact: true }).first().waitFor();
    await NodeFSP.writeFile(
      NodePath.join(output, "providers-ready.txt"),
      await page.locator("body").innerText(),
    );
  }
  await page.goto(route(searchId));
  process.stdout.write("Opening search thread\n");
  const returnToChat = page.getByRole("button", { name: "Switch to chat mode", exact: true });
  await page.getByTestId("composer-editor").or(returnToChat).waitFor();
  if (await returnToChat.isVisible()) await returnToChat.click();
  await page.getByTestId("composer-editor").waitFor();
  await page.getByRole("status", { name: "Received by Codex", exact: true }).waitFor();
  if (!selected || selected === "workspace")
    await record("workspace", async () => {
      await hold(8000);
    });
  if (!selected || selected === "threads")
    await record("threads", async (click) => {
      await hold(1200);
      await click(
        page.getByRole("button", { name: /Review keyboard navigation/ }),
        "Open keyboard navigation review",
      );
      await hold(2200);
      await click(
        page.getByRole("button", { name: /Design a calmer reading view/ }),
        "Open the Fieldnotes reading-view thread",
      );
      await hold(2200);
      await click(
        page.getByRole("button", { name: /Refine the dashboard layout/ }),
        "Return to the Lumen dashboard thread",
      );
      await hold(2200);
    });
  if (!selected || selected === "providers") {
    await page.goto(route(searchId));
    await page.locator('[data-chat-provider-model-picker="true"]').click();
    await page.getByRole("button", { name: "Claude", exact: true }).waitFor();
    await record("providers", async (click) => {
      await hold(700);
      await click(
        page.getByRole("button", { name: "Claude", exact: true }),
        "Browse Claude models",
      );
      await hold(2300);
      await click(
        page.getByRole("button", { name: "Antigravity", exact: true }),
        "Browse Antigravity models",
      );
      await hold(2300);
    });
    await page.keyboard.press("Escape");
  }
  if (!selected || selected === "agents") {
    await record("agents", async (click) => {
      await click(
        page.getByRole("button", { name: /^Open Code Reviewer on/ }),
        "Open your Code Reviewer agent",
      );
      await hold(1200);
      await click(
        page.getByRole("button", { name: "Agent tools", exact: true }),
        "Open agent tools",
      );
      await hold(700);
      await click(
        page.getByRole("menuitem", { name: "Rules", exact: true }),
        "Review this agent’s working instructions",
      );
      await page.getByRole("textbox", { name: "Agent rules", exact: true }).waitFor();
      await hold(4000);
    });
  }
  if (selected === "artifact") {
    await page.goto(route(dashboardId));
    await page.getByTestId("composer-editor").waitFor();
    await page.getByRole("button", { name: "Toggle right panel", exact: true }).click();
    await page.getByRole("button", { name: /Lumen dashboard.*revision 2/ }).click();
    await page
      .frameLocator("iframe")
      .getByRole("heading", { name: /A little clarity/ })
      .waitFor();
    await record("artifact", async (click) => {
      await hold(2500);
      await click(
        page.getByRole("button", { name: "Maximize panel", exact: true }),
        "Expand the dashboard artifact",
      );
      await hold(3000);
      await click(
        page.getByRole("button", { name: "Restore panel size", exact: true }),
        "Restore the conversation beside the artifact",
      );
      await hold(2000);
    });
  }
  if (selected === "terminals") {
    await page.getByRole("button", { name: "Switch to terminal mode", exact: true }).click();
    const launchPad = page.getByTestId("terminal-launch-pad");
    await launchPad.or(page.locator(".xterm").first()).waitFor();
    if (await launchPad.isVisible()) {
      await page.getByRole("button", { name: "More terminals", exact: true }).click();
      await page.getByRole("button", { name: "Launch 2 terminals", exact: true }).click();
    }
    await page.locator(".xterm").nth(1).waitFor();
    const terminals = page.locator(".xterm");
    for (const terminal of await terminals.all()) {
      await terminal.click();
      await page.keyboard.type("export PS1='$ ' RPROMPT='' ; clear");
      await page.keyboard.press("Enter");
    }
    const logFile = NodePath.join(
      baseDir,
      "userdata/logs/terminals",
      `terminal_${Buffer.from(searchId).toString("base64url")}.log`,
    );
    await record("terminals", async (click) => {
      await click(terminals.nth(1), "Read the search implementation");
      await page.keyboard.type("cat src/search.mjs", { delay: 35 });
      await page.keyboard.press("Enter");
      await hold(1400);
      await click(terminals.nth(0), "Run the five search tests");
      const offset = (await NodeFSP.readFile(logFile, "utf8")).length;
      const passed = waitForTerminalOutput(logFile, offset, /pass.*5/);
      await page.keyboard.type("node --test src/search.test.mjs", { delay: 26 });
      await page.keyboard.press("Enter");
      await passed;
      await hold(2500);
    });
  }
  if (selected === "failover") {
    await page.getByRole("button", { name: "New thread in Lumen", exact: true }).click();
    await page.getByTestId("composer-editor").waitFor();
    await page.locator('[data-chat-provider-model-picker="true"]').click();
    await page.getByRole("button", { name: "Grok primary", exact: true }).click();
    await page.getByRole("option", { name: /Grok Build/ }).click();
    await page
      .getByTestId("composer-editor")
      .fill("Review the Lumen project search and confirm which edge cases the tests cover.");
    await record("failover", async (click) => {
      await click(
        page.getByRole("button", { name: "Send message", exact: true }),
        "Send the search review to Grok primary",
      );
      await page
        .getByText("Continuing the review with the existing thread context.", { exact: false })
        .waitFor({ timeout: 60000 });
      await hold(4000);
    });
    await NodeFSP.writeFile(
      NodePath.join(output, "failover-inspect.txt"),
      await page.locator("body").innerText(),
    );
    await page.screenshot({ path: NodePath.join(output, "failover-inspect.png") });
  }
  if (selected === "stop") {
    const existingControlledThread = process.env.SOLLA_STOP_THREAD;
    if (existingControlledThread) await page.goto(route(existingControlledThread));
    else await page.getByRole("button", { name: "New thread in Lumen", exact: true }).click();
    const editor = page.getByTestId("composer-editor");
    if (!existingControlledThread) {
      const requestLog = NodePath.join(baseDir, "stop-requests.jsonl");
      const offset = (await NodeFSP.readFile(requestLog, "utf8")).length;
      const dispatched = waitForTerminalOutput(requestLog, offset, /"method":"session\/prompt"/);
      await editor.fill("Wait for my follow-up while I check the Stop control.");
      await page.getByRole("button", { name: "Send message", exact: true }).click();
      await dispatched;
    }
    await editor.fill("This follow-up should be cancelled by Stop.");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await page
      .getByText("This follow-up should be cancelled by Stop.", { exact: false })
      .first()
      .waitFor();
    await page.getByRole("button", { name: "Stop generation", exact: true }).click();
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .waitFor({ timeout: 15000 });
    await page.screenshot({ path: NodePath.join(output, "stop-complete.png") });
    await NodeFSP.writeFile(
      NodePath.join(output, "stop-complete.txt"),
      await page.locator("body").innerText(),
    );
    if (await page.getByText("late after cancel", { exact: false }).count())
      throw new Error("A cancelled provider update reached the conversation");
    await NodeFSP.writeFile(
      NodePath.join(output, "stop-result.json"),
      JSON.stringify(
        { url: page.url(), status: "Stop returned the composer to idle", errors },
        null,
        2,
      ),
    );
  }
} catch (error) {
  await page.screenshot({ path: NodePath.join(output, "failure.png") });
  await NodeFSP.writeFile(
    NodePath.join(output, "failure.txt"),
    await page.locator("body").innerText(),
  );
  await NodeFSP.writeFile(NodePath.join(output, "failure-url.txt"), page.url());
  await page.goto(`${origin}/settings/providers`);
  await page.getByRole("switch", { name: "Show provider usage bar", exact: true }).waitFor();
  await NodeFSP.writeFile(
    NodePath.join(output, "failure-providers.txt"),
    await page.locator("body").innerText(),
  );
  throw error;
} finally {
  await browser.close();
}
