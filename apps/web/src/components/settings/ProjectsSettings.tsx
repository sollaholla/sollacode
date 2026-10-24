import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import {
  dailyTokenSeries,
  filterProjectOverviews,
  folderUsageNotes,
  formatByteSize,
  formatTokenCount,
  formatUsdAmount,
  PROJECT_SORT_OPTIONS,
  projectStorageBytes,
  providerUsageRows,
  sortProjectOverviews,
  storageSegments,
  summarizeProjectOverviews,
  tokenSegments,
  tokenTrackingNote,
  totalStorageBytes,
  totalTokens,
  type ProjectOverview,
  type ProjectSortKey,
  type StorageSegmentKey,
  type TokenSegmentKey,
} from "@t3tools/client-runtime/state/project-statistics";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { OrchestrationProjectStatistics } from "@t3tools/contracts";
import { useNavigate, useParams } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  ChevronRightIcon,
  CopyIcon,
  EllipsisIcon,
  FolderCheckIcon,
  FoldersIcon,
  PencilIcon,
  RefreshCwIcon,
  SearchIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { useCallback, useMemo, useState, type ReactNode } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useProjectOverviews } from "../../lib/projectStatisticsState";
import { cn } from "../../lib/utils";
import { useThreadShells } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { projectEnvironment } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { ProjectFavicon } from "../ProjectFavicon";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";

const STORAGE_SEGMENT_CLASS: Record<StorageSegmentKey, string> = {
  folder: "bg-gold-700",
  history: "bg-gold-500",
  attachments: "bg-gold-300",
  artifacts: "bg-[var(--text-3)]",
};

const TOKEN_SEGMENT_CLASS: Record<TokenSegmentKey, string> = {
  input: "bg-gold-500",
  cached: "bg-gold-300",
  cacheWrite: "bg-gold-700",
  output: "bg-[var(--text-2)]",
};

const DAY_LABEL = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});
const DATE_LABEL = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? singular : pluralForm}`;
}

function errorDescription(cause: unknown): string {
  return cause instanceof Error && cause.message.trim().length > 0
    ? cause.message
    : "An error occurred.";
}

/** Rename and remove, shared by the list and a project's own page. */
function useProjectActions() {
  const updateProject = useAtomCommand(projectEnvironment.update, { reportFailure: false });
  const deleteProject = useAtomCommand(projectEnvironment.delete, { reportFailure: false });

  const rename = useCallback(
    async (project: EnvironmentProject, nextTitle: string): Promise<boolean> => {
      const title = nextTitle.trim();
      if (title.length === 0) {
        toastManager.add({ type: "warning", title: "A project needs a name" });
        return false;
      }
      if (title === project.title) return true;
      const result = await updateProject({
        environmentId: project.environmentId,
        input: { projectId: project.id, title },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Couldn't rename the project",
              description: errorDescription(squashAtomCommandFailure(result)),
            }),
          );
        }
        return false;
      }
      return true;
    },
    [updateProject],
  );

  const remove = useCallback(
    async (project: EnvironmentProject): Promise<boolean> => {
      const draftStore = useComposerDraftStore.getState();
      const projectRef = scopeProjectRef(project.environmentId, project.id);
      const draftThread = draftStore.getDraftThreadByProjectRef(projectRef);
      const result = await deleteProject({
        environmentId: project.environmentId,
        // Forced so chats created or unarchived since this page loaded go too;
        // the confirmation already said every chat would.
        input: { projectId: project.id, force: true },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: `Couldn't remove “${project.title}”`,
              description: errorDescription(squashAtomCommandFailure(result)),
            }),
          );
        }
        return false;
      }
      if (draftThread) draftStore.clearDraftThread(draftThread.draftId);
      draftStore.clearProjectDraftThreadId(projectRef);
      toastManager.add({ type: "success", title: `Removed “${project.title}”` });
      return true;
    },
    [deleteProject],
  );

  return { rename, remove };
}

function useEnvironmentLabels() {
  const { environments } = useEnvironments();
  return useMemo(() => {
    const labels = new Map(
      environments.map((environment) => [environment.environmentId, environment.label]),
    );
    const providers = new Map(
      environments.map((environment) => [
        environment.environmentId,
        environment.serverConfig?.providers ?? [],
      ]),
    );
    return { labels, providers, multiple: environments.length > 1 };
  }, [environments]);
}

function RefreshButton({ isLoading, onRefresh }: { isLoading: boolean; onRefresh: () => void }) {
  // Only disables and spins: the numbers stay put until the new ones land.
  return (
    <Button
      size="icon-sm"
      variant="ghost"
      aria-label="Refresh project statistics"
      title="Refresh"
      disabled={isLoading}
      onClick={onRefresh}
    >
      <RefreshCwIcon className={cn(isLoading && "animate-spin")} />
    </Button>
  );
}

function StatTile({
  id,
  label,
  value,
  detail,
}: {
  id?: string;
  label: string;
  value: string;
  detail?: ReactNode;
}) {
  return (
    <div id={id} className="min-w-0 rounded-xl border border-[var(--line)] bg-card px-4 py-3">
      <div className="truncate text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
        {label}
      </div>
      <div className="mt-1 truncate text-xl font-semibold tracking-[-0.02em] text-foreground tabular-nums">
        {value}
      </div>
      {detail ? (
        <div className="mt-0.5 truncate text-xs text-muted-foreground">{detail}</div>
      ) : null}
    </div>
  );
}

function TrackingNote({ since }: { since: string | null }) {
  return (
    <p className="px-3 text-xs leading-relaxed text-muted-foreground sm:px-4">
      {tokenTrackingNote(since)}
    </p>
  );
}

// ── The list ───────────────────────────────────────────────────

export function ProjectsSettingsPanel() {
  const navigate = useNavigate();
  const { overviews, isLoading, error, tokenTrackingSince, refresh } = useProjectOverviews();
  const environments = useEnvironmentLabels();
  const { rename } = useProjectActions();
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<ProjectSortKey>("recent");
  const [renamingKey, setRenamingKey] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<ProjectOverview | null>(null);

  const visible = useMemo(
    () => sortProjectOverviews(filterProjectOverviews(overviews, query), sortKey),
    [overviews, query, sortKey],
  );
  const summary = useMemo(() => summarizeProjectOverviews(overviews), [overviews]);
  const hasStatistics = overviews.some((entry) => entry.statistics !== null);
  const largestStorage = useMemo(
    () => Math.max(1, ...overviews.map((entry) => projectStorageBytes(entry))),
    [overviews],
  );

  const openProject = (project: EnvironmentProject) =>
    void navigate({
      to: "/settings/projects/$environmentId/$projectId",
      params: { environmentId: project.environmentId, projectId: project.id },
    });

  return (
    <SettingsPageContainer>
      <SettingsSection
        id="setting-projects"
        title="Projects"
        icon={<FoldersIcon className="size-5" />}
        headerAction={<RefreshButton isLoading={isLoading} onRefresh={() => refresh()} />}
      >
        <p className="mb-4 max-w-2xl px-3 text-sm leading-relaxed text-muted-foreground sm:px-4">
          Rename or remove projects, and see what each one keeps on disk and how many tokens its
          chats have used. Removing a project deletes its chats; nothing in its folder is deleted.
        </p>

        <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <StatTile label="Projects" value={summary.projects.toLocaleString()} />
          <StatTile
            id="setting-project-storage"
            label="Storage"
            value={hasStatistics ? formatByteSize(summary.storageBytes) : "—"}
            detail="Folders on disk and chats"
          />
          <StatTile
            id="setting-project-tokens"
            label="Tokens · 30 days"
            value={hasStatistics ? formatTokenCount(summary.tokensLast30Days) : "—"}
          />
          <StatTile
            label="Cost · 30 days"
            value={hasStatistics ? formatUsdAmount(summary.costLast30DaysUsd) : "—"}
            detail="At API rates"
          />
        </div>

        {error && !hasStatistics ? (
          <div className="mb-3 rounded-xl border border-[var(--line)] bg-card px-4 py-3 text-sm text-muted-foreground">
            {error} The projects are listed below without their numbers.{" "}
            <button type="button" className="text-foreground underline" onClick={() => refresh()}>
              Try again
            </button>
          </div>
        ) : null}

        <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center">
          <label className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md border border-[var(--line)] bg-surface-row px-2 text-[13px] text-foreground focus-within:border-[var(--gold-line)]">
            <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape" && query.length > 0) {
                  // Clear the filter instead of leaving settings.
                  event.preventDefault();
                  setQuery("");
                }
              }}
              placeholder="Filter by name or folder"
              aria-label="Filter projects"
              className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground/70 [&::-webkit-search-cancel-button]:hidden"
            />
            {query.length > 0 ? (
              <button
                type="button"
                aria-label="Clear filter"
                onClick={() => setQuery("")}
                className="flex size-5 items-center justify-center rounded-md text-muted-foreground hover:bg-surface-hover hover:text-foreground"
              >
                <XIcon className="size-3" />
              </button>
            ) : null}
          </label>
          <Select
            value={sortKey}
            onValueChange={(value) => {
              const option = PROJECT_SORT_OPTIONS.find((candidate) => candidate.key === value);
              if (option) setSortKey(option.key);
            }}
          >
            <SelectTrigger className="w-full sm:w-48" aria-label="Sort projects">
              <SelectValue>
                {`Sort: ${PROJECT_SORT_OPTIONS.find((option) => option.key === sortKey)?.label ?? ""}`}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {PROJECT_SORT_OPTIONS.map((option) => (
                <SelectItem key={option.key} hideIndicator value={option.key}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>

        {overviews.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border px-6 py-10 text-center">
            <FoldersIcon className="mx-auto size-6 text-muted-foreground" />
            <p className="mt-3 text-sm font-medium">No projects yet</p>
            <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
              Add a project from the sidebar and it will show up here with its storage and token
              usage.
            </p>
          </div>
        ) : visible.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground sm:px-4">
            No projects match “{query.trim()}”.
          </p>
        ) : (
          <ul id="setting-project-list" className="space-y-2" aria-label="Projects">
            {visible.map((entry) => {
              const key = `${entry.project.environmentId}:${entry.project.id}`;
              return (
                <ProjectListRow
                  key={key}
                  entry={entry}
                  environmentLabel={
                    environments.multiple
                      ? (environments.labels.get(entry.project.environmentId) ?? null)
                      : null
                  }
                  largestStorage={largestStorage}
                  renaming={renamingKey === key}
                  onOpen={() => openProject(entry.project)}
                  onStartRename={() => setRenamingKey(key)}
                  onRename={async (title) => {
                    if (await rename(entry.project, title)) setRenamingKey(null);
                  }}
                  onCancelRename={() => setRenamingKey(null)}
                  onDelete={() => setDeleting(entry)}
                />
              );
            })}
          </ul>
        )}
        <div className="pt-2">
          <TrackingNote since={tokenTrackingSince} />
        </div>
      </SettingsSection>
      <DeleteProjectDialog target={deleting} onClose={() => setDeleting(null)} />
    </SettingsPageContainer>
  );
}

function ProjectListRow({
  entry,
  environmentLabel,
  largestStorage,
  renaming,
  onOpen,
  onStartRename,
  onRename,
  onCancelRename,
  onDelete,
}: {
  entry: ProjectOverview;
  environmentLabel: string | null;
  largestStorage: number;
  renaming: boolean;
  onOpen: () => void;
  onStartRename: () => void;
  onRename: (title: string) => Promise<void>;
  onCancelRename: () => void;
  onDelete: () => void;
}) {
  const { project, statistics, folder, builtIn } = entry;
  const storage = statistics === null && folder?.bytes == null ? null : projectStorageBytes(entry);
  const storageDetail = [
    folder?.bytes != null ? `${formatByteSize(folder.bytes)} folder` : null,
    statistics ? `${formatByteSize(totalStorageBytes(statistics.storage))} chats` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const chats = statistics ? statistics.activeThreads + statistics.archivedThreads : null;

  if (renaming) {
    return (
      <li className="flex items-center gap-3 rounded-xl border border-[var(--gold-line)] bg-card px-4 py-3">
        <ProjectFavicon environmentId={project.environmentId} cwd={project.workspaceRoot} />
        <RenameForm
          initialTitle={project.title}
          onSubmit={onRename}
          onCancel={onCancelRename}
          label={`New name for ${project.title}`}
        />
      </li>
    );
  }

  return (
    <li className="group relative flex items-center rounded-xl border border-[var(--line)] bg-card transition-colors hover:border-[var(--gold-line)]">
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-xl px-4 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ProjectFavicon environmentId={project.environmentId} cwd={project.workspaceRoot} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-medium text-foreground">{project.title}</span>
            {builtIn ? <Badge variant="secondary">Built-in</Badge> : null}
            {environmentLabel ? (
              <Badge variant="outline" className="max-w-40 truncate">
                {environmentLabel}
              </Badge>
            ) : null}
          </div>
          <div className="truncate font-mono text-[11px] text-muted-foreground/80">
            {project.workspaceRoot}
          </div>
          <div className="mt-0.5 truncate text-xs text-muted-foreground">
            {chats === null || statistics === null
              ? "—"
              : [
                  plural(chats, "chat"),
                  statistics.archivedThreads > 0
                    ? `${statistics.archivedThreads.toLocaleString()} archived`
                    : null,
                  statistics.lastActivityAt
                    ? `active ${formatRelativeTimeLabel(statistics.lastActivityAt)}`
                    : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
          </div>
        </div>
        {/* Storage shows at every width; a phone has no room for tokens beside it. */}
        <div className="flex shrink-0 gap-4 text-right">
          <div className="w-16 min-w-0 sm:w-[5.5rem]">
            <div className="text-[11px] text-muted-foreground">
              {folder?.measuring ? "Measuring…" : "Storage"}
            </div>
            <div
              className="text-sm font-medium text-foreground tabular-nums"
              title={storageDetail || undefined}
            >
              {storage === null ? "—" : formatByteSize(storage)}
            </div>
            <div className="mt-1 ms-auto h-1 w-full overflow-hidden rounded-full bg-[var(--line)]">
              <div
                className="ms-auto h-full rounded-full bg-gold-500"
                style={{ width: `${storage === null ? 0 : (storage / largestStorage) * 100}%` }}
              />
            </div>
          </div>
          <div className="hidden w-[5.5rem] min-w-0 sm:block">
            <div className="text-[11px] text-muted-foreground">Tokens · 30d</div>
            <div className="text-sm font-medium text-foreground tabular-nums">
              {statistics ? formatTokenCount(totalTokens(statistics.tokens.last30Days)) : "—"}
            </div>
          </div>
        </div>
        <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
      </button>
      <div className="pe-2">
        <Menu>
          <MenuTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`Actions for ${project.title}`}
              />
            }
          >
            <EllipsisIcon className="size-4" />
          </MenuTrigger>
          <MenuPopup align="end" className="min-w-40">
            <MenuItem onClick={onOpen}>Open details</MenuItem>
            {builtIn ? null : (
              <>
                <MenuItem onClick={onStartRename}>Rename</MenuItem>
                <MenuSeparator />
                <MenuItem variant="destructive" onClick={onDelete}>
                  Remove project…
                </MenuItem>
              </>
            )}
          </MenuPopup>
        </Menu>
      </div>
    </li>
  );
}

function RenameForm({
  initialTitle,
  label,
  onSubmit,
  onCancel,
  className,
}: {
  initialTitle: string;
  label: string;
  onSubmit: (title: string) => Promise<void>;
  onCancel: () => void;
  className?: string;
}) {
  const [title, setTitle] = useState(initialTitle);
  const [saving, setSaving] = useState(false);
  const submit = async () => {
    if (saving) return;
    setSaving(true);
    await onSubmit(title);
    setSaving(false);
  };
  return (
    <form
      className={cn("flex min-w-0 flex-1 items-center gap-2", className)}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <Input
        autoFocus
        aria-label={label}
        value={title}
        disabled={saving}
        onChange={(event) => setTitle(event.target.value)}
        onFocus={(event) => event.currentTarget.select()}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            // Cancel the rename; without this Escape would leave settings.
            event.preventDefault();
            event.stopPropagation();
            onCancel();
          }
        }}
        className="min-w-0 flex-1"
      />
      <Button type="submit" size="sm" disabled={saving || title.trim().length === 0}>
        Save
      </Button>
      <Button type="button" size="sm" variant="ghost" disabled={saving} onClick={onCancel}>
        Cancel
      </Button>
    </form>
  );
}

// ── Remove ────────────────────────────────────────────────────

function DeleteProjectDialog({
  target,
  onClose,
  onDeleted,
}: {
  target: ProjectOverview | null;
  onClose: () => void;
  onDeleted?: () => void;
}) {
  const { remove } = useProjectActions();
  const threadShells = useThreadShells();
  const [deleting, setDeleting] = useState(false);
  const project = target?.project ?? null;
  const statistics = target?.statistics ?? null;
  const liveThreads = useMemo(
    () =>
      project === null
        ? []
        : threadShells.filter(
            (thread) =>
              thread.environmentId === project.environmentId && thread.projectId === project.id,
          ),
    [project, threadShells],
  );
  const working = liveThreads.filter((thread) => thread.session?.status === "running").length;
  const chats = statistics
    ? statistics.activeThreads + statistics.archivedThreads
    : liveThreads.length;

  const confirm = async () => {
    if (project === null || deleting) return;
    setDeleting(true);
    const deleted = await remove(project);
    setDeleting(false);
    if (deleted) {
      onClose();
      onDeleted?.();
    }
  };

  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open && !deleting) onClose();
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-balance">Remove “{project?.title}”?</DialogTitle>
          <DialogDescription>This can't be undone.</DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-3 text-sm">
          {/* First, because the path above a destructive button reads like
              the thing being destroyed. */}
          <p className="flex items-start gap-2 rounded-lg border border-[var(--line)] bg-surface-tile px-3 py-2.5 text-foreground">
            <FolderCheckIcon className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
            <span>
              Nothing in{" "}
              <span className="font-mono text-xs break-all">{project?.workspaceRoot}</span>
              {target?.folder?.bytes != null
                ? ` (${formatByteSize(target.folder.bytes)} on disk)`
                : ""}{" "}
              is deleted. The folder and your files stay where they are.
            </span>
          </p>
          <ul className="space-y-2 text-muted-foreground">
            <li>
              {chats > 0 ? (
                <>
                  Its <span className="font-medium text-foreground">{plural(chats, "chat")}</span>
                  {statistics && statistics.archivedThreads > 0
                    ? `, ${statistics.archivedThreads.toLocaleString()} of them archived,`
                    : ""}{" "}
                  will be deleted with their history, attachments, and artifacts
                  {statistics ? ` (${formatByteSize(totalStorageBytes(statistics.storage))})` : ""}.
                </>
              ) : (
                "It has no chats, so only the project entry goes."
              )}
            </li>
            {working > 0 ? (
              <li className="text-warning-foreground">
                {plural(working, "chat")} {working === 1 ? "is" : "are"} working right now and will
                be stopped.
              </li>
            ) : null}
          </ul>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={deleting} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="destructive" disabled={deleting} onClick={() => void confirm()}>
            <Trash2Icon />
            {deleting ? "Removing…" : "Remove project"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

// ── One project ──────────────────────────────────────────────

export function ProjectDetailSettingsPanel() {
  const params = useParams({ strict: false });
  const navigate = useNavigate();
  const { overviews, environments, isLoading, tokenTrackingSince, refresh } = useProjectOverviews();
  const environmentLabels = useEnvironmentLabels();
  const { rename } = useProjectActions();
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState<ProjectOverview | null>(null);
  const { copyToClipboard } = useCopyToClipboard<{ path: string }>({
    onCopy: ({ path }) =>
      toastManager.add({ type: "success", title: "Path copied", description: path }),
  });

  const entry =
    overviews.find(
      (candidate) =>
        candidate.project.environmentId === params.environmentId &&
        candidate.project.id === params.projectId,
    ) ?? null;
  const generatedAt =
    environments.find((environment) => environment.environmentId === params.environmentId)?.result
      ?.generatedAt ?? null;
  const backToList = () => void navigate({ to: "/settings/projects" });

  if (entry === null) {
    return (
      <SettingsPageContainer>
        <BackLink onClick={backToList} />
        <div className="rounded-2xl border border-dashed border-border px-6 py-10 text-center">
          <FoldersIcon className="mx-auto size-6 text-muted-foreground" />
          <p className="mt-3 text-sm font-medium">This project isn't here anymore</p>
          <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
            It was removed, or its environment isn't connected right now.
          </p>
        </div>
      </SettingsPageContainer>
    );
  }

  const { project, statistics, builtIn } = entry;
  const environmentLabel = environmentLabels.multiple
    ? (environmentLabels.labels.get(project.environmentId) ?? null)
    : null;
  const providers = environmentLabels.providers.get(project.environmentId) ?? [];

  return (
    <SettingsPageContainer className="gap-10">
      <div className="space-y-5">
        <BackLink onClick={backToList} />
        <header className="flex items-start gap-4 px-3 sm:px-4">
          <ProjectFavicon
            environmentId={project.environmentId}
            cwd={project.workspaceRoot}
            className="mt-1 size-6"
          />
          <div className="min-w-0 flex-1 space-y-1">
            {renaming ? (
              <RenameForm
                initialTitle={project.title}
                label="Project name"
                onSubmit={async (title) => {
                  if (await rename(project, title)) setRenaming(false);
                }}
                onCancel={() => setRenaming(false)}
              />
            ) : (
              <div className="flex min-w-0 items-center gap-2">
                <h1 className="truncate text-2xl font-semibold tracking-[-0.03em] text-foreground">
                  {project.title}
                </h1>
                {builtIn ? <Badge variant="secondary">Built-in</Badge> : null}
                {builtIn ? null : (
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label="Rename project"
                    title="Rename"
                    onClick={() => setRenaming(true)}
                  >
                    <PencilIcon />
                  </Button>
                )}
              </div>
            )}
            <div className="flex min-w-0 items-center gap-1 text-muted-foreground">
              <span className="truncate font-mono text-xs">{project.workspaceRoot}</span>
              <Button
                size="icon-xs"
                variant="ghost"
                className="size-5 shrink-0"
                aria-label="Copy project path"
                title="Copy path"
                onClick={() =>
                  copyToClipboard(project.workspaceRoot, { path: project.workspaceRoot })
                }
              >
                <CopyIcon className="size-3" />
              </Button>
            </div>
            <div className="text-xs text-muted-foreground">
              {[
                environmentLabel,
                `Added ${DATE_LABEL.format(new Date(project.createdAt))}`,
                statistics?.lastActivityAt
                  ? `last active ${formatRelativeTimeLabel(statistics.lastActivityAt)}`
                  : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </div>
          </div>
          <RefreshButton isLoading={isLoading} onRefresh={() => refresh([project.id])} />
        </header>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <StatTile
            label="Chats"
            value={statistics ? statistics.activeThreads.toLocaleString() : "—"}
            detail={
              statistics === null
                ? undefined
                : statistics.archivedThreads > 0
                  ? `+ ${statistics.archivedThreads.toLocaleString()} archived`
                  : "None archived"
            }
          />
          <StatTile
            label="Turns"
            value={statistics ? statistics.turns.toLocaleString() : "—"}
            detail={statistics ? plural(statistics.messages, "message") : undefined}
          />
          <StatTile
            label="Storage"
            value={
              statistics === null && entry.folder?.bytes == null
                ? "—"
                : formatByteSize(projectStorageBytes(entry))
            }
            detail={entry.folder?.measuring ? "Measuring the folder…" : "folder and chats"}
          />
          <StatTile
            label="Tokens · 30 days"
            value={statistics ? formatTokenCount(totalTokens(statistics.tokens.last30Days)) : "—"}
            detail={
              statistics && statistics.tokens.last30Days.costUsd > 0
                ? `${formatUsdAmount(statistics.tokens.last30Days.costUsd)} at API rates`
                : undefined
            }
          />
        </div>
      </div>

      {statistics ? (
        <>
          <TokenUsageSection
            statistics={statistics}
            generatedAt={generatedAt}
            providers={providers}
            trackingSince={tokenTrackingSince}
          />
          <StorageSection statistics={statistics} folder={entry.folder} />
          <ChatsSection
            statistics={statistics}
            onOpenThread={(threadId) =>
              void navigate({
                to: "/$environmentId/$threadId",
                params: { environmentId: project.environmentId, threadId },
              })
            }
          />
        </>
      ) : (
        <p className="px-3 text-sm text-muted-foreground sm:px-4">
          {isLoading ? "Loading this project's numbers…" : "No numbers for this project yet."}
        </p>
      )}

      <SettingsSection title={builtIn ? "Built-in project" : "Remove project"}>
        <div className="flex flex-col gap-3 rounded-xl border border-[var(--line)] bg-card px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="max-w-xl text-[13px] leading-[1.45] text-muted-foreground">
            {builtIn
              ? "Solla Code keeps the orchestrator's and agents' chats here, so this project can't be renamed or removed. Delete or archive its chats instead."
              : "Removes the project from Solla Code and deletes all of its chats, with their history, attachments, and artifacts. Nothing in its folder is deleted."}
          </p>
          {builtIn ? null : (
            <Button
              variant="destructive-outline"
              className="shrink-0"
              onClick={() => setDeleting(entry)}
            >
              <Trash2Icon />
              Remove project…
            </Button>
          )}
        </div>
      </SettingsSection>

      <DeleteProjectDialog
        target={deleting}
        onClose={() => setDeleting(null)}
        onDeleted={backToList}
      />
    </SettingsPageContainer>
  );
}

function BackLink({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1.5 px-3 text-sm text-muted-foreground transition-colors hover:text-foreground sm:px-4"
    >
      <ArrowLeftIcon className="size-3.5" />
      All projects
    </button>
  );
}

function ShareBar({
  segments,
}: {
  segments: ReadonlyArray<{ key: string; fraction: number; className: string }>;
}) {
  return (
    <div className="flex h-2 w-full overflow-hidden rounded-full bg-[var(--line)]">
      {segments
        .filter((segment) => segment.fraction > 0)
        .map((segment) => (
          <div
            key={segment.key}
            className={cn("h-full", segment.className)}
            style={{ width: `${segment.fraction * 100}%` }}
          />
        ))}
    </div>
  );
}

function Legend({
  items,
}: {
  items: ReadonlyArray<{ key: string; label: string; value: string; className: string }>;
}) {
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
      {items.map((item) => (
        <div key={item.key} className="min-w-0">
          <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className={cn("size-2 shrink-0 rounded-full", item.className)} />
            <span className="truncate">{item.label}</span>
          </dt>
          <dd className="mt-0.5 text-sm font-medium text-foreground tabular-nums">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "space-y-5 rounded-xl border border-[var(--line)] bg-card p-4 sm:p-5",
        className,
      )}
    >
      {children}
    </div>
  );
}

function TokenUsageSection({
  statistics,
  generatedAt,
  providers,
  trackingSince,
}: {
  statistics: OrchestrationProjectStatistics;
  generatedAt: string | null;
  providers: Parameters<typeof providerUsageRows>[1];
  trackingSince: string | null;
}) {
  const { allTime, last30Days, daily, byProvider } = statistics.tokens;
  const series = useMemo(
    () => (generatedAt === null ? [] : dailyTokenSeries(daily, generatedAt)),
    [daily, generatedAt],
  );
  const providerRows = useMemo(
    () => providerUsageRows(byProvider, providers),
    [byProvider, providers],
  );
  const mix = tokenSegments(allTime);

  return (
    <SettingsSection title="Token usage">
      <Card>
        <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-2">
          <div>
            <div className="text-xs text-muted-foreground">Last 30 days</div>
            <div className="text-2xl font-semibold tracking-[-0.03em] text-foreground tabular-nums">
              {formatTokenCount(totalTokens(last30Days))}
              <span className="ms-2 text-sm font-normal text-muted-foreground">
                tokens · {plural(last30Days.turns, "turn")}
                {last30Days.costUsd > 0 ? ` · ${formatUsdAmount(last30Days.costUsd)}` : ""}
              </span>
            </div>
          </div>
          <div className="text-right">
            <div className="text-xs text-muted-foreground">All time</div>
            <div className="text-sm font-medium text-foreground tabular-nums">
              {formatTokenCount(totalTokens(allTime))} tokens
              {allTime.costUsd > 0 ? ` · ${formatUsdAmount(allTime.costUsd)}` : ""}
            </div>
          </div>
        </div>

        {series.length > 0 ? <DailyTokenChart series={series} /> : null}

        {totalTokens(allTime) > 0 ? (
          <>
            <div className="space-y-3">
              <div className="text-xs font-medium text-muted-foreground">What the tokens were</div>
              <ShareBar
                segments={mix.map((segment) => ({
                  key: segment.key,
                  fraction: segment.fraction,
                  className: TOKEN_SEGMENT_CLASS[segment.key],
                }))}
              />
              <Legend
                items={mix.map((segment) => ({
                  key: segment.key,
                  label: segment.label,
                  value: formatTokenCount(segment.value),
                  className: TOKEN_SEGMENT_CLASS[segment.key],
                }))}
              />
              {allTime.reasoningTokens > 0 ? (
                <p className="text-xs text-muted-foreground">
                  Output includes {formatTokenCount(allTime.reasoningTokens)} reasoning tokens.
                </p>
              ) : null}
            </div>

            <div className="space-y-3">
              <div className="text-xs font-medium text-muted-foreground">By provider</div>
              <ul className="space-y-3">
                {providerRows.map((row) => (
                  <li key={row.key} className="space-y-1.5">
                    <div className="flex items-baseline justify-between gap-4 text-sm">
                      <span className="min-w-0 truncate text-foreground">
                        {row.label}
                        <span className="ms-2 text-xs text-muted-foreground">
                          {plural(row.turns, "turn")}
                        </span>
                      </span>
                      <span className="shrink-0 text-foreground tabular-nums">
                        {formatTokenCount(row.tokens)}
                        {row.costUsd > 0 ? (
                          <span className="text-muted-foreground">
                            {" "}
                            · {formatUsdAmount(row.costUsd)}
                          </span>
                        ) : null}
                      </span>
                    </div>
                    <div className="h-1 w-full overflow-hidden rounded-full bg-[var(--line)]">
                      <div
                        className="h-full rounded-full bg-gold-500"
                        style={{ width: `${row.fraction * 100}%` }}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          </>
        ) : null}
      </Card>
      <TrackingNote since={trackingSince} />
    </SettingsSection>
  );
}

function DailyTokenChart({
  series,
}: {
  series: ReadonlyArray<{ readonly day: string; readonly tokens: number }>;
}) {
  const [hovered, setHovered] = useState<number | null>(null);
  const peak = Math.max(0, ...series.map((entry) => entry.tokens));
  const scale = Math.max(1, peak);
  const focus = hovered === null ? null : (series[hovered] ?? null);
  const dayLabel = (day: string) => DAY_LABEL.format(new Date(`${day}T00:00:00.000Z`));

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between text-xs text-muted-foreground">
        <span>{focus ? dayLabel(focus.day) : "Tokens per day"}</span>
        <span className="tabular-nums">
          {focus
            ? `${formatTokenCount(focus.tokens)} tokens`
            : peak > 0
              ? `Busiest day ${formatTokenCount(peak)}`
              : "Nothing yet"}
        </span>
      </div>
      <div
        className="flex h-24 items-end gap-[3px]"
        role="img"
        aria-label={`Tokens per day over the last ${series.length} days, busiest ${formatTokenCount(peak)}`}
        onPointerLeave={() => setHovered(null)}
      >
        {series.map((entry, index) => (
          <div
            key={entry.day}
            className="flex h-full min-w-0 flex-1 items-end"
            onPointerEnter={() => setHovered(index)}
          >
            <div
              className={cn(
                "w-full rounded-[2px]",
                entry.tokens === 0
                  ? "bg-[var(--line-strong)]"
                  : hovered === index
                    ? "bg-gold-400"
                    : "bg-gold-600",
              )}
              style={{
                height:
                  entry.tokens === 0 ? "2px" : `${Math.max(4, (entry.tokens / scale) * 100)}%`,
              }}
            />
          </div>
        ))}
      </div>
      <div className="flex justify-between text-[11px] text-muted-foreground">
        <span>{series[0] ? dayLabel(series[0].day) : ""}</span>
        <span>Today</span>
      </div>
    </div>
  );
}

function StorageSection({
  statistics,
  folder,
}: {
  statistics: OrchestrationProjectStatistics;
  folder: ProjectOverview["folder"];
}) {
  const segments = storageSegments(statistics.storage, folder?.bytes ?? null);
  const total = projectStorageBytes({ statistics, folder });
  const notes = folderUsageNotes(folder);
  return (
    <SettingsSection title="Storage">
      <Card>
        <div className="flex items-baseline justify-between gap-4">
          <div className="text-2xl font-semibold tracking-[-0.03em] text-foreground tabular-nums">
            {formatByteSize(total)}
          </div>
          <div className="text-xs text-muted-foreground">
            {folder?.measuring
              ? "Measuring the folder…"
              : folder?.measuredAt
                ? `Folder measured ${formatRelativeTimeLabel(folder.measuredAt)}`
                : "folder and chats"}
          </div>
        </div>
        <ShareBar
          segments={segments.map((segment) => ({
            key: segment.key,
            fraction: segment.fraction,
            className: STORAGE_SEGMENT_CLASS[segment.key],
          }))}
        />
        <Legend
          items={segments.map((segment) => ({
            key: segment.key,
            label: segment.label,
            value: formatByteSize(segment.value),
            className: STORAGE_SEGMENT_CLASS[segment.key],
          }))}
        />
        {notes.map((note) => (
          <p key={note} className="text-xs leading-relaxed text-muted-foreground">
            {note}
          </p>
        ))}
        {statistics.storage.worktrees > 0 ? (
          <p className="text-xs leading-relaxed text-muted-foreground">
            {plural(statistics.storage.worktrees, "git worktree")} made for these chats{" "}
            {statistics.storage.worktrees === 1 ? "lives" : "live"} outside the folder and{" "}
            {statistics.storage.worktrees === 1 ? "isn't" : "aren't"} counted.
          </p>
        ) : null}
      </Card>
    </SettingsSection>
  );
}

function ChatsSection({
  statistics,
  onOpenThread,
}: {
  statistics: OrchestrationProjectStatistics;
  onOpenThread: (threadId: OrchestrationProjectStatistics["threads"][number]["threadId"]) => void;
}) {
  const total = statistics.activeThreads + statistics.archivedThreads;
  if (total === 0) return null;
  return (
    <SettingsSection title="Chats">
      <div className="overflow-hidden rounded-xl border border-[var(--line)] bg-card">
        <div className="hidden grid-cols-[minmax(0,1fr)_5rem_5rem_5rem] gap-4 border-b border-[var(--line)] px-4 py-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase sm:grid">
          <span>Largest first</span>
          <span className="text-right">Turns</span>
          <span className="text-right">Storage</span>
          <span className="text-right">Tokens</span>
        </div>
        <ul className="divide-y divide-[var(--line)]">
          {statistics.threads.map((thread) => (
            <li key={thread.threadId}>
              <button
                type="button"
                onClick={() => onOpenThread(thread.threadId)}
                className="grid w-full grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-0.5 px-4 py-2.5 text-left transition-colors hover:bg-surface-hover sm:grid-cols-[minmax(0,1fr)_5rem_5rem_5rem]"
              >
                <span className="min-w-0">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-sm text-foreground">{thread.title}</span>
                    {thread.archived ? <Badge variant="outline">Archived</Badge> : null}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {formatRelativeTimeLabel(thread.lastActivityAt)}
                  </span>
                </span>
                <span className="hidden text-right text-sm text-muted-foreground tabular-nums sm:block">
                  {thread.turns.toLocaleString()}
                </span>
                <span className="text-right text-sm text-foreground tabular-nums">
                  {formatByteSize(thread.historyBytes + thread.fileBytes)}
                </span>
                <span className="hidden text-right text-sm text-muted-foreground tabular-nums sm:block">
                  {thread.tokens > 0 ? formatTokenCount(thread.tokens) : "—"}
                </span>
              </button>
            </li>
          ))}
        </ul>
        {statistics.threads.length < total ? (
          <div className="border-t border-[var(--line)] px-4 py-2 text-xs text-muted-foreground">
            The {statistics.threads.length} largest of {total.toLocaleString()} chats.
          </div>
        ) : null}
      </div>
    </SettingsSection>
  );
}
