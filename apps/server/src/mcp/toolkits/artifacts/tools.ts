import { Tool, Toolkit } from "effect/unstable/ai";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { ThreadArtifactService } from "../../../artifacts/ThreadArtifactService.ts";
import * as ServerSecretStore from "../../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../../config.ts";
import * as WorkspacePaths from "../../../workspace/WorkspacePaths.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  ThreadArtifactToolError,
  ThreadArtifactToolInput,
  ThreadArtifactToolResult,
} from "./types.ts";

export const ThreadArtifactTool = Tool.make("thread_artifact", {
  description:
    "Create and manage durable artifacts owned by this chat. Artifacts are stored by the Solla host and open on desktop or remote/mobile clients. Use list/get to inspect them; publish creates a new immutable revision; archive is reversible. The server binds every operation to this chat, so never provide a thread id. Give every publish a stable lowercase key; reusing that key updates the same artifact without remembering artifactId. For structured or markdown artifacts publish one UTF-8 text file; for image/PDF use dataBase64; for web publish a self-contained HTML/CSS/classic-JS bundle and name its HTML entryPath. Optional SVG icons are sanitized and fall back to a generated icon when unsafe.",
  parameters: ThreadArtifactToolInput,
  success: ThreadArtifactToolResult,
  failure: ThreadArtifactToolError,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
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
