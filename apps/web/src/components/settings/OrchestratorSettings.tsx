import { useRef, useState } from "react";
import {
  DEFAULT_UNIFIED_SETTINGS,
  ORCHESTRATOR_VOICE_PROVIDERS,
  type OrchestratorActivationMode,
  type OrchestratorAuthority,
  type OrchestratorVoiceProvider,
  resolveOrchestratorVoiceSelection,
} from "@t3tools/contracts";
import { AudioLinesIcon, CheckIcon } from "lucide-react";

import { useAtomValue } from "@effect/atom-react";

import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { useOrchestratorSessionContext } from "../../orchestrator/OrchestratorSessionProvider";
import { isEchoProneDevice } from "../../orchestrator/echoProneDevice";
import { OrchestratorUsageView } from "./OrchestratorUsageView";
import { shortcutLabelForCommand } from "../../keybindings";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";

const ACTIVATION_OPTIONS: Record<OrchestratorActivationMode, { label: string; hint: string }> = {
  toggle: {
    // Not "press to talk": this is a start/stop toggle for a whole
    // conversation, not a held key for one utterance. The app's *dictation*
    // feature is the hold-a-key one, and conflating the two sends people
    // hunting for a shortcut that does something else.
    label: "Start and stop manually",
    hint: "The microphone opens when you start a session and stays open until you stop it.",
  },
  "wake-word": {
    label: "Wake word",
    hint: "Listens continuously for the wake word. The microphone stays open.",
  },
};

/**
 * Modes the picker actually offers.
 *
 * `wake-word` is a valid persisted value — the contract keeps it so any settings
 * file that already carries it still decodes — but always-on detection is not
 * implemented yet, and selecting it would silently behave as press-to-talk.
 * Offering a control that does nothing is worse than offering fewer controls, so
 * it stays out of the list until the detector ships.
 */
const SELECTABLE_ACTIVATION_MODES: ReadonlyArray<OrchestratorActivationMode> = ["toggle"];

/**
 * Languages the picker offers. The contract stores any ISO-639-1 code (typed
 * via "Other" workflows would still decode), but a curated list keeps the
 * control honest: each of these is a code the Realtime transcription model
 * accepts as a language hint.
 */
const LANGUAGE_OPTIONS: ReadonlyArray<{ code: string; label: string }> = [
  { code: "en", label: "English" },
  { code: "es", label: "Spanish" },
  { code: "fr", label: "French" },
  { code: "de", label: "German" },
  { code: "it", label: "Italian" },
  { code: "pt", label: "Portuguese" },
  { code: "nl", label: "Dutch" },
  { code: "ja", label: "Japanese" },
  { code: "ko", label: "Korean" },
  { code: "zh", label: "Chinese" },
  { code: "hi", label: "Hindi" },
  { code: "ru", label: "Russian" },
  { code: "ar", label: "Arabic" },
];

const AUTHORITY_OPTIONS: Record<OrchestratorAuthority, { label: string; hint: string }> = {
  "read-only": {
    label: "Read only",
    hint: "Can answer questions about your threads but cannot change anything.",
  },
  send: {
    label: "Send messages",
    hint: "Can also write messages into your threads.",
  },
  full: {
    label: "Full control",
    hint: "Can also interrupt turns, stop tasks, answer approvals and settle threads.",
  },
};

const SPOKEN_EVENT_ROWS = [
  {
    key: "threadFinished",
    title: "Thread finished",
    description: "Speak up when a thread finishes its turn.",
  },
  {
    key: "approvalNeeded",
    title: "Approval needed",
    description: "Speak up when a thread is blocked waiting for you to approve something.",
  },
  {
    key: "inputNeeded",
    title: "Input needed",
    description: "Speak up when a thread is blocked waiting for an answer.",
  },
  {
    key: "threadFailed",
    title: "Thread failed",
    description: "Speak up when a turn ends in an error.",
  },
  {
    key: "taskCompleted",
    title: "Background task completed",
    description: "Speak up when a long-running background task finishes. Noisier than the rest.",
  },
  {
    key: "autoResumeStuck",
    title: "Auto-resume stuck",
    description: "Speak up when an agent auto-resume has been pending unusually long.",
  },
] as const;

/**
 * Realtime models the picker offers.
 *
 * A free-text field here meant a typo was saved happily and only failed later,
 * at token-mint time, leaving the settings page showing a model the agent was
 * demonstrably not using. Only `gpt-realtime-2` and newer accept a reasoning
 * block, which is why the family matters and not just the name.
 */
const PROVIDER_OPTIONS: ReadonlyArray<{
  id: OrchestratorVoiceProvider;
  label: string;
}> = [
  { id: "openai", label: ORCHESTRATOR_VOICE_PROVIDERS.openai.label },
  { id: "xai", label: "Grok (xAI)" },
];

export function OrchestratorSettingsPanel() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const openAiApiKeyRef = useRef<HTMLInputElement>(null);
  const xaiApiKeyRef = useRef<HTMLInputElement>(null);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const voiceShortcutLabel = shortcutLabelForCommand(keybindings, "orchestrator.voice.toggle");
  const [apiKeySaved, setApiKeySaved] = useState<OrchestratorVoiceProvider | null>(null);

  const orchestrator = settings.orchestrator;
  const defaults = DEFAULT_UNIFIED_SETTINGS.orchestrator;
  const voice = useOrchestratorSessionContext();
  const catalog = ORCHESTRATOR_VOICE_PROVIDERS[orchestrator.provider];
  const interruptionForcedOff = orchestrator.interruptWhileSpeaking && isEchoProneDevice();

  // A value already in settings that is not in the list stays selectable, so
  // upgrading the app never silently rewrites someone's configured model.
  const catalogModels = catalog.models as ReadonlyArray<string>;
  const catalogVoices = catalog.voices as ReadonlyArray<string>;
  const modelOptions = catalogModels.includes(orchestrator.model)
    ? catalogModels
    : [orchestrator.model, ...catalogModels];
  const voiceOptions = catalogVoices.includes(orchestrator.voice)
    ? catalogVoices
    : [orchestrator.voice, ...catalogVoices];

  const applyRealtime = (patch: {
    provider?: OrchestratorVoiceProvider;
    model?: string;
    voice?: string;
  }) => {
    if (voice) void voice.applyOrchestratorRealtime(patch);
    else updateSettings({ orchestrator: patch });
  };

  const switchProvider = (next: OrchestratorVoiceProvider) => {
    if (next === orchestrator.provider) return;
    const resolved = resolveOrchestratorVoiceSelection({
      provider: next,
      model: orchestrator.model,
      voice: orchestrator.voice,
    });
    applyRealtime({ provider: next, ...resolved });
  };

  // Changing this now restarts a live session, so there is no drift to report
  // and no instruction to give. The status used to nag — "still running on X,
  // stop and start voice to switch" — permanently, which read as a warning
  // about the whole feature rather than a note about one setting.
  const activeModel = voice?.activeModel ?? null;
  const modelStatus =
    activeModel === null
      ? "Used for voice only. Typed chat uses the model picked in the composer."
      : `Voice is running on ${activeModel}. Typed chat uses the model picked in the composer.`;

  const saveApiKey = (provider: OrchestratorVoiceProvider) => {
    const input = provider === "xai" ? xaiApiKeyRef.current : openAiApiKeyRef.current;
    const value = input?.value.trim() ?? "";
    updateSettings({
      orchestrator: provider === "xai" ? { xaiApiKey: value } : { openAiApiKey: value },
    });
    if (input) input.value = "";
    setApiKeySaved(provider);
    window.setTimeout(
      () => setApiKeySaved((current) => (current === provider ? null : current)),
      2_000,
    );
  };

  return (
    <SettingsPageContainer>
      <SettingsSection title="Orchestrator" icon={<AudioLinesIcon className="size-5" />}>
        <SettingsRow
          title="Enable the orchestrator"
          description="A single agent that spans every thread in this workspace. Talk to it by voice, or type to it in its own thread."
          control={
            <Switch
              checked={orchestrator.enabled}
              onCheckedChange={(checked) =>
                updateSettings({ orchestrator: { enabled: Boolean(checked) } })
              }
              aria-label="Enable the orchestrator"
            />
          }
        />

        <SettingsRow
          title="Voice provider"
          description="Which realtime backend the orchestrator speaks through. OpenAI uses WebRTC. Grok uses xAI's Speech-to-Speech API."
          resetAction={
            orchestrator.provider !== defaults.provider ? (
              <SettingResetButton
                label="provider"
                onClick={() => switchProvider(defaults.provider)}
              />
            ) : null
          }
          control={
            <Select
              value={orchestrator.provider}
              onValueChange={(value) => {
                if (value === "openai" || value === "xai") switchProvider(value);
              }}
            >
              <SelectTrigger className="w-full sm:w-56" aria-label="Voice provider">
                <SelectValue>
                  {PROVIDER_OPTIONS.find((option) => option.id === orchestrator.provider)?.label ??
                    orchestrator.provider}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {PROVIDER_OPTIONS.map((option) => (
                  <SelectItem key={option.id} hideIndicator value={option.id}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />

        <SettingsRow
          title="OpenAI API key"
          description="Used only for OpenAI speech-to-speech. Stored on this server and never sent back to any client."
          status={
            orchestrator.openAiApiKeyConfigured
              ? "A key is configured."
              : "No key configured — OpenAI voice will not start."
          }
          control={
            <div className="flex w-full items-center gap-2 sm:w-auto">
              <Input
                ref={openAiApiKeyRef}
                type="password"
                autoComplete="off"
                placeholder={orchestrator.openAiApiKeyConfigured ? "Replace key" : "sk-…"}
                className="w-full sm:w-56"
                aria-label="OpenAI API key"
                onKeyDown={(event) => {
                  if (event.key === "Enter") saveApiKey("openai");
                }}
              />
              <Button type="button" variant="outline" onClick={() => saveApiKey("openai")}>
                {apiKeySaved === "openai" ? <CheckIcon className="size-4" /> : "Save"}
              </Button>
            </div>
          }
        >
          {orchestrator.openAiApiKeyConfigured ? (
            <div className="pb-3.5">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-muted-foreground"
                onClick={() => {
                  if (!window.confirm("Remove the stored OpenAI API key?")) return;
                  updateSettings({ orchestrator: { openAiApiKey: "" } });
                }}
              >
                Remove stored key
              </Button>
            </div>
          ) : null}
        </SettingsRow>

        <SettingsRow
          title="Grok Voice API key"
          description="Used only for Grok Voice through xAI. Stored on this server and never sent back to any client. If empty, the server uses XAI_API_KEY when it is set."
          status={
            orchestrator.xaiApiKeyConfigured
              ? "A key is configured."
              : "No key configured — Grok voice will not start."
          }
          control={
            <div className="flex w-full items-center gap-2 sm:w-auto">
              <Input
                ref={xaiApiKeyRef}
                type="password"
                autoComplete="off"
                placeholder={orchestrator.xaiApiKeyConfigured ? "Replace key" : "xai-…"}
                className="w-full sm:w-56"
                aria-label="Grok Voice API key"
                onKeyDown={(event) => {
                  if (event.key === "Enter") saveApiKey("xai");
                }}
              />
              <Button type="button" variant="outline" onClick={() => saveApiKey("xai")}>
                {apiKeySaved === "xai" ? <CheckIcon className="size-4" /> : "Save"}
              </Button>
            </div>
          }
        >
          {orchestrator.xaiApiKeyConfigured ? (
            <div className="pb-3.5">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-muted-foreground"
                onClick={() => {
                  if (!window.confirm("Remove the stored Grok Voice API key?")) return;
                  updateSettings({ orchestrator: { xaiApiKey: "" } });
                }}
              >
                Remove stored key
              </Button>
            </div>
          ) : null}
        </SettingsRow>

        <SettingsRow
          title="Voice"
          description={
            orchestrator.provider === "xai"
              ? "Which Grok Voice the orchestrator speaks with. Custom 8-character voice IDs can be typed if you have cloned one."
              : "Which OpenAI Realtime voice the orchestrator speaks with."
          }
          resetAction={
            orchestrator.voice !== catalog.defaultVoice ? (
              <SettingResetButton
                label="voice"
                onClick={() => applyRealtime({ voice: catalog.defaultVoice })}
              />
            ) : null
          }
          control={
            orchestrator.provider === "xai" ? (
              <Select
                value={orchestrator.voice}
                onValueChange={(value) => {
                  if (
                    typeof value === "string" &&
                    value.length > 0 &&
                    value !== orchestrator.voice
                  ) {
                    applyRealtime({ voice: value });
                  }
                }}
              >
                <SelectTrigger className="w-full sm:w-56" aria-label="Orchestrator voice">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  {voiceOptions.map((option) => (
                    <SelectItem key={option} value={option}>
                      {option}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            ) : (
              <Input
                key={orchestrator.voice}
                defaultValue={orchestrator.voice}
                className="w-full sm:w-56"
                aria-label="Orchestrator voice"
                onBlur={(event) => {
                  const next = event.target.value.trim();
                  if (next && next !== orchestrator.voice) {
                    applyRealtime({ voice: next });
                  }
                }}
              />
            )
          }
        />

        <SettingsRow
          title="Language"
          description="The language the orchestrator listens for and answers in. Without a pin the model guesses from the audio — and it guesses wrong."
          resetAction={
            orchestrator.language !== defaults.language ? (
              <SettingResetButton
                label="language"
                onClick={() => updateSettings({ orchestrator: { language: defaults.language } })}
              />
            ) : null
          }
          control={
            <Select
              value={orchestrator.language}
              onValueChange={(value) => {
                if (typeof value === "string" && value.length > 0) {
                  updateSettings({ orchestrator: { language: value } });
                }
              }}
            >
              <SelectTrigger className="w-full sm:w-56" aria-label="Orchestrator language">
                <SelectValue>
                  {LANGUAGE_OPTIONS.find((option) => option.code === orchestrator.language)
                    ?.label ?? orchestrator.language}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {LANGUAGE_OPTIONS.map((option) => (
                  <SelectItem key={option.code} hideIndicator value={option.code}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />

        <SettingsRow
          title="Floating bubble"
          description="Keep a small always-on-top orb on screen. It swells as you and the orchestrator speak; click it to open the orchestrator, drag it anywhere."
          control={
            <Switch
              checked={orchestrator.floatingBubble}
              onCheckedChange={(checked) =>
                updateSettings({ orchestrator: { floatingBubble: Boolean(checked) } })
              }
              aria-label="Floating bubble"
            />
          }
        />

        <SettingsRow
          title="Model"
          description={
            orchestrator.provider === "xai"
              ? "The Grok Voice model used for spoken conversation. It does not affect typing to the orchestrator — its thread picks a model in the composer, like any other thread."
              : "The OpenAI Realtime model used for spoken conversation. It does not affect typing to the orchestrator — its thread picks a model in the composer, like any other thread."
          }
          status={modelStatus}
          resetAction={
            orchestrator.model !== catalog.defaultModel ? (
              <SettingResetButton
                label="model"
                onClick={() => applyRealtime({ model: catalog.defaultModel })}
              />
            ) : null
          }
          control={
            <Select
              value={orchestrator.model}
              onValueChange={(value) => {
                if (typeof value !== "string" || value === orchestrator.model) return;
                applyRealtime({ model: value });
              }}
            >
              <SelectTrigger className="w-full sm:w-56" aria-label="Orchestrator model">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {modelOptions.map((option) => (
                  <SelectItem key={option} value={option}>
                    {option}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
      </SettingsSection>

      <SettingsSection title="Interruptions">
        <SettingsRow
          title="Let me interrupt by talking over it"
          description={
            interruptionForcedOff
              ? "Your saved preference is on, but interruption is paused on this handheld because its speaker is close enough to the microphone to make the orchestrator hear and answer itself. The microphone reopens as soon as it finishes speaking; headphones or a desktop can use talk-over interruption."
              : "On: you can cut the orchestrator off mid-sentence by speaking, and the microphone stays open the whole time. Off: it always finishes what it is saying, and the microphone is closed while it speaks — which is the only reliable way to stop it hearing its own voice through a speaker and answering itself. Turn this off if it keeps interrupting itself or replying to things you did not say."
          }
          status={
            interruptionForcedOff ? "Paused on this handheld to prevent echo loops" : undefined
          }
          control={
            <Switch
              checked={orchestrator.interruptWhileSpeaking}
              onCheckedChange={(checked) =>
                updateSettings({ orchestrator: { interruptWhileSpeaking: Boolean(checked) } })
              }
              aria-label="Let me interrupt"
            />
          }
        />
      </SettingsSection>

      <SettingsSection title="Microphone">
        <SettingsRow
          title="Filter background noise"
          description="Runs your microphone through a noise gate before it is sent, so fans, traffic and typing are held down between the things you actually say. Your browser's own speech isolation is always used where it exists; this is an extra stage on top of it. Off by default: it sits in the outgoing audio, so if you sound clipped or quiet words go missing, turn it back off."
          control={
            <Switch
              checked={orchestrator.voiceIsolation}
              onCheckedChange={(checked) =>
                updateSettings({ orchestrator: { voiceIsolation: Boolean(checked) } })
              }
              aria-label="Filter background noise"
            />
          }
        />
      </SettingsSection>

      <SettingsSection title="Usage">
        <SettingsRow
          title="Stop listening after silence"
          description="Close the voice session automatically when nobody has spoken for a while. A realtime session bills for streamed silence, and an open microphone left running is a cost as well as a surprise."
          control={
            <Switch
              checked={orchestrator.autoDisableOnSilence}
              onCheckedChange={(checked) =>
                updateSettings({ orchestrator: { autoDisableOnSilence: Boolean(checked) } })
              }
              aria-label="Stop listening after silence"
            />
          }
        />

        {orchestrator.autoDisableOnSilence ? (
          <SettingsRow
            title="Silence before stopping"
            description="Seconds of complete silence — from you and from the orchestrator — before the microphone closes. It never cuts off mid-sentence."
            resetAction={
              orchestrator.silenceTimeoutSeconds !== defaults.silenceTimeoutSeconds ? (
                <SettingResetButton
                  label="timeout"
                  onClick={() =>
                    updateSettings({
                      orchestrator: { silenceTimeoutSeconds: defaults.silenceTimeoutSeconds },
                    })
                  }
                />
              ) : null
            }
            control={
              <Input
                key={orchestrator.silenceTimeoutSeconds}
                type="number"
                min={5}
                max={600}
                defaultValue={orchestrator.silenceTimeoutSeconds}
                className="w-full sm:w-24"
                aria-label="Silence before stopping"
                onBlur={(event) => {
                  const next = Number.parseInt(event.target.value, 10);
                  if (
                    Number.isFinite(next) &&
                    next >= 5 &&
                    next <= 600 &&
                    next !== orchestrator.silenceTimeoutSeconds
                  ) {
                    updateSettings({ orchestrator: { silenceTimeoutSeconds: next } });
                  }
                }}
              />
            }
          />
        ) : null}

        {orchestrator.autoDisableOnSilence ? (
          <SettingsRow
            title="Come back when awaited work finishes"
            description="If the microphone closes on silence while the orchestrator is waiting on work it said it would report back on, reopen it and deliver the answer. Only for work it dispatched itself, only within half an hour of asking, and never after you stop voice by hand."
            control={
              <Switch
                checked={orchestrator.wakeOnAwaitedResult}
                onCheckedChange={(checked) =>
                  updateSettings({ orchestrator: { wakeOnAwaitedResult: Boolean(checked) } })
                }
                aria-label="Come back when awaited work finishes"
              />
            }
          />
        ) : null}

        <OrchestratorUsageView
          days={voice?.usageDays ?? []}
          onClear={voice?.clearUsageHistory ?? (() => undefined)}
        />
      </SettingsSection>

      {voice !== null && voice.toolLog.length > 0 ? (
        <SettingsSection title="Recent tool calls">
          {voice.toolLog.map((entry) => (
            <SettingsRow
              key={`${entry.at}-${entry.name}-${entry.durationMs}`}
              title={entry.name}
              description={entry.reason ?? "No reason given."}
              status={`${entry.outcome} — ${entry.detail} (${entry.durationMs}ms)`}
              control={null}
            />
          ))}
        </SettingsSection>
      ) : null}

      <SettingsSection title="Activation">
        <SettingsRow
          title="How to start talking"
          description={ACTIVATION_OPTIONS[orchestrator.activation].hint}
          status={
            voiceShortcutLabel
              ? `Start or stop from the microphone button beside Orchestrator in the sidebar, or press ${voiceShortcutLabel}.`
              : "Start or stop from the microphone button beside Orchestrator in the sidebar."
          }
          control={
            <Select
              value={orchestrator.activation}
              onValueChange={(value) =>
                updateSettings({
                  orchestrator: { activation: value as OrchestratorActivationMode },
                })
              }
            >
              <SelectTrigger className="w-full sm:w-56" aria-label="Activation mode">
                <SelectValue>{ACTIVATION_OPTIONS[orchestrator.activation].label}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {SELECTABLE_ACTIVATION_MODES.map((mode) => (
                  <SelectItem key={mode} hideIndicator value={mode}>
                    {ACTIVATION_OPTIONS[mode].label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />

        {orchestrator.activation === "wake-word" ? (
          <SettingsRow
            title="Wake word"
            description="Spoken phrase that opens a session. Keep it distinctive to avoid false triggers."
            control={
              <Input
                key={orchestrator.wakeWord}
                defaultValue={orchestrator.wakeWord}
                className="w-full sm:w-56"
                aria-label="Wake word"
                onBlur={(event) => {
                  const next = event.target.value.trim();
                  if (next && next !== orchestrator.wakeWord) {
                    updateSettings({ orchestrator: { wakeWord: next } });
                  }
                }}
              />
            }
          />
        ) : null}
      </SettingsSection>

      <SettingsSection title="Authority">
        <SettingsRow
          title="What the orchestrator may do"
          description={AUTHORITY_OPTIONS[orchestrator.authority].hint}
          control={
            <Select
              value={orchestrator.authority}
              onValueChange={(value) =>
                updateSettings({ orchestrator: { authority: value as OrchestratorAuthority } })
              }
            >
              <SelectTrigger className="w-full sm:w-56" aria-label="Orchestrator authority">
                <SelectValue>{AUTHORITY_OPTIONS[orchestrator.authority].label}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {(Object.keys(AUTHORITY_OPTIONS) as OrchestratorAuthority[]).map((authority) => (
                  <SelectItem key={authority} hideIndicator value={authority}>
                    {AUTHORITY_OPTIONS[authority].label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />

        <SettingsRow
          title="Confirm destructive actions"
          description="Ask before interrupting a turn, stopping a task, denying an approval or settling a thread. Speech recognition mishears; leaving this on prevents a misheard command from killing real work."
          control={
            <Switch
              checked={orchestrator.confirmDestructiveActions}
              onCheckedChange={(checked) =>
                updateSettings({ orchestrator: { confirmDestructiveActions: Boolean(checked) } })
              }
              aria-label="Confirm destructive actions"
            />
          }
        />
      </SettingsSection>

      <SettingsSection title="What it speaks up about">
        {SPOKEN_EVENT_ROWS.map((row) => (
          <SettingsRow
            key={row.key}
            title={row.title}
            description={row.description}
            control={
              <Switch
                checked={orchestrator.spokenEvents[row.key]}
                onCheckedChange={(checked) =>
                  updateSettings({
                    orchestrator: { spokenEvents: { [row.key]: Boolean(checked) } },
                  })
                }
                aria-label={row.title}
              />
            }
          />
        ))}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
