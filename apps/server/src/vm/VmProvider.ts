/**
 * VmProvider - the seam between the Agent Stack and a concrete virtualization
 * backend.
 *
 * The manager owns agent identity, persistence, and streaming; a provider owns
 * only the mechanics of a VM: provision, start, stop, delete, and capture a
 * frame. This lets the whole feature be exercised end-to-end against
 * {@link VmProviderMock} today (deterministic, synthetic frames) while the real
 * {@link https://github.com/trycua/cua Lume} backend is implemented behind the
 * same interface.
 */
import {
  type VmAgentInput,
  VmId,
  VmProviderError,
  type VmScreenImageFormat,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export interface VmCapturedFrame {
  readonly width: number;
  readonly height: number;
  readonly format: VmScreenImageFormat;
  /** Base64-encoded image bytes. */
  readonly data: string;
  /**
   * The agent's pointer position in frame pixel coordinates, when the backend
   * can report it (the viewer overlays a live cursor from this). Omit if
   * unknown.
   */
  readonly cursor?: { readonly x: number; readonly y: number };
}

export interface VmProviderShape {
  /** Human-readable backend name, surfaced in diagnostics. */
  readonly name: string;

  /** Whether the backend can actually run VMs on this host right now. */
  readonly isAvailable: () => Effect.Effect<boolean>;

  /** Provision a new VM (e.g. clone the golden image). Idempotent by vmId. */
  readonly create: (input: {
    readonly vmId: VmId;
    readonly agentName: string;
  }) => Effect.Effect<void, VmProviderError>;

  /** Boot the VM and return its guest IP once reachable (null if not yet known). */
  readonly start: (
    vmId: VmId,
  ) => Effect.Effect<{ readonly guestIp: string | null }, VmProviderError>;

  /** Suspend/stop the VM, preserving its disk (its persisted logins). */
  readonly stop: (vmId: VmId) => Effect.Effect<void, VmProviderError>;

  /** Destroy the VM and its disk. */
  readonly delete: (vmId: VmId) => Effect.Effect<void, VmProviderError>;

  /** Capture one screen frame for the live view / agent perception. */
  readonly capture: (vmId: VmId) => Effect.Effect<VmCapturedFrame, VmProviderError>;

  /**
   * Inject one user input event (pointer/keyboard/scroll) into the guest. Only
   * called while the user holds control; coordinates are normalized 0..1 across
   * the frame.
   */
  readonly input: (vmId: VmId, input: VmAgentInput) => Effect.Effect<void, VmProviderError>;
}

export class VmProvider extends Context.Service<VmProvider, VmProviderShape>()(
  "t3/vm/VmProvider",
) {}
