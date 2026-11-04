import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { credentialRequestSaveInput } from "@t3tools/client-runtime/preview/credential-form";
import { type EnvironmentId } from "@t3tools/contracts";
import {
  CREDENTIAL_PASSKEYS_ON_ANSWER,
  CREDENTIAL_REQUEST_QUESTION_ID,
  credentialProvidedAnswers,
  credentialRequestSiteName,
  type CredentialRequest,
} from "@t3tools/shared/credentialRequest";
import { useState, type KeyboardEvent } from "react";

import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";

function settled<A, E>(result: AtomCommandResult<A, E>): A {
  if (result._tag === "Failure") throw squashAtomCommandFailure(result);
  return result.value;
}

/**
 * Collects a login for the site an agent is signing in to. The secret goes
 * straight to the desktop vault and stays only in this component's state until
 * then; what reaches the thread is the opaque id of the entry it became.
 */
export function CredentialRequestForm({
  request,
  environmentId,
  disabled,
  onProvided,
}: {
  request: CredentialRequest & { readonly mode: "password" | "code" };
  environmentId: EnvironmentId;
  disabled: boolean;
  onProvided: (answers: Record<string, string>) => void;
}) {
  const saveCredential = useAtomCommand(previewEnvironment.saveCredential, {
    reportFailure: false,
  });
  const [username, setUsername] = useState(request.usernameHint ?? "");
  const [secret, setSecret] = useState("");
  const [save, setSave] = useState(request.mode === "password");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const site = credentialRequestSiteName(request.origin);
  const isCode = request.mode === "code";
  const input = credentialRequestSaveInput({
    origin: request.origin,
    kind: request.mode,
    username,
    secret,
    save,
  });
  const canSubmit = input !== null && !saving && !disabled;

  const submit = async () => {
    if (!canSubmit) return;
    setSaving(true);
    setError(null);
    try {
      const saved = settled(await saveCredential({ environmentId, input }));
      setSecret("");
      onProvided(credentialProvidedAnswers({ credentialId: saved.id, saved: save }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The login could not be stored.");
    } finally {
      setSaving(false);
    }
  };

  // The card sits inside the composer's form, where Enter would send the composer.
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    event.stopPropagation();
    void submit();
  };

  return (
    <div className="mt-3 space-y-2">
      {isCode ? null : (
        <Input
          aria-label={`Username for ${site}`}
          placeholder="Username or email"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          value={username}
          disabled={saving || disabled}
          onChange={(event) => setUsername(event.target.value)}
          onKeyDown={onKeyDown}
        />
      )}
      <Input
        aria-label={`${isCode ? "Code" : "Password"} for ${site}`}
        type="password"
        placeholder={isCode ? "PIN or code" : "Password"}
        autoComplete="off"
        value={secret}
        disabled={saving || disabled}
        onChange={(event) => setSecret(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
        <Checkbox checked={save} onCheckedChange={setSave} disabled={saving || disabled} />
        Save for {site}
      </label>
      <p className="text-xs text-muted-foreground/70">
        {save
          ? "Stored encrypted on this computer and filled only on this exact site. The agent never sees it."
          : "Kept in memory for up to an hour for this sign-in, then forgotten. The agent never sees it."}
      </p>
      {error ? (
        <p role="alert" className="text-xs text-destructive-foreground">
          {error}
        </p>
      ) : null}
      <Button size="sm" disabled={!canSubmit} onClick={() => void submit()} type="button">
        {saving ? "Storing…" : "Continue"}
      </Button>
    </div>
  );
}

/** Turns on passkeys for the site an agent's page wants one on, then tells the agent. */
export function PasskeyRequestAction({
  origin,
  environmentId,
  disabled,
  onTurnedOn,
}: {
  origin: string;
  environmentId: EnvironmentId;
  disabled: boolean;
  onTurnedOn: (answers: Record<string, string>) => void;
}) {
  const setSite = useAtomCommand(previewEnvironment.passkeysSetSite, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const turnOn = async () => {
    setBusy(true);
    setError(null);
    try {
      settled(await setSite({ environmentId, input: { site: origin, enabled: true } }));
      onTurnedOn({ [CREDENTIAL_REQUEST_QUESTION_ID]: CREDENTIAL_PASSKEYS_ON_ANSWER });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Passkeys could not be turned on.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-3 space-y-2">
      {error ? (
        <p role="alert" className="text-xs text-destructive-foreground">
          {error}
        </p>
      ) : null}
      <Button size="sm" disabled={busy || disabled} onClick={() => void turnOn()} type="button">
        {busy ? "Turning on…" : `Use passkeys on ${credentialRequestSiteName(origin)}`}
      </Button>
    </div>
  );
}
