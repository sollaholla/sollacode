import { Tool, Toolkit } from "effect/unstable/ai";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { ThreadArtifactService } from "../../../artifacts/ThreadArtifactService.ts";
import * as ServerSecretStore from "../../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../../config.ts";
import * as WorkspacePaths from "../../../workspace/WorkspacePaths.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  ThreadArtifactToolError,
  ThreadArtifactToolInput,
  ThreadArtifactToolResult,
} from "./types.ts";

export const ThreadArtifactTool = Tool.make("thread_artifact", {
  description:
    "Create and manage durable artifacts owned by this chat. Artifacts are stored by the Solla host and open on desktop or remote/mobile clients. Use list/get to inspect them; publish creates a new immutable revision; archive is reversible. The server binds every operation to this chat, so never provide a thread id; a connected side chat operates on its parent chat's artifacts (list, publish, archive) until it is promoted or the parent is gone. Give every publish a stable lowercase key; reusing that key updates the same artifact without remembering artifactId. Updating IS publishing again under that key — do not create a second artifact and do not ask the user how to update. Two things to get right when you do. Each revision REPLACES the previous one and is served from exactly the files in that call, so a publish must carry the complete file set, not only what changed: re-send the unchanged files alongside the edited ones or they are gone from the new revision. And for files already on disk, set `localPath` on the entry and `localDir` on the call: the host reads and encodes them, so the bytes never pass through your context. Prefer that over `dataBase64` for anything on disk — inline bytes have to be emitted verbatim in one response, which caps a bundle at roughly one reply and truncates mid-string past it. Every `localPath` must resolve inside `localDir`, symlinks included. Reserve `text`/`dataBase64` for content you are generating right now. For structured or markdown artifacts publish one UTF-8 text file; for image/PDF use dataBase64; for web publish a self-contained HTML/CSS/classic-JS bundle and name its HTML entryPath. A revision is served from exactly the files you pass, with no access to the workspace or the filesystem, so every image, font, stylesheet, and script the page loads must either be in `files` (binary assets base64-encoded in `dataBase64`, with the matching contentType) or be inlined as a `data:` URI. A relative path you did not upload renders as a broken image, so do not reference `img/...` unless those entries are in the same publish call; publishing one is rejected rather than served broken. Optional SVG icons are sanitized and fall back to a generated icon when unsafe.",
  parameters: ThreadArtifactToolInput,
  success: ThreadArtifactToolResult,
  failure: ThreadArtifactToolError,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ProjectionSnapshotQuery.ProjectionSnapshotQuery,
    ThreadArtifactService,
    FileSystem.FileSystem,
    Path.Path,
    ServerConfig.ServerConfig,
    ServerSecretStore.ServerSecretStore,
    WorkspacePaths.WorkspacePaths,
  ],
})
  .annotate(Tool.Title, "Manage thread artifacts")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false)
  .annotate(Tool.Meta, { "anthropic/alwaysLoad": true });

export const ThreadArtifactToolkit = Toolkit.make(ThreadArtifactTool);
