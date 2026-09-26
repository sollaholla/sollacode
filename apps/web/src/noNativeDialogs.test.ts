// @effect-diagnostics nodeBuiltinImport:off
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

/**
 * Solla never opens a native dialog. This is a hard rule, not a preference.
 *
 * `window.confirm`, `window.alert`, `window.prompt`, and Electron's
 * `dialog.showMessageBox` all STOP the renderer's JavaScript thread until
 * someone answers. While one is open the page cannot run a timer, answer a
 * debugger evaluation, or repaint - so the app looks hung, remote control
 * cannot be started, and preview automation cannot even read the tab's
 * viewport, because the thread that would answer is the thread being blocked.
 *
 * On 2026-09-11 exactly one unanswered "Reveal the signed-in account?" froze
 * the renderer, which stalled foregrounding that guest, which held a global
 * mutex, which wedged automation for EVERY tab - opening a brand-new tab timed
 * out too. One dialog took down the whole pipeline.
 *
 * Use `confirmInApp` from components/ui/appConfirm instead: it resolves a
 * promise from ordinary React state and never blocks anything.
 */
const BANNED = [
  { pattern: /\bwindow\.confirm\s*\(/u, name: "window.confirm" },
  { pattern: /\bwindow\.alert\s*\(/u, name: "window.alert" },
  { pattern: /\bwindow\.prompt\s*\(/u, name: "window.prompt" },
];

function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      found.push(...sourceFiles(path));
      continue;
    }
    if (!/\.tsx?$/u.test(entry) || /\.test\.tsx?$/u.test(entry)) continue;
    found.push(path);
  }
  return found;
}

describe("no native dialogs", () => {
  it("never calls a renderer-blocking dialog anywhere in the web app", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(join(import.meta.dirname, "."))) {
      const contents = readFileSync(file, "utf8");
      for (const banned of BANNED) {
        if (banned.pattern.test(contents)) {
          offenders.push(
            `${file.replace(import.meta.dirname, "apps/web/src")} uses ${banned.name}`,
          );
        }
      }
    }

    expect(
      offenders,
      `Native dialogs freeze the renderer and wedge preview automation. Use confirmInApp from components/ui/appConfirm instead.\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
