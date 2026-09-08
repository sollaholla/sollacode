"use client";

import { type PreviewCredentialSummary } from "@t3tools/contracts";
import { Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

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

import { previewBridge } from "./previewBridge";

export function PreviewCredentialDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly tabId: string | null;
}) {
  const { open, onOpenChange, tabId } = props;
  const [credentials, setCredentials] = useState<readonly PreviewCredentialSummary[]>([]);
  const [label, setLabel] = useState("");
  const [origin, setOrigin] = useState("");
  const [username, setUsername] = useState("");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setOpen = (nextOpen: boolean) => {
    if (!nextOpen) {
      setLabel("");
      setUsername("");
      setSecret("");
      setError(null);
    }
    onOpenChange(nextOpen);
  };

  useEffect(() => {
    if (!open || !previewBridge) return;
    let active = true;
    setError(null);
    setOrigin("");
    void Promise.all([
      previewBridge.credentials.list(),
      tabId ? previewBridge.automation.status(tabId) : Promise.resolve(null),
    ]).then(
      ([saved, status]) => {
        if (!active) return;
        setCredentials(saved);
        if (!status?.url) {
          setOrigin("");
          return;
        }
        try {
          setOrigin(new URL(status.url).origin);
        } catch {
          setOrigin("");
        }
      },
      (cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : "Could not load passwords.");
      },
    );
    return () => {
      active = false;
    };
  }, [open, tabId]);

  const save = async () => {
    if (!previewBridge || busy || !label.trim() || !origin.trim() || !secret) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await previewBridge.credentials.save({
        label: label.trim(),
        origin: origin.trim(),
        ...(username ? { username } : {}),
        secret,
      });
      setCredentials((current) => [...current, saved]);
      setLabel("");
      setUsername("");
      setSecret("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the password.");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (credential: PreviewCredentialSummary) => {
    if (!previewBridge || busy) return;
    setBusy(true);
    setError(null);
    try {
      await previewBridge.credentials.remove(credential.id);
      setCredentials((current) => current.filter((item) => item.id !== credential.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not remove the password.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogPopup className="w-full max-w-lg">
        <DialogHeader>
          <DialogTitle>Saved browser passwords</DialogTitle>
          <DialogDescription>
            Passwords are encrypted by your operating system and can only fill pages with the exact
            saved origin. Agents receive labels and opaque IDs, never the password.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-5">
          {credentials.length > 0 ? (
            <ul className="space-y-2" aria-label="Saved browser passwords">
              {credentials.map((credential) => (
                <li
                  key={credential.id}
                  className="flex items-center gap-3 rounded-xl border border-border bg-muted/32 p-3"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{credential.label}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {credential.username ? `${credential.username} · ` : ""}
                      {credential.origin}
                    </p>
                  </div>
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Remove ${credential.label}`}
                    disabled={busy}
                    onClick={() => void remove(credential)}
                  >
                    <Trash2 />
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No browser passwords saved yet.</p>
          )}
          <div className="space-y-3 border-t border-border pt-4">
            <p className="text-sm font-medium">Add a password</p>
            <Label className="flex-col items-stretch gap-1.5">
              Label
              <Input value={label} onChange={(event) => setLabel(event.target.value)} />
            </Label>
            <Label className="flex-col items-stretch gap-1.5">
              Website origin
              <Input
                inputMode="url"
                value={origin}
                onChange={(event) => setOrigin(event.target.value)}
                placeholder="https://accounts.example.com"
              />
            </Label>
            <Label className="flex-col items-stretch gap-1.5">
              Username (optional)
              <Input
                autoComplete="off"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
              />
            </Label>
            <Label className="flex-col items-stretch gap-1.5">
              Password
              <Input
                autoComplete="new-password"
                type="password"
                value={secret}
                onChange={(event) => setSecret(event.target.value)}
              />
            </Label>
          </div>
          {error ? (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setOpen(false)}>
            Done
          </Button>
          <Button
            type="button"
            disabled={busy || !label.trim() || !origin.trim() || !secret}
            onClick={() => void save()}
          >
            {busy ? "Saving…" : "Save password"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
