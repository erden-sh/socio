/**
 * What a runtime's gateways are made from, with the coding sessions their
 * module hosts: the gateways' step of the graph (`composition/gateway.ts`, over
 * `layer.ts`) offers it as `HostedGateway`, and the module's hooks read it from
 * the app's services. Nothing is kept per platform: whoever needs the sources
 * reads them from the built context, so each runtime has one model and one Git
 * gateway.
 */
import { Context } from 'effect';
import type { Hono } from 'hono';

import type { AppEnv } from '@socio/foundation/http/app-env';

import type { SessionsShape, ToolsShape } from '../coding/contract.js';

import type { GatewaySources } from './sources.js';

/**
 * Coding sessions, which the gateway's module hosts until coding has
 * a module of its own: their tick and stop, their socio tools, whether
 * they are set up (the `coding` capability), and their routes under
 * `/api/gateway/sessions`.
 */
export interface HostedCoding {
    readonly sessions: SessionsShape;
    readonly tools: ToolsShape;
    routes(): Hono<AppEnv> | undefined;
}

/** What a platform's gateways are made from, and the coding sessions their module hosts. */
export interface AdoptedGateway {
    readonly sources: GatewaySources;
    readonly coding: HostedCoding;
}

/**
 * What the gateways are made from and the coding sessions they host, as
 * the composition adopted them, for the module's hooks: offered by
 * the gateways' step of the graph.
 */
export class HostedGateway extends Context.Service<HostedGateway, AdoptedGateway>()('socio/gateway/HostedGateway') {}

/**
 * What holds a runtime's `HostedGateway` as read from its built context:
 * the tests' view of the runtime (`makeTestRuntime().platform`, whose
 * `gatewayAdopted` is the context's `HostedGateway`).
 */
export interface GatewayHolder {
    readonly gatewayAdopted: { readonly gateway: AdoptedGateway };
}

/** The sources of the gateways `holder`'s runtime built (its `HostedGateway`). */
export const gatewaySourcesOf = (holder: GatewayHolder): GatewaySources => holder.gatewayAdopted.gateway.sources;
