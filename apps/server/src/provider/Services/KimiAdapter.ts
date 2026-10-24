/**
 * KimiAdapter — shape type for the Kimi Code provider adapter.
 *
 * The driver ({@link ../Drivers/KimiDriver}) bundles one adapter per instance
 * as a captured closure; this interface is the naming anchor for that bundle.
 *
 * @module KimiAdapter
 */
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export interface KimiAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}
