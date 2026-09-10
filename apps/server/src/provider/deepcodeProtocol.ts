// @effect-diagnostics nodeBuiltinImport:off
/**
 * Deep Code CLI helpers: exec argv, session-index parsing, and settings auth.
 *
 * Headless turns are `deepcode --exec --prompt`. The CLI writes the final
 * assistant reply to stdout and persists the native session under
 * `~/.deepcode/projects/<projectCode>/sessions-index.json`.
 *
 * @module provider/deepcodeProtocol
 */
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { createModelCapabilities } from "@t3tools/shared/model";
import type { ServerProviderModel } from "@t3tools/contracts";

const MAX_PROJECT_CODE_LENGTH = 64;
const PROJECT_CODE_HASH_LENGTH = 16;
const SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const DEEPCODE_EFFORTS = ["low", "high", "max"] as const;
export type DeepCodeEffort = (typeof DEEPCODE_EFFORTS)[number];

export const DEEPCODE_MODEL_CAPABILITIES = createModelCapabilities({
  optionDescriptors: [
    {
      id: "effort",
      label: "Effort",
      type: "select",
      currentValue: "max",
      options: [
        { id: "low", label: "Low", isDefault: false },
        { id: "high", label: "High", isDefault: false },
        { id: "max", label: "Max", isDefault: true },
      ],
    },
  ],
});

export const DEEPCODE_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "deepseek-flash",
    name: "DeepSeek Flash",
    isCustom: false,
    isDefault: true,
    capabilities: DEEPCODE_MODEL_CAPABILITIES,
  },
  {
    slug: "deepseek-v4-pro",
    name: "DeepSeek V4 Pro",
    isCustom: false,
    isDefault: false,
    capabilities: DEEPCODE_MODEL_CAPABILITIES,
  },
  {
    slug: "deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    isCustom: false,
    isDefault: false,
    capabilities: DEEPCODE_MODEL_CAPABILITIES,
  },
  {
    slug: "deepseek-v4-flash-vision-exp",
    name: "DeepSeek V4 Flash Vision",
    isCustom: false,
    isDefault: false,
    capabilities: DEEPCODE_MODEL_CAPABILITIES,
  },
];

export function isDeepCodeSessionId(value: string): boolean {
  return SESSION_ID_PATTERN.test(value);
}

export function isDeepCodeEffort(value: string): value is DeepCodeEffort {
  return (DEEPCODE_EFFORTS as ReadonlyArray<string>).includes(value);
}

/** Match Deep Code's project folder name under `~/.deepcode/projects`. */
export function deepCodeProjectCode(
  projectRoot: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const normalizedRoot = NodePath.resolve(projectRoot);
  const legacyCode = normalizedRoot.replace(/[\\/]/g, "-").replace(/:/g, "");
  if (legacyCode.length <= MAX_PROJECT_CODE_LENGTH) return legacyCode;

  const hashInput = platform === "win32" ? normalizedRoot.toLowerCase() : normalizedRoot;
  const hash = NodeCrypto.createHash("sha256")
    .update(hashInput)
    .digest("hex")
    .slice(0, PROJECT_CODE_HASH_LENGTH);
  const prefixLimit = MAX_PROJECT_CODE_LENGTH - PROJECT_CODE_HASH_LENGTH - 1;
  const prefix =
    sanitizeProjectCodePart(NodePath.basename(normalizedRoot))
      .slice(0, prefixLimit)
      .replace(/[-.]+$/g, "") || "project";
  return `${prefix}-${hash}`;
}

function sanitizeProjectCodePart(value: string): string {
  return value
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
}

export function deepCodeHomeDir(environment: NodeJS.ProcessEnv): string {
  return environment.HOME || environment.USERPROFILE || NodeOS.homedir();
}

export function deepCodeSettingsPath(homeDir: string): string {
  return NodePath.join(homeDir, ".deepcode", "settings.json");
}

export function deepCodeSessionsIndexPath(homeDir: string, projectRoot: string): string {
  return NodePath.join(
    homeDir,
    ".deepcode",
    "projects",
    deepCodeProjectCode(projectRoot),
    "sessions-index.json",
  );
}

export interface DeepCodeSessionIndexEntry {
  readonly id: string;
  readonly updateTime: string;
}

export function parseDeepCodeSessionsIndex(raw: string): ReadonlyArray<DeepCodeSessionIndexEntry> {
  try {
    const parsed: unknown = JSON.parse(raw);
    const entries =
      parsed !== null &&
      typeof parsed === "object" &&
      "entries" in parsed &&
      Array.isArray((parsed as { entries: unknown }).entries)
        ? (parsed as { entries: unknown[] }).entries
        : [];
    const out: DeepCodeSessionIndexEntry[] = [];
    for (const entry of entries) {
      if (entry === null || typeof entry !== "object") continue;
      const id = "id" in entry && typeof entry.id === "string" ? entry.id.trim() : "";
      const updateTime =
        "updateTime" in entry && typeof entry.updateTime === "string" ? entry.updateTime : "";
      if (!isDeepCodeSessionId(id) || updateTime.length === 0) continue;
      out.push({ id, updateTime });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Choose the native session to resume next. Prefer the id we already hold
 * when it is still present; otherwise take the newest entry that appeared or
 * moved forward since the previous snapshot.
 */
export function pickDeepCodeSessionId(input: {
  readonly previous: ReadonlyArray<DeepCodeSessionIndexEntry>;
  readonly next: ReadonlyArray<DeepCodeSessionIndexEntry>;
  readonly resumeSessionId?: string | undefined;
}): string | undefined {
  if (
    input.resumeSessionId &&
    isDeepCodeSessionId(input.resumeSessionId) &&
    input.next.some((entry) => entry.id === input.resumeSessionId)
  ) {
    return input.resumeSessionId;
  }
  const previousById = new Map(input.previous.map((entry) => [entry.id, entry.updateTime]));
  const changed = input.next.filter((entry) => {
    const previous = previousById.get(entry.id);
    return previous === undefined || entry.updateTime > previous;
  });
  const pool = changed.length > 0 ? changed : input.next;
  let newest: DeepCodeSessionIndexEntry | undefined;
  for (const entry of pool) {
    if (!newest || entry.updateTime > newest.updateTime) newest = entry;
  }
  return newest?.id;
}

export function parseDeepCodeSettingsAuth(raw: string): {
  readonly hasApiKey: boolean;
  readonly model: string | null;
} {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") {
      return { hasApiKey: false, model: null };
    }
    const record = parsed as Record<string, unknown>;
    const env =
      record.env !== null && typeof record.env === "object"
        ? (record.env as Record<string, unknown>)
        : {};
    const envKey = typeof env.API_KEY === "string" ? env.API_KEY.trim() : "";
    const envModel = typeof env.MODEL === "string" ? env.MODEL.trim() : "";
    const topModel = typeof record.model === "string" ? record.model.trim() : "";
    return {
      hasApiKey: envKey.length > 0,
      model: topModel || envModel || null,
    };
  } catch {
    return { hasApiKey: false, model: null };
  }
}

export function buildDeepCodeExecArgs(input: {
  readonly prompt: string;
  readonly resumeSessionId?: string | undefined;
}): string[] {
  const args = ["--exec", "--prompt", input.prompt];
  if (input.resumeSessionId) args.push("--resume", input.resumeSessionId);
  return args;
}

export function buildDeepCodeTurnEnvironment(
  base: NodeJS.ProcessEnv,
  input: {
    readonly model?: string | undefined;
    readonly effort?: string | undefined;
  },
): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...base };
  if (input.model) next.DEEPCODE_MODEL = input.model;
  if (input.effort) next.DEEPCODE_REASONING_EFFORT = input.effort;
  return next;
}

export function sessionIdFromCursor(cursor: unknown): string | undefined {
  if (cursor === null || typeof cursor !== "object") return undefined;
  const sessionId =
    "sessionId" in cursor && typeof cursor.sessionId === "string" ? cursor.sessionId.trim() : "";
  return isDeepCodeSessionId(sessionId) ? sessionId : undefined;
}
