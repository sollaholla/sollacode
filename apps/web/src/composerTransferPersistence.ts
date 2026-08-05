export interface PersistedComposerTransferFile {
  readonly name: string;
  readonly mimeType: string;
  readonly lastModified: number;
  readonly blob: Blob;
}

export interface PersistedComposerTransfer {
  readonly token: string;
  readonly prompt: string;
  readonly files: ReadonlyArray<PersistedComposerTransferFile>;
  readonly stagedAt: number;
}

export interface ComposerTransferPersistence {
  readonly write: (transfer: PersistedComposerTransfer) => Promise<void>;
  readonly read: (token: string) => Promise<PersistedComposerTransfer | null>;
  readonly remove: (token: string) => Promise<void>;
}

const DATABASE_NAME = "t3code:composer-transfers";
const DATABASE_VERSION = 1;
const STORE_NAME = "transfers";

let databasePromise: Promise<IDBDatabase> | null = null;

function openDatabase(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is unavailable in this browser context."));
      return;
    }
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.addEventListener("upgradeneeded", () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
    });
    request.addEventListener("error", () => {
      databasePromise = null;
      reject(request.error ?? new Error("Could not open composer transfer storage."));
    });
    request.addEventListener("blocked", () => {
      databasePromise = null;
      reject(new Error("Composer transfer storage upgrade was blocked."));
    });
    request.addEventListener("success", () => {
      const database = request.result;
      database.addEventListener("versionchange", () => {
        database.close();
        databasePromise = null;
      });
      resolve(database);
    });
  });
  return databasePromise;
}

async function writeTransfer(transfer: PersistedComposerTransfer): Promise<void> {
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.addEventListener("complete", () => resolve());
    transaction.addEventListener("error", () => {
      reject(transaction.error ?? new Error("Could not persist composer transfer."));
    });
    transaction.addEventListener("abort", () => {
      reject(transaction.error ?? new Error("Persisting composer transfer was aborted."));
    });
    transaction.objectStore(STORE_NAME).put(transfer, transfer.token);
  });
}

async function readTransfer(token: string): Promise<PersistedComposerTransfer | null> {
  const database = await openDatabase();
  return await new Promise<PersistedComposerTransfer | null>((resolve, reject) => {
    const request = database.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(token);
    request.addEventListener("error", () => {
      reject(request.error ?? new Error("Could not read composer transfer."));
    });
    request.addEventListener("success", () => {
      const value: unknown = request.result;
      if (!value || typeof value !== "object") {
        resolve(null);
        return;
      }
      const candidate = value as Partial<PersistedComposerTransfer>;
      if (
        candidate.token !== token ||
        typeof candidate.prompt !== "string" ||
        typeof candidate.stagedAt !== "number" ||
        !Number.isFinite(candidate.stagedAt) ||
        !Array.isArray(candidate.files)
      ) {
        resolve(null);
        return;
      }
      const files: PersistedComposerTransferFile[] = [];
      for (const rawFile of candidate.files) {
        if (!rawFile || typeof rawFile !== "object") {
          resolve(null);
          return;
        }
        const file = rawFile as Partial<PersistedComposerTransferFile>;
        if (
          typeof file.name !== "string" ||
          typeof file.mimeType !== "string" ||
          typeof file.lastModified !== "number" ||
          !Number.isFinite(file.lastModified) ||
          !(file.blob instanceof Blob)
        ) {
          resolve(null);
          return;
        }
        files.push({
          name: file.name,
          mimeType: file.mimeType,
          lastModified: file.lastModified,
          blob: file.blob,
        });
      }
      resolve({
        token,
        prompt: candidate.prompt,
        stagedAt: candidate.stagedAt,
        files,
      });
    });
  });
}

async function removeTransfer(token: string): Promise<void> {
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.addEventListener("complete", () => resolve());
    transaction.addEventListener("error", () => {
      reject(transaction.error ?? new Error("Could not remove composer transfer."));
    });
    transaction.addEventListener("abort", () => {
      reject(transaction.error ?? new Error("Removing composer transfer was aborted."));
    });
    transaction.objectStore(STORE_NAME).delete(token);
  });
}

export const indexedDbComposerTransferPersistence: ComposerTransferPersistence = {
  write: writeTransfer,
  read: readTransfer,
  remove: removeTransfer,
};
