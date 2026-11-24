/**
 * The capabilities' layer: the registry behind `Capabilities`, built from the
 * tags the core capabilities read (the workspace's `WorkspaceSettings`, spaces'
 * `Access`, the `Conversations` slice, computers' `ComputerRecords`, the
 * sections' ports `CapabilityIdentity` and `CapabilityRequests`, and
 * `CapabilitiesConfig`), then each module's. Only the composition root
 * (`composition/capabilities.ts`) and tests import this file.
 */
import { Effect, Layer } from 'effect';

import { ComputerRecords } from '../computers/contract.js';
import { WorkspaceSettings } from '../settings/contract.js';
import { Access } from '../spaces/contract.js';
import { Conversations } from '../workspace/contract.js';

import {
    Capabilities,
    CapabilitiesConfig,
    CapabilityIdentity,
    CapabilityRequests,
    type CapabilityDefinition,
} from './contract.js';
import { capabilityRegistry } from './core.js';

/**
 * The registry: the core capabilities over their tags, then the modules'
 * definitions (`modules`, read once the core ones are registered; the
 * composition passes each module's `capabilities` hook in registry order).
 */
export const makeCapabilities = (modules: () => Iterable<CapabilityDefinition>) =>
    Effect.gen(function* () {
        const needs = {
            settings: yield* WorkspaceSettings,
            access: yield* Access,
            conversations: yield* Conversations,
            computers: yield* ComputerRecords,
            identity: yield* CapabilityIdentity,
            requests: yield* CapabilityRequests,
            config: yield* CapabilitiesConfig,
        };
        return capabilityRegistry(needs, modules());
    });

/** `Capabilities`, built once over its tags and the modules' definitions. */
export const CapabilitiesLive = (modules: () => Iterable<CapabilityDefinition>) =>
    Layer.effect(Capabilities, makeCapabilities(modules));
