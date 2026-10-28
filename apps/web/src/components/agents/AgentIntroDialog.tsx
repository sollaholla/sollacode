import type { EnvironmentId, VmAgent } from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import * as Cause from "effect/Cause";
import {
  ArrowLeftIcon,
  BellRingIcon,
  CalendarClockIcon,
  GlobeIcon,
  SparklesIcon,
} from "lucide-react";
import { useRef, useState, type CSSProperties } from "react";

import { useAtomCommand } from "~/state/use-atom-command";
import { vmAgentEnvironment } from "~/state/vmAgents";
import { Button } from "~/components/ui/button";
import { Dialog, DialogPopup, DialogTitle, DialogDescription } from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import { cn } from "~/lib/utils";

import { AgentGlyph } from "./AgentGlyph";
import {
  AGENT_INTRO_CAST,
  AGENT_INTRO_STARTERS,
  AGENT_INTRO_WELCOME_CAST,
  agentIntroDefaultName,
  agentIntroPreviewMood,
} from "./agentIntro";

type Step = "meet" | "pick" | "name" | "ready";

const STEPS: ReadonlyArray<Step> = ["meet", "pick", "name", "ready"];

/** Stagger for the pop-in, read by `.agent-intro-pop` in index.css. */
const popDelay = (index: number): CSSProperties =>
  ({ "--agent-intro-delay": `${120 + index * 85}ms` }) as CSSProperties;

const SPARK_COLORS = ["bg-primary", "bg-warning", "bg-info"] as const;

/** Eight sparks around the new agent; offsets feed `.agent-intro-spark`. */
const SPARKS = Array.from({ length: 8 }, (_, index) => {
  const angle = (index / 8) * Math.PI * 2 - Math.PI / 2;
  const reach = index % 2 === 0 ? 70 : 54;
  return {
    key: `spark-${index}`,
    color: SPARK_COLORS[index % SPARK_COLORS.length]!,
    style: {
      "--spark-x": `${Math.round(Math.cos(angle) * reach)}px`,
      "--spark-y": `${Math.round(Math.sin(angle) * reach)}px`,
      "--agent-intro-delay": `${index % 2 === 0 ? 120 : 180}ms`,
    } as CSSProperties,
  };
});

const FEATURES = [
  {
    icon: CalendarClockIcon,
    title: "Works on a schedule",
    body: "Give it recurring tasks. It runs them and reports back.",
  },
  {
    icon: GlobeIcon,
    title: "Has its own browser",
    body: "Sites it signs in to stay signed in between runs.",
  },
  {
    icon: BellRingIcon,
    title: "Checks in with you",
    body: "It asks before anything consequential and pings you when it needs you.",
  },
] as const;

/**
 * The first-agent intro: meet the cast, pick a character, give it a job, and
 * watch it come to life. Opened in place of the plain create dialog while a
 * host has no agents. All motion is one-shot and off under reduced motion.
 */
export function AgentIntroDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentId: EnvironmentId;
  readonly onBuildWithAi: () => void;
}) {
  const router = useRouter();
  const [step, setStep] = useState<Step>("meet");
  const [picked, setPicked] = useState(0);
  const [hovered, setHovered] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [nameEdited, setNameEdited] = useState(false);
  const [purpose, setPurpose] = useState("");
  const [typing, setTyping] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<VmAgent | null>(null);
  const createAgent = useAtomCommand(vmAgentEnvironment.create, { reportFailure: false });
  // Bumped on every reset so a create that finishes after the dialog closed
  // doesn't reopen it on the celebration step.
  const visitRef = useRef(0);

  const reset = () => {
    visitRef.current += 1;
    setStep("meet");
    setPicked(0);
    setHovered(null);
    setName("");
    setNameEdited(false);
    setPurpose("");
    setTyping(false);
    setBusy(false);
    setError(null);
    setCreated(null);
  };

  const close = () => {
    reset();
    props.onOpenChange(false);
  };

  const pick = (avatarColor: number) => {
    setPicked(avatarColor);
    if (!nameEdited) setName(agentIntroDefaultName(avatarColor));
  };

  const canCreate = name.trim().length > 0 && purpose.trim().length > 0 && !busy;

  const create = async () => {
    if (!canCreate) return;
    setBusy(true);
    setError(null);
    const visit = visitRef.current;
    const result = await createAgent({
      environmentId: props.environmentId,
      input: { name: name.trim(), purpose: purpose.trim(), avatarColor: picked },
    });
    if (visit !== visitRef.current) return;
    setBusy(false);
    if (result._tag === "Success") {
      setCreated(result.value);
      setStep("ready");
      return;
    }
    const squashed = Cause.squash(result.cause);
    setError(
      squashed instanceof Error && squashed.message.trim().length > 0
        ? squashed.message
        : "Could not create the agent.",
    );
  };

  const openCreated = () => {
    if (!created) return;
    const agentId = created.vmAgentId;
    close();
    void router.navigate({
      to: "/agents/$environmentId/$agentId",
      params: { environmentId: props.environmentId, agentId },
    });
  };

  const buildWithAi = () => {
    close();
    props.onBuildWithAi();
  };

  const previewMood = agentIntroPreviewMood({
    name,
    purpose,
    typing,
    busy,
    failed: error !== null,
  });

  return (
    <Dialog
      open={props.open}
      onOpenChange={(next) => {
        if (!next) reset();
        props.onOpenChange(next);
      }}
    >
      <DialogPopup className="w-full max-w-2xl min-w-0 overflow-hidden" data-agent-intro={step}>
        <div className="flex min-h-0 flex-col gap-6 overflow-y-auto px-6 pt-8 pb-6 sm:px-8">
          {step === "meet" ? (
            <>
              <div
                className="flex items-end justify-center gap-1 sm:gap-2"
                data-testid="agent-intro-cast"
              >
                {AGENT_INTRO_WELCOME_CAST.map((avatarColor, index) => (
                  <span
                    key={avatarColor}
                    className={cn(
                      "agent-intro-pop inline-flex",
                      // The middle of the line-up stands a little taller.
                      index === 3 ? "size-20 sm:size-24" : "size-12 sm:size-16",
                    )}
                    style={popDelay(index)}
                  >
                    <AgentGlyph
                      agentId={`agent-intro-${avatarColor}`}
                      avatarColor={avatarColor}
                      online
                      mood={index === 3 ? "happy" : "idle"}
                      className="size-full"
                    />
                  </span>
                ))}
              </div>
              <div className="flex flex-col items-center gap-2 text-center">
                <DialogTitle className="text-2xl">Meet your agents</DialogTitle>
                <DialogDescription className="max-w-md text-balance">
                  Agents are named helpers that keep working while you&apos;re away. Each one has
                  its own chat, its own browser and the jobs you give it.
                </DialogDescription>
              </div>
              <ul className="grid gap-3 sm:grid-cols-3">
                {FEATURES.map((feature, index) => (
                  <li
                    key={feature.title}
                    className="agent-intro-pop flex flex-col gap-1.5 rounded-xl border border-border bg-card/60 p-3"
                    style={popDelay(AGENT_INTRO_WELCOME_CAST.length + index)}
                  >
                    <feature.icon aria-hidden className="size-4 text-primary" />
                    <span className="text-sm font-medium text-foreground">{feature.title}</span>
                    <span className="text-xs leading-relaxed text-muted-foreground">
                      {feature.body}
                    </span>
                  </li>
                ))}
              </ul>
              <div className="flex flex-col-reverse items-stretch gap-2 sm:flex-row sm:items-center sm:justify-between">
                <Button variant="ghost" type="button" onClick={close}>
                  Maybe later
                </Button>
                <Button
                  type="button"
                  onClick={() => {
                    pick(picked);
                    setStep("pick");
                  }}
                >
                  Pick your first agent
                </Button>
              </div>
            </>
          ) : null}

          {step === "pick" ? (
            <>
              <div className="flex flex-col items-center gap-2 text-center">
                <DialogTitle className="text-2xl">Pick a character</DialogTitle>
                <DialogDescription>
                  It keeps this look everywhere you use Solla Code.
                </DialogDescription>
              </div>
              <div
                role="radiogroup"
                aria-label="Character"
                className="grid grid-cols-4 gap-2 sm:grid-cols-6"
              >
                {AGENT_INTRO_CAST.map((avatarColor, index) => {
                  const selected = avatarColor === picked;
                  return (
                    <button
                      key={avatarColor}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      aria-label={agentIntroDefaultName(avatarColor)}
                      data-testid="agent-intro-character"
                      onClick={() => pick(avatarColor)}
                      onPointerEnter={() => setHovered(avatarColor)}
                      onPointerLeave={() => setHovered(null)}
                      onFocus={() => setHovered(avatarColor)}
                      onBlur={() => setHovered(null)}
                      className={cn(
                        "agent-intro-pop flex flex-col items-center gap-1 rounded-xl border p-2 outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        selected
                          ? "border-primary bg-primary/10"
                          : "border-transparent hover:bg-accent",
                      )}
                      style={popDelay(index)}
                    >
                      <AgentGlyph
                        agentId={`agent-intro-${avatarColor}`}
                        avatarColor={avatarColor}
                        online
                        mood={selected ? "happy" : hovered === avatarColor ? "waiting" : "idle"}
                        className="size-14"
                      />
                      <span className="text-[11px] text-muted-foreground">
                        {agentIntroDefaultName(avatarColor)}
                      </span>
                    </button>
                  );
                })}
              </div>
              <div className="flex flex-col-reverse items-stretch gap-2 sm:flex-row sm:items-center sm:justify-between">
                <Button variant="ghost" type="button" onClick={() => setStep("meet")}>
                  <ArrowLeftIcon aria-hidden />
                  Back
                </Button>
                <Button type="button" onClick={() => setStep("name")}>
                  Choose {agentIntroDefaultName(picked)}
                </Button>
              </div>
            </>
          ) : null}

          {step === "name" ? (
            <>
              <div className="flex flex-col items-center gap-3 text-center">
                <span className="agent-intro-pop inline-flex size-24" style={popDelay(0)}>
                  <AgentGlyph
                    agentId={`agent-intro-${picked}`}
                    avatarColor={picked}
                    online
                    mood={previewMood}
                    className="size-full"
                  />
                </span>
                <DialogTitle className="text-2xl">What should it do?</DialogTitle>
                <DialogDescription>
                  Pick a starter or write your own. You can change both later.
                </DialogDescription>
              </div>
              <div className="flex flex-wrap justify-center gap-2">
                {AGENT_INTRO_STARTERS.map((starter) => (
                  <Button
                    key={starter.label}
                    type="button"
                    size="sm"
                    variant={purpose === starter.purpose ? "secondary" : "outline"}
                    onClick={() => setPurpose(starter.purpose)}
                  >
                    {starter.label}
                  </Button>
                ))}
              </div>
              <div className="flex flex-col gap-4">
                <div className="flex flex-col gap-1.5">
                  <label
                    className="text-xs font-medium text-muted-foreground"
                    htmlFor="agent-intro-name"
                  >
                    Name (also its @mention)
                  </label>
                  <Input
                    id="agent-intro-name"
                    value={name}
                    maxLength={64}
                    onFocus={() => setTyping(true)}
                    onBlur={() => setTyping(false)}
                    onChange={(event) => {
                      setName(event.target.value);
                      setNameEdited(true);
                      setError(null);
                    }}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label
                    className="text-xs font-medium text-muted-foreground"
                    htmlFor="agent-intro-purpose"
                  >
                    Purpose
                  </label>
                  <Textarea
                    id="agent-intro-purpose"
                    value={purpose}
                    rows={3}
                    maxLength={2000}
                    placeholder="Research topics in the browser and summarize findings."
                    onFocus={() => setTyping(true)}
                    onBlur={() => setTyping(false)}
                    onChange={(event) => {
                      setPurpose(event.target.value);
                      setError(null);
                    }}
                  />
                </div>
                {error ? <p className="text-xs text-destructive">{error}</p> : null}
              </div>
              <div className="flex flex-col-reverse items-stretch gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex flex-col-reverse gap-2 sm:flex-row">
                  <Button variant="ghost" type="button" onClick={() => setStep("pick")}>
                    <ArrowLeftIcon aria-hidden />
                    Back
                  </Button>
                  <Button variant="ghost" type="button" onClick={buildWithAi}>
                    <SparklesIcon aria-hidden />
                    Build one with AI instead
                  </Button>
                </div>
                <Button type="button" disabled={!canCreate} onClick={() => void create()}>
                  {busy ? "Bringing it to life…" : `Bring ${name.trim() || "it"} to life`}
                </Button>
              </div>
            </>
          ) : null}

          {step === "ready" && created ? (
            <>
              <div className="relative flex justify-center pt-4">
                {SPARKS.map((spark) => (
                  <span
                    key={spark.key}
                    aria-hidden
                    className={cn(
                      "agent-intro-spark absolute top-1/2 left-1/2 size-2 rounded-full opacity-0",
                      spark.color,
                    )}
                    style={spark.style}
                  />
                ))}
                <span className="agent-intro-cheer inline-flex size-28">
                  <AgentGlyph
                    agentId={created.vmAgentId}
                    avatarColor={created.avatarColor}
                    online
                    mood="happy"
                    className="size-full"
                  />
                </span>
              </div>
              <div className="flex flex-col items-center gap-2 text-center">
                <DialogTitle className="text-2xl">{created.name} is ready</DialogTitle>
                <DialogDescription className="max-w-md text-balance">
                  Say hello in its chat, or give it a scheduled job from its workspace. It appears
                  under Agents in the sidebar.
                </DialogDescription>
              </div>
              <div className="flex flex-col-reverse items-stretch gap-2 sm:flex-row sm:items-center sm:justify-end">
                <Button variant="ghost" type="button" onClick={close}>
                  Done
                </Button>
                <Button type="button" onClick={openCreated}>
                  Say hello to {created.name}
                </Button>
              </div>
            </>
          ) : null}

          <div className="flex justify-center gap-1.5" aria-hidden>
            {STEPS.map((entry) => (
              <span
                key={entry}
                className={cn(
                  "h-1.5 rounded-full transition-all",
                  entry === step ? "w-5 bg-primary" : "w-1.5 bg-muted-foreground/30",
                )}
              />
            ))}
          </div>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
