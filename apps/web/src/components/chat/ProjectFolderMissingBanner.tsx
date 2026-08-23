import type { EnvironmentId } from "@t3tools/contracts";
import { FolderXIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { inferProjectTitleFromPath } from "@t3tools/client-runtime/state/projects";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";

import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";

import { projectEnvironment } from "~/state/projects";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { ComposerBannerStack } from "./ComposerBannerStack";

/**
 * "Project folder not found" — shown right above the composer's checkout
 * controls when the active project's workspace root no longer exists on disk
 * (moved, renamed, or deleted). Instead of every file listing, git call, and
 * session spawn failing with a bare ENOENT, the user re-points the project at
 * the folder's new location here; the project is also renamed after the new
 * folder, the same derivation used when a project is first added.
 *
 * The server re-validates the new path on dispatch (the meta.update
 * normalizer refuses a nonexistent root), so a typo comes back as a readable
 * error rather than a half-moved project.
 */
export function ProjectFolderMissingBanner(props: {
  readonly environmentId: EnvironmentId;
  readonly project: EnvironmentProject;
}) {
  const checkAtom = useMemo(
    () =>
      projectEnvironment.checkWorkspaceRoot({
        environmentId: props.environmentId,
        input: { projectId: props.project.id },
      }),
    [props.environmentId, props.project.id],
  );
  const check = useEnvironmentQuery(checkAtom);
  const updateProject = useAtomCommand(projectEnvironment.update, { reportFailure: false });

  const missing = check.data !== null && !check.data.exists;
  const missingPath = check.data?.workspaceRoot ?? props.project.workspaceRoot;
  const [nextPath, setNextPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Seed the input with the old path each time the overlay appears: the moved
  // folder usually keeps its name, so the fix is often editing one segment.
  useEffect(() => {
    if (missing) {
      setNextPath(missingPath);
      setError(null);
    }
  }, [missing, missingPath]);

  // The project row updated underneath us (re-pointed from another window, or
  // the folder came back): re-stat rather than trusting a stale verdict.
  const { refresh } = check;
  useEffect(() => {
    refresh();
  }, [props.project.workspaceRoot, refresh]);

  if (!missing) return null;

  const repoint = async () => {
    const target = nextPath.trim();
    if (target.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    const inferredTitle = inferProjectTitleFromPath(target);
    const result = await updateProject({
      environmentId: props.environmentId,
      input: {
        projectId: props.project.id,
        workspaceRoot: target,
        // Re-pointing follows the folder: the project takes the new folder's
        // name, exactly as it would if it were added fresh from this path.
        ...(inferredTitle ? { title: inferredTitle } : {}),
      },
    });
    setBusy(false);
    if (result._tag === "Failure") {
      const cause = squashAtomCommandFailure(result);
      setError(cause instanceof Error ? cause.message : "The project could not be re-pointed.");
      return;
    }
    refresh();
  };

  return (
    <ComposerBannerStack
      className="relative z-0"
      items={[
        {
          id: `project-folder-missing:${props.project.id}`,
          variant: "warning",
          icon: <FolderXIcon />,
          title: "Project folder not found",
          description: (
            <div className="flex min-w-0 flex-col gap-2">
              <p className="min-w-0 text-xs text-muted-foreground">
                <code className="break-all">{missingPath}</code> no longer exists. If you moved the
                folder, point this project at its new location — the project will take the new
                folder&rsquo;s name.
              </p>
              <form
                className="flex min-w-0 flex-wrap items-center gap-1.5"
                onSubmit={(event) => {
                  event.preventDefault();
                  void repoint();
                }}
              >
                <Input
                  value={nextPath}
                  onChange={(event) => setNextPath(event.target.value)}
                  placeholder="/path/to/the/moved/folder"
                  aria-label="New project folder path"
                  className="h-8 min-w-52 flex-1 font-mono text-xs"
                  spellCheck={false}
                />
                <Button type="submit" size="xs" disabled={busy || nextPath.trim().length === 0}>
                  {busy ? "Re-pointing…" : "Use this folder"}
                </Button>
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  disabled={busy}
                  onClick={() => refresh()}
                  title="Re-check the original path — use this if you moved the folder back."
                >
                  Check again
                </Button>
              </form>
              {error ? <p className="break-words text-xs text-destructive">{error}</p> : null}
            </div>
          ),
        },
      ]}
    />
  );
}
