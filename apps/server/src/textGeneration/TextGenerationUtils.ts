import { TextGenerationError } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const isTextGenerationError = Schema.is(TextGenerationError);

/** Convert an Effect Schema to a flat JSON Schema object, inlining `$defs` when present. */
export function toJsonSchemaObject(schema: Schema.Top): unknown {
  const document = Schema.toJsonSchemaDocument(schema);
  if (document.definitions && Object.keys(document.definitions).length > 0) {
    return { ...document.schema, $defs: document.definitions };
  }
  return document.schema;
}

function flattenJsonSchemaAllOf(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(flattenJsonSchemaAllOf);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }

  const source = value as Record<string, unknown>;
  const flattened = Object.fromEntries(
    Object.entries(source)
      .filter(([key]) => key !== "allOf")
      .map(([key, entry]) => [key, flattenJsonSchemaAllOf(entry)]),
  );
  if (!Array.isArray(source.allOf)) {
    return flattened;
  }

  // Effect Schema represents stacked refinements (for example an integer with
  // both minimum and maximum checks) as `allOf`. Codex structured outputs do
  // not accept that keyword, but do accept the same validation keywords on the
  // schema node itself. Effect's refinement fragments are independent objects,
  // so a shallow merge preserves their conjunction without weakening it.
  for (const conjunct of source.allOf) {
    const normalized = flattenJsonSchemaAllOf(conjunct);
    if (normalized !== null && typeof normalized === "object" && !Array.isArray(normalized)) {
      Object.assign(flattened, normalized);
    }
  }
  return flattened;
}

/** Convert Effect Schema output to the strict JSON-Schema subset accepted by Codex. */
export function toCodexJsonSchemaObject(schema: Schema.Top): unknown {
  return flattenJsonSchemaAllOf(toJsonSchemaObject(schema));
}

/** Truncate a text section to `maxChars`, appending a `[truncated]` marker when needed. */
export function limitSection(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const truncated = value.slice(0, maxChars);
  return `${truncated}\n\n[truncated]`;
}

/** Normalise a raw commit subject to imperative-mood, ≤72 chars, no trailing period. */
export function sanitizeCommitSubject(raw: string): string {
  const singleLine = raw.trim().split(/\r?\n/g)[0]?.trim() ?? "";
  const withoutTrailingPeriod = singleLine.replace(/[.]+$/g, "").trim();
  if (withoutTrailingPeriod.length === 0) {
    return "Update project files";
  }

  if (withoutTrailingPeriod.length <= 72) {
    return withoutTrailingPeriod;
  }
  return withoutTrailingPeriod.slice(0, 72).trimEnd();
}

/** Normalise a raw PR title to a single line with a sensible fallback. */
export function sanitizePrTitle(raw: string): string {
  const singleLine = raw.trim().split(/\r?\n/g)[0]?.trim() ?? "";
  if (singleLine.length > 0) {
    return singleLine;
  }
  return "Update project changes";
}

/** Normalise a raw thread title to a compact single-line sidebar-safe label. */
export function sanitizeThreadTitle(raw: string): string {
  const normalized = raw
    .trim()
    .split(/\r?\n/g)[0]
    ?.trim()
    .replace(/^['"`]+|['"`]+$/g, "")
    .trim()
    .replace(/\s+/g, " ");

  if (!normalized || normalized.trim().length === 0) {
    return "New thread";
  }

  if (normalized.length <= 50) {
    return normalized;
  }

  return `${normalized.slice(0, 47).trimEnd()}...`;
}

export function sanitizeCorrectedVoiceTranscript(generated: string, original: string): string {
  const corrected = generated.trim();
  if (corrected.length === 0 || corrected.length > 8_000) return original;
  return corrected;
}

const PLAN_REFRESH_MAX_STEPS = 40;
const PLAN_REFRESH_MAX_STEP_CHARS = 200;

/**
 * Normalizes a generated task list before it replaces the visible plan.
 *
 * The model is asked for a bounded, well-formed list, but the plan panel is
 * user-facing state and a bad generation should degrade rather than corrupt it:
 * blank steps are dropped, runaway text is truncated, and the count is capped.
 * More than one `inProgress` is collapsed to the first, since the panel's whole
 * reading is "this is the thing being worked on now".
 */
export function sanitizePlanRefreshSteps(
  raw: ReadonlyArray<{ step: string; status: "pending" | "inProgress" | "completed" }>,
): ReadonlyArray<{ step: string; status: "pending" | "inProgress" | "completed" }> {
  const steps: Array<{ step: string; status: "pending" | "inProgress" | "completed" }> = [];
  let seenInProgress = false;

  for (const entry of raw) {
    const text = entry.step.replace(/\s+/g, " ").trim();
    if (text.length === 0) continue;

    const step =
      text.length <= PLAN_REFRESH_MAX_STEP_CHARS
        ? text
        : `${text.slice(0, PLAN_REFRESH_MAX_STEP_CHARS - 3).trimEnd()}...`;

    let status = entry.status;
    if (status === "inProgress") {
      if (seenInProgress) status = "pending";
      else seenInProgress = true;
    }

    steps.push({ step, status });
    if (steps.length >= PLAN_REFRESH_MAX_STEPS) break;
  }

  return steps;
}

/** CLI name to human-readable label, e.g. "codex" → "Codex CLI (`codex`)" */
function cliLabel(cliName: string): string {
  const capitalized = cliName.charAt(0).toUpperCase() + cliName.slice(1);
  return `${capitalized} CLI (\`${cliName}\`)`;
}

/**
 * Normalize an unknown error from a CLI text generation process into a
 * typed `TextGenerationError`. Parameterized by CLI name so both Codex
 * and Claude (and future providers) can share the same logic.
 */
export function normalizeCliError(
  cliName: string,
  operation: string,
  error: unknown,
  fallback: string,
): TextGenerationError {
  if (isTextGenerationError(error)) {
    return error;
  }

  if (error instanceof Error) {
    const lower = error.message.toLowerCase();
    if (
      error.message.includes(`Command not found: ${cliName}`) ||
      lower.includes(`spawn ${cliName}`) ||
      lower.includes("enoent")
    ) {
      return new TextGenerationError({
        operation,
        detail: `${cliLabel(cliName)} is required but not available on PATH.`,
        cause: error,
      });
    }
    return new TextGenerationError({
      operation,
      detail: fallback,
      cause: error,
    });
  }

  return new TextGenerationError({
    operation,
    detail: fallback,
    cause: error,
  });
}
