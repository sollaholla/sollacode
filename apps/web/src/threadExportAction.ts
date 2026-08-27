import type { EnvironmentThread } from "@t3tools/client-runtime/state/models";
import type { ScopedThreadRef } from "@t3tools/contracts";

import { readLocalApi } from "./localApi";
import { appAtomRegistry } from "./rpc/atomRegistry";
import { environmentThreadDetails } from "./state/threads";
import {
  countThreadTurns,
  LARGE_THREAD_EXPORT_TURN_THRESHOLD,
  serializeThreadHandoff,
  threadExportFilename,
} from "./threadExport";

const THREAD_EXPORT_LOAD_TIMEOUT_MS = 15_000;

function downloadJsonInBrowser(filename: string, contents: string): string {
  const blob = new Blob([`${contents}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.download = filename;
  anchor.href = url;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return `Downloads/${filename}`;
}

export async function persistThreadExportJson(input: {
  readonly filename: string;
  readonly contents: string;
}): Promise<string> {
  if (!window.desktopBridge) {
    return downloadJsonInBrowser(input.filename, input.contents);
  }

  const outputPath = await window.desktopBridge.saveThreadExportJson(input);
  const revealed = await window.desktopBridge.revealFile(outputPath);
  if (!revealed) {
    throw new Error(`The export was saved, but Finder could not reveal ${outputPath}.`);
  }
  return outputPath;
}

async function loadThreadForExport(threadRef: ScopedThreadRef): Promise<EnvironmentThread> {
  const threadAtom = environmentThreadDetails.detailAtom(threadRef);
  const current = appAtomRegistry.get(threadAtom);
  if (current !== null) return current;

  return await new Promise<EnvironmentThread>((resolve, reject) => {
    let unsubscribe = () => {};
    const timeoutId = window.setTimeout(() => {
      unsubscribe();
      reject(new Error("Conversation data did not finish loading for export."));
    }, THREAD_EXPORT_LOAD_TIMEOUT_MS);

    unsubscribe = appAtomRegistry.subscribe(threadAtom, (thread) => {
      if (thread === null) return;
      window.clearTimeout(timeoutId);
      unsubscribe();
      resolve(thread);
    });

    const loaded = appAtomRegistry.get(threadAtom);
    if (loaded !== null) {
      window.clearTimeout(timeoutId);
      unsubscribe();
      resolve(loaded);
    }
  });
}

/** Export the complete thread immediately and reveal the file on desktop. */
export async function exportThreadJson(threadRef: ScopedThreadRef): Promise<string | null> {
  const thread = await loadThreadForExport(threadRef);
  const turnCount = countThreadTurns(thread);
  if (turnCount > LARGE_THREAD_EXPORT_TURN_THRESHOLD) {
    const message = `This conversation contains ${turnCount} turns. The JSON handoff may be large and take longer to export. Continue?`;
    const api = readLocalApi();
    const confirmed = api ? await api.dialogs.confirm(message) : window.confirm(message);
    if (!confirmed) return null;
  }

  const filename = threadExportFilename(thread);
  const contents = serializeThreadHandoff(thread);
  return persistThreadExportJson({ filename, contents });
}
