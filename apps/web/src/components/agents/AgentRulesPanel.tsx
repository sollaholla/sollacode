import { useAtomValue } from "@effect/atom-react";
import { type EnvironmentId, type VmAgent, VmAgentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { RotateCcwIcon, SaveIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { vmAgentEnvironment } from "~/state/vmAgents";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";

import { WorkspacePanel } from "./AgentWorkspacePanels";

const errorMessage = (cause: Cause.Cause<unknown>, fallback: string) => {
  const error = Cause.squash(cause);
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback;
};

interface EditorState {
  readonly vmAgentId: string;
  readonly baseline: string;
  readonly draft: string;
}

export function AgentRulesPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly agent: VmAgent;
}) {
  const rulesAtom = useMemo(
    () =>
      vmAgentEnvironment.rules({
        environmentId: props.environmentId,
        input: { vmAgentId: VmAgentId.make(props.agent.vmAgentId) },
      }),
    [props.agent.vmAgentId, props.environmentId],
  );
  const result = useAtomValue(rulesAtom);
  const rules = Option.getOrNull(AsyncResult.value(result));
  const [editor, setEditor] = useState<EditorState>({
    vmAgentId: props.agent.vmAgentId,
    baseline: "",
    draft: "",
  });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const updateRules = useAtomCommand(vmAgentEnvironment.updateRules, { reportFailure: false });

  useEffect(() => {
    if (rules === null) return;
    setEditor((current) => {
      const switchedAgent = current.vmAgentId !== props.agent.vmAgentId;
      const hasLocalEdits = current.draft !== current.baseline;
      if (!switchedAgent && hasLocalEdits) return current;
      return {
        vmAgentId: props.agent.vmAgentId,
        baseline: rules.content,
        draft: rules.content,
      };
    });
  }, [props.agent.vmAgentId, rules]);

  const dirty = editor.draft !== editor.baseline;
  const loading = rules === null && !AsyncResult.isFailure(result);
  const loadError = AsyncResult.isFailure(result)
    ? errorMessage(result.cause, "Could not load this agent's rules.")
    : null;

  const save = async () => {
    if (!dirty || saving) return;
    setSaving(true);
    setSaveError(null);
    const saved = await updateRules({
      environmentId: props.environmentId,
      input: {
        vmAgentId: props.agent.vmAgentId,
        content: editor.draft,
      },
    });
    if (saved._tag === "Success") {
      setEditor({
        vmAgentId: props.agent.vmAgentId,
        baseline: saved.value.content,
        draft: saved.value.content,
      });
    } else {
      setSaveError(errorMessage(saved.cause, "Could not save this agent's rules."));
    }
    setSaving(false);
  };

  return (
    <WorkspacePanel
      title="Rules"
      description="Edit AGENTS.md for this agent's isolated working directory. CLAUDE.md points to it, so every provider reads one source of truth on the next turn."
      action={
        <div className="flex items-center gap-1">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={!dirty || saving}
            onClick={() => setEditor((current) => ({ ...current, draft: current.baseline }))}
          >
            <RotateCcwIcon /> Reset
          </Button>
          <Button type="button" size="sm" disabled={!dirty || saving} onClick={() => void save()}>
            <SaveIcon /> {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      }
    >
      {loadError ? <p className="text-xs text-destructive">{loadError}</p> : null}
      {saveError ? <p className="text-xs text-destructive">{saveError}</p> : null}
      <div className="overflow-hidden rounded-xl border bg-muted/10">
        <div className="flex items-center justify-between gap-3 border-b px-3 py-2 text-xs">
          <span className="font-mono font-medium">AGENTS.md</span>
          <span className="text-muted-foreground">
            {editor.draft.length.toLocaleString()} / 100,000
          </span>
        </div>
        <Textarea
          value={editor.draft}
          disabled={loading || loadError !== null || saving}
          placeholder={loading ? "Loading rules…" : "Add durable instructions for this agent…"}
          aria-label="Agent rules"
          className="min-h-[min(62vh,42rem)] resize-y rounded-none border-0 bg-transparent p-4 font-mono text-xs leading-relaxed shadow-none focus-visible:ring-0"
          onChange={(event) => {
            const draft = event.currentTarget.value;
            setEditor((current) => ({ ...current, draft }));
          }}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
              event.preventDefault();
              void save();
            }
          }}
        />
      </div>
      <p className="text-[11px] text-muted-foreground">
        Changes are local to {props.agent.name}. CLAUDE.md preserves any Claude-specific notes and
        imports this file with @AGENTS.md.
      </p>
    </WorkspacePanel>
  );
}
