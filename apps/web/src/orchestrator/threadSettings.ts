import type { ProviderOptionSelection } from "@t3tools/contracts";

import type { ThreadSnapshot } from "./events";
import { soundsLike } from "./phonetics";
import {
  raisesPermissions,
  type ThreadSettingsChange,
  type ThreadSettingsPlan,
  type ThreadSettingsRequest,
} from "./tools";

/**
 * Validation and effect-timing for `update_thread_settings`.
 *
 * Split out from the React hook and kept pure so the parts that actually decide
 * something — whether a model exists, whether an effort value is legal, and
 * crucially *when* each change reaches the agent — can be pinned down in tests
 * without a provider registry or a live connection.
 *
 * The provider catalog is injected rather than imported: the real one is built
 * from the server's provider snapshots, and a fake one is three functions.
 */

export interface ProviderCatalog {
  /** Whether a provider instance id exists and is usable. */
  readonly hasInstance: (instanceId: string) => boolean;
  /**
   * Canonical slug for a requested model on an instance, or null when the
   * instance does not offer it. Passing `undefined` asks for the instance's
   * default, which is what a provider switch without an explicit model wants.
   *
   * Strictness is load-bearing. The app's picker-oriented resolver falls back
   * to the instance default when a model is not found, which is right for a
   * dropdown that must always land on something — but wired in here it meant
   * asking LANChat for "claude-opus-5" silently resolved to its own default,
   * matched the current model, and reported "already-set" while nothing had
   * changed. A model this instance does not have must come back null.
   */
  readonly resolveModel: (instanceId: string, model: string | undefined) => string | null;
  /** Slugs the instance offers, for saying what *is* available on a miss. */
  readonly listModels: (instanceId: string) => ReadonlyArray<string>;
  /**
   * Every configured instance offering this model. Lets a request for a model
   * that lives on a different provider become a provider switch rather than a
   * dead end — asking for "claude-opus-5" on a browser-bridge thread means the
   * user wants Claude, not an error.
   */
  readonly findModelAcrossInstances: (
    model: string,
  ) => ReadonlyArray<{ readonly instanceId: string; readonly model: string }>;
  /**
   * The provider's thinking-effort option, or null when it exposes none.
   * Claude calls the option `effort`, Codex `reasoningEffort`, and the legal
   * values differ per model — so both come from the catalog rather than a
   * hardcoded list that would drift.
   */
  readonly effortOption: (
    instanceId: string,
    model: string,
  ) => { readonly id: string; readonly values: ReadonlyArray<string> } | null;
}

export interface ThreadSettingsResolution {
  readonly plan: ThreadSettingsPlan;
  /** The selection to send with `thread.meta.update`, or null when unchanged. */
  readonly nextModelSelection: {
    readonly instanceId: string;
    readonly model: string;
    readonly options?: ReadonlyArray<ProviderOptionSelection>;
  } | null;
}

/**
 * Which fields reach a running agent, and which wait.
 *
 * This is not a preference — it is how the server behaves. A runtime-mode event
 * restarts the live provider session from its resume cursor, so it takes hold
 * at once. A model or option change is only cached against the thread and read
 * the next time a session is established, i.e. at the next turn. Interaction
 * mode is not even wired into the provider reactor; its only immediate effect
 * is that leaving agent mode stops further continuations being queued.
 */
const EFFECTIVE_ON: Record<ThreadSettingsChange["field"], ThreadSettingsChange["effectiveOn"]> = {
  accessMode: "immediately",
  model: "next-turn",
  provider: "next-turn",
  effort: "next-turn",
  interactionMode: "next-turn",
};

function change(
  field: ThreadSettingsChange["field"],
  from: string,
  to: string,
): ThreadSettingsChange {
  return { field, from, to, effectiveOn: EFFECTIVE_ON[field] };
}

export function resolveThreadSettings(input: {
  readonly thread: ThreadSnapshot;
  readonly current: {
    readonly instanceId: string;
    readonly model: string;
    readonly options: ReadonlyArray<ProviderOptionSelection>;
    readonly runtimeMode: string;
    readonly interactionMode: string;
  };
  readonly request: ThreadSettingsRequest;
  readonly catalog: ProviderCatalog;
}): ThreadSettingsResolution {
  const { current, request, catalog, thread } = input;
  const changes: Array<ThreadSettingsChange> = [];
  const rejections: Array<string> = [];
  const warnings: Array<string> = [];

  // ── Provider and model ──
  let targetInstance = request.provider ?? current.instanceId;
  let resolvedModel: string | null = null;

  if (request.provider !== undefined && !catalog.hasInstance(request.provider)) {
    rejections.push(
      `There is no provider called "${request.provider}" configured in this workspace.`,
    );
  } else if (request.provider !== undefined || request.model !== undefined) {
    resolvedModel = catalog.resolveModel(targetInstance, request.model);

    // The model is not on this instance. Before failing, check whether it is
    // simply on another one — which is the common case when a thread is on a
    // browser bridge and the user names an API model.
    if (resolvedModel === null && request.model !== undefined && request.provider === undefined) {
      const elsewhere = catalog.findModelAcrossInstances(request.model);
      const only = elsewhere[0];
      if (elsewhere.length === 1 && only !== undefined) {
        targetInstance = only.instanceId;
        resolvedModel = only.model;
      } else if (elsewhere.length > 1) {
        rejections.push(
          `"${request.model}" is available on ${elsewhere.map((entry) => entry.instanceId).join(", ")}. Ask which provider they want, then set provider as well as model.`,
        );
      }
    }

    if (resolvedModel === null && rejections.length === 0) {
      const available = catalog.listModels(targetInstance);
      rejections.push(
        request.model === undefined
          ? `Provider "${targetInstance}" has no models available.`
          : available.length > 0
            ? `"${request.model}" is not a model offered by "${targetInstance}". It offers: ${available.join(", ")}.`
            : `"${request.model}" is not a model offered by "${targetInstance}".`,
      );
    }

    if (resolvedModel !== null) {
      if (targetInstance !== current.instanceId) {
        changes.push(change("provider", current.instanceId, targetInstance));
        // Cross-provider moves are an explicit handoff server-side; they end
        // the current turn rather than failing, which the user should hear.
        if (thread.isWorking) {
          warnings.push("Moving it to a different provider ends the turn it is running now.");
        }
      }
      if (resolvedModel !== current.model) {
        changes.push(change("model", current.model, resolvedModel));
      }
    }
  }

  // ── Thinking effort ──
  let nextOptions: ReadonlyArray<ProviderOptionSelection> = current.options;
  if (request.effort !== undefined && rejections.length === 0) {
    const modelForOptions = resolvedModel ?? current.model;
    const option = catalog.effortOption(targetInstance, modelForOptions);
    if (option === null) {
      rejections.push(`"${targetInstance}" does not expose a thinking-effort setting.`);
    } else if (option.values.length > 0 && !option.values.includes(request.effort)) {
      rejections.push(
        `"${request.effort}" is not a valid effort for ${modelForOptions}. Valid values: ${option.values.join(", ")}.`,
      );
    } else {
      const before = current.options.find((entry) => entry.id === option.id);
      const beforeValue = before === undefined ? "default" : String(before.value);
      if (beforeValue !== request.effort) {
        changes.push(change("effort", beforeValue, request.effort));
      }
      nextOptions = [
        ...current.options.filter((entry) => entry.id !== option.id),
        { id: option.id, value: request.effort },
      ];
    }
  }

  // ── Access permissions ──
  let permissionsRaised = false;
  if (request.accessMode !== undefined && request.accessMode !== current.runtimeMode) {
    changes.push(change("accessMode", current.runtimeMode, request.accessMode));
    permissionsRaised = raisesPermissions(current.runtimeMode, request.accessMode);
  }

  // ── Interaction mode ──
  if (
    request.interactionMode !== undefined &&
    request.interactionMode !== current.interactionMode
  ) {
    changes.push(change("interactionMode", current.interactionMode, request.interactionMode));
    if (current.interactionMode === "agent" && request.interactionMode !== "agent") {
      // The one part of an interaction-mode change that is not deferred.
      warnings.push(
        "Taking it out of agent mode stops any follow-up turns that were queued, straight away.",
      );
    }
  }

  if (
    thread.isWorking &&
    changes.some((entry) => entry.effectiveOn === "next-turn") &&
    rejections.length === 0
  ) {
    warnings.push(
      `${thread.title} is mid-turn, so those changes apply to its next turn unless you ask to apply them now.`,
    );
  }

  const modelChanged = changes.some(
    (entry) => entry.field === "model" || entry.field === "provider" || entry.field === "effort",
  );

  return {
    plan: { changes, rejections, warnings, raisesPermissions: permissionsRaised },
    nextModelSelection: modelChanged
      ? {
          instanceId: targetInstance,
          model: resolvedModel ?? current.model,
          ...(nextOptions.length === 0 ? {} : { options: nextOptions }),
        }
      : null,
  };
}

/** One line for the settings-update marker message, when applying mid-turn. */
export function describeSettingsForPrompt(plan: ThreadSettingsPlan): string {
  return plan.changes.map((entry) => `${entry.field} → ${entry.to}`).join(", ");
}

/** Projection lag must not turn repeated tool calls into repeated prompt turns. */
export const SETTINGS_UPDATE_PROMPT_DEDUPE_MS = 30_000;

/**
 * Reserves one settings-update marker for a short idempotency window.
 *
 * The metadata command resolves before React receives the updated shell. A
 * voice model can therefore repeat the same call in that gap and see the same
 * plan twice. The commands themselves are idempotent; the marker message is
 * not — every copy becomes another user-visible, agent-facing turn. Mutating
 * the injected map makes the reservation atomic across overlapping calls.
 */
export function reserveSettingsUpdatePrompt(
  recent: Map<string, number>,
  key: string,
  nowMs: number,
  dedupeMs: number = SETTINGS_UPDATE_PROMPT_DEDUPE_MS,
): boolean {
  for (const [candidate, reservedAt] of recent) {
    if (nowMs - reservedAt >= dedupeMs) recent.delete(candidate);
  }
  if (recent.has(key)) return false;
  recent.set(key, nowMs);
  return true;
}

/**
 * Matches a spoken or typed model name against a provider's slugs.
 *
 * Exact first, then a form with separators and case flattened, so "claude opus
 * 5", "Claude-Opus-5" and "claude_opus_5" all reach `claude-opus-5`. Every
 * spelling used to hit the same silent default-fallback and come back
 * "already-set", which read as the change having been applied when it had not.
 *
 * Last, and only when nothing else matched, the same name read aloud: model
 * slugs are said as words ("claude opus five", "sonnet four point five") and
 * come back from the transcriber spelled as words. Kept strictly last so a
 * written slug can never lose to something that merely sounds like it, and
 * still `null` on a miss — picking the wrong model is a settings change, not a
 * lookup.
 */
export function matchModelSlug(slugs: ReadonlyArray<string>, requested: string): string | null {
  const wanted = requested.trim();
  const exact = slugs.find((slug) => slug === wanted);
  if (exact !== undefined) return exact;
  const flatten = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const target = flatten(wanted);
  if (target.length === 0) return null;
  const flattened = slugs.find((slug) => flatten(slug) === target);
  if (flattened !== undefined) return flattened;
  const spoken = numeralsAsWords(wanted);
  const heard = slugs.filter((slug) => soundsLike(spoken, numeralsAsWords(slug)));
  // Two slugs that sound alike is a real possibility across providers, and
  // there is nobody to ask from in here — fall through to "not matched".
  return heard.length === 1 ? (heard[0] ?? null) : null;
}

/** "5" and "five" are the same word out loud; only one of them is ever typed. */
const NUMERAL_WORDS: ReadonlyArray<string> = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
];

function numeralsAsWords(value: string): string {
  return value.replace(/\d/g, (digit) => ` ${NUMERAL_WORDS[Number(digit)] ?? digit} `);
}
