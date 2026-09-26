import type { PreviewCredentialSummary } from "@t3tools/contracts";
import { EyeIcon, EyeOffIcon } from "lucide-react";
import { useId, useState, type ReactNode } from "react";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Radio, RadioGroup } from "~/components/ui/radio-group";

import {
  CREDENTIAL_KINDS,
  credentialErrorMessage,
  credentialOriginFromInput,
  credentialSaveInput,
  credentialSecretName,
  initialCredentialDraft,
  type CredentialDraft,
  type CredentialEditorMode,
  type CredentialSaveInput,
} from "@t3tools/client-runtime/preview/credential-form";

/**
 * Adds or edits one saved browser password, or PIN or code.
 *
 * The secret field is write-only: editing starts it blank and a blank field
 * keeps the saved secret, because the renderer is never given it. The form
 * lives inside the popup, so closing the dialog unmounts it and drops whatever
 * was typed.
 */
export function CredentialEditorDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly mode: CredentialEditorMode;
  readonly save: (input: CredentialSaveInput) => Promise<PreviewCredentialSummary>;
  readonly onSaved?: (saved: PreviewCredentialSummary) => void;
  /** Rendered at the start of the footer, such as a link to every saved password. */
  readonly footerStart?: ReactNode;
}) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="w-full max-w-md">
        <CredentialEditorForm
          mode={props.mode}
          save={props.save}
          footerStart={props.footerStart}
          onCancel={() => props.onOpenChange(false)}
          onSaved={(saved) => {
            props.onSaved?.(saved);
            props.onOpenChange(false);
          }}
        />
      </DialogPopup>
    </Dialog>
  );
}

function CredentialEditorForm(props: {
  readonly mode: CredentialEditorMode;
  readonly save: (input: CredentialSaveInput) => Promise<PreviewCredentialSummary>;
  readonly footerStart: ReactNode;
  readonly onCancel: () => void;
  readonly onSaved: (saved: PreviewCredentialSummary) => void;
}) {
  const { mode } = props;
  const [draft, setDraft] = useState<CredentialDraft>(() => initialCredentialDraft(mode));
  const passwordId = useId();
  const kindLabelId = useId();
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editing = mode.kind === "edit";
  const input = credentialSaveInput(mode, draft);
  const origin = credentialOriginFromInput(draft.origin);
  const secretName = credentialSecretName(draft.kind);
  const secretLabel = secretName.charAt(0).toUpperCase() + secretName.slice(1);

  const update = (field: keyof CredentialDraft) => (event: { target: { value: string } }) =>
    setDraft((current) => ({ ...current, [field]: event.target.value }));

  const submit = async () => {
    if (!input || busy) return;
    setBusy(true);
    setError(null);
    try {
      props.onSaved(await props.save(input));
    } catch (cause) {
      setError(credentialErrorMessage(cause, `Could not save the ${secretName}.`));
      setBusy(false);
    }
  };

  return (
    <form
      className="contents"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <DialogHeader>
        <DialogTitle>{editing ? `Edit saved ${secretName}` : "Save a password or PIN"}</DialogTitle>
        <DialogDescription>
          The desktop app encrypts it on the computer running Solla Code. Agents see its label,
          never the {secretName}, and it fills only pages on the exact site saved here.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel className="space-y-4">
        <div className="space-y-2">
          <div id={kindLabelId} className="text-sm font-medium">
            Type
          </div>
          <RadioGroup
            aria-labelledby={kindLabelId}
            className="gap-2"
            value={draft.kind}
            onValueChange={(value) =>
              setDraft((current) => ({ ...current, kind: value === "code" ? "code" : "password" }))
            }
          >
            {CREDENTIAL_KINDS.map((option) => (
              <Label key={option.kind} className="items-start gap-2.5 font-normal">
                <Radio value={option.kind} className="mt-0.5" />
                <span className="flex flex-col gap-0.5">
                  <span className="text-sm font-medium">{option.label}</span>
                  <span className="text-xs text-muted-foreground">{option.description}</span>
                </span>
              </Label>
            ))}
          </RadioGroup>
        </div>
        <Label className="flex-col items-stretch gap-1.5">
          Label
          <Input
            autoComplete="off"
            value={draft.label}
            onChange={update("label")}
            placeholder={draft.kind === "code" ? "Rent payment PIN" : "Work GitHub"}
            maxLength={128}
          />
        </Label>
        <div className="space-y-1.5">
          <Label className="flex-col items-stretch gap-1.5">
            Website
            <Input
              autoComplete="off"
              inputMode="url"
              spellCheck={false}
              value={draft.origin}
              onChange={update("origin")}
              placeholder="https://github.com"
              maxLength={2048}
            />
          </Label>
          <p className="text-xs text-muted-foreground">
            {origin
              ? `Fills only pages on ${origin}.`
              : "HTTPS sites, plus localhost for development."}
          </p>
        </div>
        {draft.kind === "password" ? (
          <Label className="flex-col items-stretch gap-1.5">
            Username or email (optional)
            <Input
              autoComplete="off"
              spellCheck={false}
              value={draft.username}
              onChange={update("username")}
              maxLength={512}
            />
          </Label>
        ) : null}
        <div className="space-y-1.5">
          <Label htmlFor={passwordId}>{secretLabel}</Label>
          <span className="relative flex">
            <Input
              id={passwordId}
              className="pe-9"
              autoComplete="new-password"
              spellCheck={false}
              type={revealed ? "text" : "password"}
              value={draft.secret}
              onChange={update("secret")}
              maxLength={4096}
              placeholder={editing ? "Unchanged" : undefined}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="absolute end-1 top-1/2 -translate-y-1/2"
              aria-label={revealed ? `Hide ${secretName}` : `Show ${secretName}`}
              aria-pressed={revealed}
              disabled={!draft.secret}
              onClick={() => setRevealed((current) => !current)}
            >
              {revealed ? <EyeOffIcon /> : <EyeIcon />}
            </Button>
          </span>
          {editing ? (
            <p className="text-xs text-muted-foreground">
              Leave blank to keep the saved {secretName}.
            </p>
          ) : null}
        </div>
        {error ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}
      </DialogPanel>
      <DialogFooter className="sm:items-center">
        {props.footerStart ? <div className="sm:me-auto">{props.footerStart}</div> : null}
        <Button type="button" variant="outline" onClick={props.onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy || !input}>
          {busy ? "Saving…" : editing ? "Save changes" : `Save ${secretName}`}
        </Button>
      </DialogFooter>
    </form>
  );
}
