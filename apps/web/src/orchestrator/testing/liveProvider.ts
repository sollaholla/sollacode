// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  DEFAULT_XAI_REALTIME_VOICE,
  XAI_CLIENT_SECRET_TTL_SECONDS,
  XAI_REALTIME_CLIENT_SECRETS_URL,
  buildXaiRealtimeWebsocketUrl,
  xaiClientSecretProtocol,
} from "@t3tools/contracts";

import { normalizeRecordedFrame, type RecordedFrame } from "./recordingFormat";

/**
 * Talks to the real voice provider and brings back what it said.
 *
 * Everything else in this suite tests the session against frame sequences
 * someone wrote down. This is the part that checks those sequences are still
 * what the provider produces — which is the assumption that failed: every
 * hand-written case included an audio-done frame, and the session stuck on
 * "Speaking" forever the first time a real response ended without one.
 *
 * Only ever run deliberately. The tests that use it skip unless a key is
 * present, so the suite stays offline and deterministic by default.
 */

/** Where the desktop app keeps the orchestrator's configured key. */
const storedKeyPath = () =>
  NodePath.join(
    NodeOS.homedir(),
    ".solla-code",
    "userdata",
    "secrets",
    "orchestrator-xai-api-key.bin",
  );

/**
 * The key for this machine's orchestrator, or null if there is not one.
 *
 * Read from the environment first so a CI run can supply its own. Used only to
 * mint an ephemeral secret against xAI; it is never written to a recording, a
 * log line, or an assertion message.
 */
export async function readLiveApiKey(): Promise<string | null> {
  const fromEnv = process.env.XAI_API_KEY?.trim();
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  const stored = await NodeFSP.readFile(storedKeyPath(), "utf8").catch(() => "");
  const trimmed = stored.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function mintLiveClientSecret(apiKey: string): Promise<string> {
  const response = await fetch(XAI_REALTIME_CLIENT_SECRETS_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ expires_after: { seconds: XAI_CLIENT_SECRET_TTL_SECONDS } }),
  });
  if (!response.ok) {
    // Deliberately does not echo the request: it carries the key.
    throw new Error(`minting a client secret failed with HTTP ${response.status}`);
  }
  const payload = (await response.json()) as {
    value?: string;
    client_secret?: { value?: string };
  };
  const value = payload.value ?? payload.client_secret?.value;
  if (value === undefined || value.length === 0) {
    throw new Error("the client-secret response carried no secret");
  }
  return value;
}

export interface LiveTurn {
  readonly frames: ReadonlyArray<RecordedFrame>;
  /** Every frame type the provider used, for coverage reporting. */
  readonly types: ReadonlyArray<string>;
}

/**
 * Runs one turn against the provider and records every frame it sent.
 *
 * A text turn rather than uploaded audio: it produces the same output frames —
 * which is all the session's state machine consumes — while staying short,
 * repeatable, and free of a recorded voice.
 */
export async function recordLiveTurn(input: {
  readonly clientSecret: string;
  readonly model: string;
  readonly prompt: string;
  readonly timeoutMs?: number;
}): Promise<LiveTurn> {
  const timeoutMs = input.timeoutMs ?? 60_000;
  const socket = new WebSocket(buildXaiRealtimeWebsocketUrl(input.model), [
    xaiClientSecretProtocol(input.clientSecret),
  ]);
  const frames: RecordedFrame[] = [];
  const openedAt = Date.now();

  const collected = await new Promise<ReadonlyArray<RecordedFrame>>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // Already closing.
      }
      if (error === undefined) resolve(frames);
      else reject(error);
    };
    const timer = setTimeout(
      () => finish(new Error(`no response.done within ${timeoutMs}ms`)),
      timeoutMs,
    );

    socket.addEventListener("open", () => {
      socket.send(
        JSON.stringify({
          type: "session.update",
          session: {
            type: "realtime",
            model: input.model,
            audio: {
              input: { format: { type: "audio/pcm", rate: 24_000 } },
              output: {
                format: { type: "audio/pcm", rate: 24_000 },
                voice: DEFAULT_XAI_REALTIME_VOICE,
              },
            },
          },
        }),
      );
      socket.send(
        JSON.stringify({
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: input.prompt }],
          },
        }),
      );
      socket.send(JSON.stringify({ type: "response.create" }));
    });

    socket.addEventListener("message", (event: MessageEvent) => {
      const data = typeof event.data === "string" ? event.data : "";
      if (data.length === 0) return;
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(data) as Record<string, unknown>;
      } catch {
        return;
      }
      frames.push(normalizeRecordedFrame(Date.now() - openedAt, frame));
      if (frame.type === "response.done") finish();
      if (frame.type === "error") {
        const detail = (frame.error as { message?: string } | undefined)?.message ?? "unknown";
        finish(new Error(`the provider reported: ${detail}`));
      }
    });

    socket.addEventListener("error", () => finish(new Error("the realtime socket errored")));
    socket.addEventListener("close", (event: CloseEvent) => {
      if (frames.length === 0) {
        finish(new Error(`the socket closed before any frame arrived (code ${event.code})`));
      }
    });
  });

  return {
    frames: collected,
    types: [...new Set(collected.map((entry) => String(entry.frame.type)))],
  };
}

export const RECORDINGS_DIR = NodePath.join(import.meta.dirname, "recordings");

export async function writeRecording(name: string, recording: unknown): Promise<string> {
  await NodeFSP.mkdir(RECORDINGS_DIR, { recursive: true });
  const file = NodePath.join(RECORDINGS_DIR, name);
  await NodeFSP.writeFile(file, `${JSON.stringify(recording, null, 2)}\n`, "utf8");
  return file;
}

export async function readRecordings(): Promise<ReadonlyArray<{ name: string; json: unknown }>> {
  const names = await NodeFSP.readdir(RECORDINGS_DIR).catch(() => [] as string[]);
  const out: Array<{ name: string; json: unknown }> = [];
  for (const name of names.filter((entry) => entry.endsWith(".json")).sort()) {
    const raw = await NodeFSP.readFile(NodePath.join(RECORDINGS_DIR, name), "utf8");
    out.push({ name, json: JSON.parse(raw) as unknown });
  }
  return out;
}
