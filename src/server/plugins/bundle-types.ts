/**
 * What a bundled plugin is and what it is given: the types the bundles
 * (`calendar/`, `planner/`) implement, apart from the registry that imports
 * them (`bundled.ts`, which re-exports them), so the bundles don't import the
 * registry back.
 */
import type { DatabaseSync } from 'node:sqlite';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Hono } from 'hono';
import type { z } from 'zod';

import type { AppEnv } from '@socio/foundation/http/app-env';
import type { PluginManifest } from '@socio/shared/plugins/plugins';
import type { User } from '@socio/shared/types';

/**
 * What a bundled plugin's routes, tools and feeds get from Socio. The
 * person is always the real one (from the session, the connected agent's
 * grant or the socio's turn), never an id the plugin chose.
 */
export interface PluginContext {
    db: DatabaseSync;
    /** The plugin's id. */
    id: string;
    /** The install's settings (manifest `config`), as the admin saved them. */
    config: () => Record<string, string>;
    /** People who can sign in now, for names and roles. */
    users: () => User[];
    /** Whether `person` is in the install's audience (admins always are). */
    mayUse: (person: User) => boolean;
    /** The workspace's time zone (Operations), UTC unless an admin set one. */
    workspaceTimeZone: () => string;
    /** A person's own time zone (their profile), when they set one. */
    personTimeZone: (userId: string) => Promise<string | undefined>;
    /** The workspace origin, for links (`https://socio.example`). */
    origin: string;
    log: (line: string) => void;
}

/** Who a tool acts for and through what. */
export interface PluginToolCall {
    person: User;
    /** "Claude Code for Ana", or the socio's name; empty in the page. */
    via: string;
    /** Install permissions this caller may use (the grant's scopes applied). */
    permissions: readonly string[];
    /**
     * A socio acting for `person` (CB-232): while `socio-actor-access` is
     * on for them, every call needs a live grant of this socio, person and
     * conversation for `plugin:<id>` that covers the tool's tier.
     */
    socio?: { id: string; conversationId: string };
}

/**
 * One tool a bundled plugin gives connected agents (`/mcp`) and in-app
 * socios alike. `permission` is one of the manifest's `permissions`; the
 * install grants it, and a connected agent also needs the matching scope.
 */
export interface PluginToolDefinition {
    name: string;
    description: string;
    permission: string;
    input: z.ZodRawShape;
    annotations: { readOnlyHint: boolean; destructiveHint: boolean };
    run: (args: Record<string, unknown>, call: PluginToolCall, ctx: PluginContext) => Promise<object>;
}

/**
 * Plugins whose code ships in this build. A bundled plugin still does
 * nothing until this instance's catalog offers it (`PLUGIN_CATALOGS` lists
 * `bundled:<id>`, CB-371) and an admin installs it.
 * A file catalog cannot replace one of these manifests.
 */
export interface BundledPlugin {
    manifest: PluginManifest;
    /**
     * Routes under `/api/plugins/:id/data`: for the plugin's service, and
     * for people in the install's audience, whose user the routes get.
     */
    data?: (ctx: PluginContext) => Hono<AppEnv>;
    /** Tools for connected agents and in-app socios (`PluginToolDefinition`). */
    tools?: readonly PluginToolDefinition[];
    /**
     * Answers `/plugin-feeds/:id/:token`, with no session: a token the
     * plugin issued (a calendar subscription). Undefined is 404.
     */
    feed?: (ctx: PluginContext, token: string) => Promise<Response | undefined>;
    /** The planner's own MCP registration, from before `tools`. */
    contributeMcp?: (
        server: McpServer,
        ctx: {
            person: User;
            origin: string;
            db: DatabaseSync;
            permissions: readonly string[];
        },
    ) => void;
}
