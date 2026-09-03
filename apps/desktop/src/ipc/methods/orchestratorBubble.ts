import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopWindowService from "../../window/DesktopWindow.ts";
import * as OrchestratorBubbleWindow from "../../window/OrchestratorBubbleWindow.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

/**
 * IPC surface of the floating voice orb. Two windows share it: the main window
 * publishes state and controls visibility; the bubble window drags itself and
 * asks for the orchestrator thread. State flows back out on
 * `ORCHESTRATOR_BUBBLE_STATE_CHANNEL` pushes from the window manager.
 */

const OrchestratorBubbleStateSchema = Schema.Struct({
  status: Schema.Literals(["idle", "connecting", "listening", "speaking", "error"]),
  micLevel: Schema.Number,
  assistantLevel: Schema.Number,
});

const OrchestratorBubblePositionSchema = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
});

export const setOrchestratorBubbleVisible = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.ORCHESTRATOR_BUBBLE_SET_VISIBLE_CHANNEL,
  payload: Schema.Boolean,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.orchestratorBubble.setVisible")(function* (visible) {
    const bubble = yield* OrchestratorBubbleWindow.OrchestratorBubbleWindow;
    yield* bubble.setVisible(visible);
  }),
});

export const publishOrchestratorBubbleState = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.ORCHESTRATOR_BUBBLE_PUBLISH_STATE_CHANNEL,
  payload: OrchestratorBubbleStateSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.orchestratorBubble.publishState")(function* (state) {
    const bubble = yield* OrchestratorBubbleWindow.OrchestratorBubbleWindow;
    yield* bubble.publishState(state);
  }),
});

export const setOrchestratorBubbleInteractive = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.ORCHESTRATOR_BUBBLE_SET_INTERACTIVE_CHANNEL,
  payload: Schema.Boolean,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.orchestratorBubble.setInteractive")(function* (interactive) {
    const bubble = yield* OrchestratorBubbleWindow.OrchestratorBubbleWindow;
    yield* bubble.setInteractive(interactive);
  }),
});

export const beginOrchestratorBubbleDrag = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.ORCHESTRATOR_BUBBLE_DRAG_START_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.orchestratorBubble.beginDrag")(function* () {
    const bubble = yield* OrchestratorBubbleWindow.OrchestratorBubbleWindow;
    yield* bubble.beginDrag;
  }),
});

export const moveOrchestratorBubble = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.ORCHESTRATOR_BUBBLE_MOVE_CHANNEL,
  payload: OrchestratorBubblePositionSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.orchestratorBubble.move")(function* (position) {
    const bubble = yield* OrchestratorBubbleWindow.OrchestratorBubbleWindow;
    yield* bubble.move(position);
  }),
});

export const endOrchestratorBubbleDrag = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.ORCHESTRATOR_BUBBLE_DRAG_END_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.orchestratorBubble.dragEnd")(function* () {
    const bubble = yield* OrchestratorBubbleWindow.OrchestratorBubbleWindow;
    yield* bubble.persistPosition;
  }),
});

export const toggleOrchestratorVoiceFromBubble = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.ORCHESTRATOR_BUBBLE_TOGGLE_VOICE_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.orchestratorBubble.toggleVoice")(function* () {
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    // Deliberately no reveal: starting or stopping the microphone is not a
    // reason to pull the whole app in front of what the user is doing. The
    // bubble is excluded from this lookup (markAuxiliary), so this always
    // resolves to a window that can actually host the session.
    const target = yield* electronWindow.currentMainOrFirst;
    if (Option.isNone(target)) return;
    yield* Effect.sync(() => {
      const window = target.value;
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.send(IpcChannels.ORCHESTRATOR_VOICE_TOGGLE_CHANNEL);
      }
    });
  }),
});

export const openOrchestratorFromBubble = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.ORCHESTRATOR_BUBBLE_OPEN_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.orchestratorBubble.open")(function* () {
    const desktopWindow = yield* DesktopWindowService.DesktopWindow;
    // Reveal (or create) the real main window first: with it closed, the
    // menu-action fallback's "focused or first window" could land on the
    // bubble itself, which has no listener. Revealing focuses the main window
    // so the action that follows targets it deterministically.
    yield* desktopWindow.revealOrCreateMain.pipe(Effect.catchCause(() => Effect.void));
    // The menu-action path already knows how to wait for the renderer and
    // hand the action to the web app.
    yield* desktopWindow
      .dispatchMenuAction("open-orchestrator")
      .pipe(Effect.catchCause(() => Effect.void));
  }),
});
