import type { Audience } from '@socio/shared/actor-scopes';

import type { SocioActor } from './contract.js';

export interface ActorCredentialScope {
    actor: SocioActor;
    /** One audience, or for `cbgw_` the set `{gateway:model, gateway:git}`. */
    audiences: readonly Audience[];
    /** The instance id; one today, carried for multi-node later. */
    workspaceId: string;
    issuedAt: number;
    expiresAt: number;
}

/**
 * The actor-access contract this build enforces. Each runtime records it
 * in `runtime_contracts`; nothing is issued while a live runtime records an
 * older one, or none. Raise it in the change that adds a narrowing check an
 * older runtime would not apply.
 *
 * 2: the data API intersects an app's rights with the `x-cb-obo` actor's
 * and refuses contract apps' writes without one (`dataspace/obo.ts`). A
 * runtime at 1 ignores `x-cb-obo`, so an app's call landing there would
 * act with the app's whole rights: no grant or credential is issued while
 * one is alive.
 */
export const ACTOR_ACCESS_CONTRACT = 2;
export const ACTOR_ACCESS_CONTRACT_NAME = 'actor-access';
