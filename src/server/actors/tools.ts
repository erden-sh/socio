// Must stay first: see packages/foundation/src/no-vendor-telemetry.ts.
import '@socio/foundation/no-vendor-telemetry';
import { defineTool, type ToolDefinition } from '@copilotkit/runtime/v2';
import { z } from 'zod';

import { appInRuntime } from '@socio/foundation/apps/runtime-status';
import type { DotTurn } from '@socio/foundation/turns/turn';
import {
    APP_ACCESS_LEVELS,
    APP_ACCESS_SCOPES,
    GRANT_MINUTES,
    closeScopes,
    type ActorDenyReason,
    type Audience,
    type GrantConversationKind,
} from '@socio/shared/actor-scopes';
import { pluginAudience } from '@socio/shared/plugins/plugins';
import {
    ACCESS_CAPABILITY,
    CARD_TEXT,
    SOCIO_ACCESS_PENDING,
    grantAccess,
    minutesText,
} from '@socio/shared/socio-access';

import { ApprovalError } from '../approvals/contract.js';
import type { FlagsShape } from '../flags/contract.js';

import { appFactsOf, newCorrelation, pluginFactsOf, type ActorActionServices } from './approvals.js';
import { accessVerb, cardLabel, type AccessPayload } from './consent.js';
import type { ActorAppRecord, ActorPluginRecord, GrantRecord } from './contract.js';

/** What the socio tools read: socio access, the approvals, the apps, plugins and workspace, and the flags. */
export interface ActorToolServices extends ActorActionServices {
    readonly flags: FlagsShape;
}

/**
 * The socio tools of delegated app access (CB-232):
 * `request_app_access` asks the person (or reuses a grant from this
 * conversation) and `end_app_access` ends it. The flag
 * `socio-actor-access` hides both while it is off for the person, and
 * each checks it again. The person is always the turn's, never input.
 */
export const ACTOR_TOOL_NAMES: readonly string[] = ['request_app_access', 'end_app_access'];

const REQUEST = `Ask the person you act for to let you use one of their mini apps or plugins for them, for one task, before you open it with the app tools or use the plugin's tools. Name the app (its name or id from Apps) or the plugin (its name, or plugin:<id>), say in one sentence what you need it for (they see your words, quoted as yours), and ask for the least access that does the job: "read" sees the app and its data; "write" also changes the app's own data; "act" also lets you ask for its consequential actions (sending, paying, deleting), each approved on its own. Access lasts the minutes you ask for (default 60, at most 480) and ends after 30 idle minutes.
It answers "granted" with a grant id the app tools take (a grant from this conversation is reused when it covers the request), or "pending_approval": the person decides on a card in this chat; don't retry while it waits, the decision comes back to you here. Write and act always wait for the person. It is refused in Telegram groups and topics (ask in a private chat) and for apps that haven't adopted socio access. Never ask for access to work around a refusal.`;

const END = `End your access to a mini app or plugin for the person you act for, as soon as the task is done: name the grant id, or the app or plugin, or nothing to end every grant you hold in this conversation. Ended access can't be used again; ask anew if you need it later.`;

/** What a refusal tells the socio, by reason (the person sees the card). */
const REFUSED: Partial<Record<ActorDenyReason, string>> = {
    feature_off: 'Socio access to apps isn’t available to this person.',
    person_inactive: 'This person’s account can’t grant access now.',
    person_no_access: 'This person can’t open that app, so you can’t either.',
    socio_unavailable: 'This person can’t use you now.',
    audience_unavailable: 'This app hasn’t adopted socio access; its owner can add it.',
    conversation_shared:
        'Delegated app access isn’t available in Telegram groups and topics: ask me in a private chat.',
    conversation_gone: 'This conversation is archived or gone.',
    conversation_changed: 'This conversation changed; ask again.',
    contract_outdated: 'Socio access waits until every server runs this version; try again in a few minutes.',
    policy_stale: 'The app changed what it does; ask again.',
};

/** A plugin's refusal when it can't be delegated (CB-232). */
const PLUGIN_UNAVAILABLE = 'This plugin hasn’t adopted socio access, or it is disabled; an admin can tell you more.';

/** What `request_app_access` names: an app, or a plugin (CB-232). */
type AccessTarget =
    | { kind: 'app'; app: ActorAppRecord; audience: Audience }
    | { kind: 'plugin'; plugin: ActorPluginRecord; audience: Audience };

class Refusal extends Error {}

export function actorTools(platform: ActorToolServices, turn: DotTurn): ToolDefinition[] {
    const { actors, apps, approvals, workspace, flags, plugins } = platform;
    const refuse = (message: string): never => {
        throw new Refusal(message);
    };
    const attempt = async (work: () => Promise<unknown>) => {
        turn.check();
        try {
            if (!flags.enabled('socio-actor-access', turn.userId)) {
                refuse(REFUSED.feature_off!);
            }
            return await work();
        } catch (error) {
            if (error instanceof Refusal) {
                return { status: 'refused', error: error.message };
            }
            throw error;
        }
    };
    /** A scheduled run's conversation is its schedule. */
    const conversationId = turn.cause?.kind === 'schedule' ? `schedule:${turn.cause.id}` : turn.threadId;
    /**
     * The app the person may open (by id, slug or name), else an installed
     * plugin they may use (by id or name, or `plugin:<id>`): the install's
     * audience decides that, as everywhere (CB-254, CB-232).
     */
    const findTarget = (ref: string): AccessTarget => {
        const wanted = ref.trim().toLowerCase();
        const pluginRef = wanted.startsWith('plugin:') ? wanted.slice('plugin:'.length) : undefined;
        if (pluginRef === undefined && apps.enabled) {
            // The person may open it, and a Space it is shared with is one this
            // socio may read in this chat (CB-181).
            const open = apps.all().filter((app) => apps.socioMayReach(app, turn.userId, turn.threadId, turn.dot.id));
            const app =
                open.find((item) => item.id === wanted) ??
                open.find((item) => item.slug === wanted) ??
                open.find((item) => item.name.toLowerCase() === wanted);
            if (app) {
                return { kind: 'app', app, audience: `app:${app.id}` };
            }
        }
        const person = plugins.activeUser(turn.userId);
        const usable = plugins.list().filter((row) => plugins.mayUse(row, person));
        const name = pluginRef ?? wanted;
        const plugin =
            usable.find((row) => row.id === name) ?? usable.find((row) => row.manifest.name.toLowerCase() === name);
        if (plugin) {
            return { kind: 'plugin', plugin, audience: pluginAudience(plugin.id) };
        }
        if (!apps.enabled && pluginRef === undefined) {
            refuse('Mini apps are not set up on this server.');
        }
        return refuse(
            `No app or plugin "${ref.slice(0, 60)}" that this person can open; check its name under Apps or in the sidebar.`,
        );
    };
    const grantResult = (grant: GrantRecord, reused: boolean) => ({
        status: 'granted',
        grant: grant.id,
        reused,
        access: grantAccess(grant.scopes),
        expiresAt: new Date(grant.expiresAt).toISOString(),
        message: `${reused ? 'Reusing' : 'Granted'}: pass grant ${grant.id} to the app tools. End it with end_app_access when the task is done.`,
    });

    return [
        defineTool({
            name: 'request_app_access',
            description: REQUEST,
            parameters: z.object({
                app: z
                    .string()
                    .min(1)
                    .max(100)
                    .describe('The app’s name or id, as Apps shows it; or a plugin’s name, or plugin:<id>.'),
                task: z
                    .string()
                    .min(1)
                    .max(CARD_TEXT.task)
                    .describe('One sentence: what you need the app for. Shown to the person as your words.'),
                access: z
                    .enum(APP_ACCESS_LEVELS)
                    .optional()
                    .describe('read (default), write or act: the least that does it.'),
                minutes: z
                    .number()
                    .int()
                    .min(GRANT_MINUTES.min)
                    .max(GRANT_MINUTES.max)
                    .optional()
                    .describe(`How long you need it, in minutes (default ${GRANT_MINUTES.default}).`),
            }),
            execute: (input) =>
                attempt(async () => {
                    const access = input.access ?? 'read';
                    const minutes = input.minutes ?? GRANT_MINUTES.default;
                    // Where the answer goes decides whether it may be asked
                    // here at all.
                    const state = await actors.authorizer.conversation(conversationId);
                    // A scheduled run's grant is keyed by its schedule, but it runs
                    // and answers in the task's own thread: a Telegram group or
                    // topic there is refused too.
                    const where =
                        conversationId === turn.threadId ? state : await actors.authorizer.conversation(turn.threadId);
                    if (state === 'telegram-group' || where === 'telegram-group') {
                        refuse(REFUSED.conversation_shared!);
                    }
                    if (state === 'gone') {
                        refuse(REFUSED.conversation_gone!);
                    }
                    const conversationKind = state as GrantConversationKind;
                    const target = findTarget(input.app);
                    // Development apps run code anyone sharing a company socio can
                    // change: only a person-owned socio's, for that person.
                    if (target.kind === 'app' && !appInRuntime(target.app)) {
                        const owner = workspace.dot(target.app.dotId)?.ownerId;
                        if (!owner || owner !== turn.userId) {
                            refuse('This app is still a development app on a shared socio: promote the app first.');
                        }
                    }
                    const audience = target.audience;
                    const policy = actors.audiences.for(audience);
                    const version = policy ? await policy.policyVersion(audience) : undefined;
                    if (!policy || version === undefined) {
                        refuse(target.kind === 'plugin' ? PLUGIN_UNAVAILABLE : REFUSED.audience_unavailable!);
                    }
                    const scopes = closeScopes(APP_ACCESS_SCOPES[access]);
                    // A grant from this conversation that covers it.
                    const reusable = actors.grants.reusable({
                        personId: turn.userId,
                        socioId: turn.dot.id,
                        audience,
                        conversationId,
                        scopes,
                    });
                    if (
                        reusable &&
                        reusable.policyVersion === version &&
                        (
                            await actors.authorizer.authorizeGrant(reusable.id, {
                                fresh: true,
                            })
                        ).allowed
                    ) {
                        return grantResult(reusable, true);
                    }
                    // Every term of the intersection that doesn't need the grant
                    // itself, before the person is asked for something that can't be.
                    if (!actors.issuable()) {
                        refuse(REFUSED.contract_outdated!);
                    }
                    const now = Date.now();
                    const provisional: GrantRecord = {
                        id: 'provisional',
                        personId: turn.userId,
                        socioId: turn.dot.id,
                        audiences: [audience],
                        scopes,
                        resources: null,
                        conversationId,
                        conversationKind,
                        task: input.task,
                        policyVersion: version!,
                        approvalId: null,
                        createdAt: now,
                        expiresAt: now + minutes * 60_000,
                        idleMs: GRANT_MINUTES.idle * 60_000,
                        lastUsedAt: now,
                        revokedAt: null,
                        revokedBy: null,
                        revokeReason: null,
                        replacedBy: null,
                    };
                    const whole = await actors.authorizer.grantDecision(provisional);
                    if (!whole.allowed) {
                        refuse(REFUSED[whole.reason] ?? 'This access can’t be granted.');
                    }
                    const capability = ACCESS_CAPABILITY[access];
                    // The same request waiting already: that card, not a second.
                    const waiting = await approvals.findPending<AccessPayload>(
                        turn.userId,
                        turn.dot.id,
                        capability,
                        (payload) => payload.audience === audience && payload.conversationId === conversationId,
                    );
                    if (waiting) {
                        return waiting;
                    }
                    // A wider request replaces the narrower live grant once approved;
                    // a grant is never widened in place.
                    const narrower = actors.grants
                        .unrevoked({
                            personId: turn.userId,
                            socioId: turn.dot.id,
                            conversationId,
                            audience,
                        })
                        .filter((grant) => grant.expiresAt > now)
                        .at(-1);
                    const facts =
                        target.kind === 'app'
                            ? appFactsOf(platform, target.app.id, turn.userId)!
                            : pluginFactsOf(platform, target.plugin.id, turn.userId)!;
                    const alwaysAsk = !!(await policy!.alwaysAsk?.(audience));
                    const thread = workspace.thread(turn.threadId);
                    const correlationId = newCorrelation();
                    const payload: AccessPayload = {
                        v: 1,
                        audience,
                        appId: target.kind === 'app' ? target.app.id : target.plugin.id,
                        access,
                        scopes,
                        minutes,
                        task: input.task.trim().slice(0, CARD_TEXT.task),
                        conversationId,
                        conversationKind,
                        policyVersion: version!,
                        replaces: narrower?.id ?? null,
                        alwaysAsk,
                        socioName: turn.dot.name,
                        facts,
                        visibleTo: conversationKind === 'room' ? cardLabel(thread?.title || 'this room') : null,
                        correlationId,
                    };
                    actors.audit.recordSoon({
                        correlationId,
                        phase: 'approval',
                        status: 'requested',
                        personId: turn.userId,
                        socioId: turn.dot.id,
                        audience,
                        action: capability,
                        resourceKind: 'conversation',
                        resourceId: conversationId,
                    });
                    let outcome;
                    try {
                        outcome = await approvals.request<AccessPayload>({
                            userId: turn.userId,
                            dotId: turn.dot.id,
                            capability,
                            summary: `${accessVerb(access)} ${facts.label} for ${minutesText(minutes)}`.replace(
                                /^./,
                                (first) => first.toUpperCase(),
                            ),
                            details: [
                                `${facts.label} at ${facts.origin}, owned by ${facts.owner}.`,
                                ...(payload.visibleTo
                                    ? [
                                          `${turn.dot.name}'s answers here are visible to everyone in ${payload.visibleTo}.`,
                                      ]
                                    : []),
                            ],
                            payload,
                            threadId: turn.threadId,
                            ...(turn.runId ? { runId: turn.runId } : {}),
                            alwaysAsk,
                            limit: {
                                max: SOCIO_ACCESS_PENDING.perSocio,
                                capabilities: Object.values(ACCESS_CAPABILITY),
                                by: 'dot',
                                message: `${SOCIO_ACCESS_PENDING.perSocio} access requests already wait for an answer: wait for the person to answer them.`,
                            },
                        });
                    } catch (error) {
                        // The cap on waiting requests: the socio waits.
                        if (error instanceof ApprovalError) {
                            refuse(error.message);
                        }
                        // A bypass whose grant couldn't be made now (the app changed,
                        // a term of the intersection failed): recorded as failed.
                        if (error instanceof Error) {
                            refuse(`The access couldn’t be granted: ${error.message}`);
                        }
                        throw error;
                    }
                    if (outcome.status === 'approved') {
                        const made = actors.grants
                            .unrevoked({
                                personId: turn.userId,
                                socioId: turn.dot.id,
                                conversationId,
                                audience,
                            })
                            .find((grant) => grant.approvalId === outcome.id);
                        return made ? grantResult(made, false) : { status: 'refused', error: outcome.outcome };
                    }
                    return outcome;
                }),
        }),
        defineTool({
            name: 'end_app_access',
            description: END,
            parameters: z.object({
                grant: z.string().max(64).optional().describe('The grant id.'),
                app: z
                    .string()
                    .max(100)
                    .optional()
                    .describe('Or the app’s or plugin’s name or id: every grant for it here.'),
            }),
            execute: (input) =>
                attempt(async () => {
                    // Only this socio's grants for this person, never another
                    // person's, and only from this conversation unless named by id.
                    let grants = actors.grants
                        .unrevoked({ personId: turn.userId, socioId: turn.dot.id })
                        .filter(
                            (grant) =>
                                (input.grant
                                    ? grant.id === input.grant.trim()
                                    : grant.conversationId === conversationId) &&
                                grant.audiences.some(
                                    (audience) => audience.startsWith('app:') || audience.startsWith('plugin:'),
                                ),
                        );
                    if (input.app) {
                        const { audience } = findTarget(input.app);
                        grants = grants.filter((grant) => grant.audiences.includes(audience));
                    }
                    if (!grants.length) {
                        return {
                            status: 'ended',
                            ended: 0,
                            message: 'No access of yours to end here.',
                        };
                    }
                    const ended: string[] = [];
                    const correlationId = newCorrelation();
                    for (const grant of grants) {
                        ended.push(
                            ...(await actors.revoke(
                                { grantId: grant.id },
                                `socio:${turn.dot.id}`,
                                'task_ended',
                                correlationId,
                            )),
                        );
                    }
                    return {
                        status: 'ended',
                        ended: ended.length,
                        grants: ended,
                        message: `Ended ${ended.length} grant${ended.length === 1 ? '' : 's'}.`,
                    };
                }),
        }),
    ];
}
