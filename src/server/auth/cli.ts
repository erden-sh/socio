import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { openDatabase, sqliteData } from '@socio/data/open';
import { dataKeysFromEnv } from '@socio/foundation/keys/data-keys';
import { isAdmin, ROLES } from '@socio/shared/roles';
import type { Role } from '@socio/shared/types';

import { databaseRevocations } from '../actors/revocations.js';
import { AgentGrants } from '../agents/grants.js';
import { deleteAppSessionsOf } from '../apps/service.js';
import { authFromEnv } from '../composition/auth.js';
import { openCoreStore } from '../composition/core-store.js';
import { deviceEndHooks } from '../composition/device-ends.js';
import { workspaceStoreParts } from '../composition/workspace-parts.js';
import { chatGptEndpointsFromEnv, chatGptKind } from '../inference/chatgpt-kind.js';
import { claudeApiKeyKind } from '../inference/claude-api-key-kind.js';
import { fakeByoKind } from '../inference/fake-byo.js';
import { InferenceService } from '../inference/service.js';
import { McpConnections } from '../mcp/connections.js';
import { McpConnectionRepository } from '../mcp/infra/sqlite/repository.js';
import { bootDatabase } from '../modules/boot.js';
import { sqliteNotificationRepositories } from '../notifications/infra/sqlite/index.js';
import { deletePluginAccessOf } from '../plugins/infra/repository.js';
import { ServiceAccounts } from '../service-accounts/service-accounts.js';
import { WorkspaceStore } from '../workspace/workspace.js';

import { accessPolicyLine, readStoredPolicy, resetStoredPolicy } from './access-policy-store.js';
import { accountLifecycle } from './accounts.js';
import { BetterAuthProvider } from './better-auth.js';
import type { OwnerChange } from './contract.js';
import { ownerNotice } from './owner-notice.js';

const USAGE =
    'Use: create-user --email E --name N [--role admin|member] [--link USER_ID] [--password-file F] | password-link --email E | deactivate --email E | reactivate --email E | list | access-policy | access-policy-reset';

/** The audit actor of what the CLI does: no one is signed in. */
export const CLI_ACTOR = 'cli';

/**
 * What a deactivation ends, on the database alone (accounts.ts): the
 * CLI runs no job runs or mini app connections of its own. A server that
 * is running stops the person's job runs itself within a second (jobs.ts).
 */
function databaseAccountServices(database: string, env: Record<string, string | undefined>) {
    const connection = openDatabase(database);
    const workspace = new WorkspaceStore(connection, workspaceStoreParts);
    const store = openCoreStore(connection);
    const keys = {
        ...dataKeysFromEnv(env),
        legacy: env.SESSION_SECRET?.trim() || randomBytes(32).toString('base64url'),
    };
    const inference = new InferenceService(workspace.db, {
        secret: keys,
        log: () => {},
    });
    // As the server registers them, so a subscription is revoked as there.
    inference.register(chatGptKind({ endpoints: chatGptEndpointsFromEnv(env) }));
    inference.register(claudeApiKeyKind());
    const fakeByoUrl = env.INFERENCE_FAKE_BYO_URL?.trim();
    if (fakeByoUrl) {
        inference.register(fakeByoKind({ baseUrl: fakeByoUrl }));
    }
    return {
        workspace,
        lifecycle: accountLifecycle({
            workspace,
            serviceAccounts: new ServiceAccounts(workspace.db),
            agentGrants: new AgentGrants(workspace.db),
            actors: databaseRevocations(workspace.db),
            apps: {
                endSessionsOf: async (userId) => (await deleteAppSessionsOf(workspace.db, userId)).ended,
            },
            plugins: {
                endAccessOf: (userId) => deletePluginAccessOf(workspace.db, userId),
            },
            store: store.scheduled,
            jobs: { stopOwnedBy: () => 0 },
            inference,
            mcpConnections: new McpConnections(new McpConnectionRepository(workspace.db), keys, {
                active: () => false,
                socio: () => false,
            }),
        }),
        close: () => {
            store.close();
            workspace.close();
            if (connection.isOpen) {
                connection.close();
            }
        },
    };
}

/**
 * `pnpm run auth …` (auth-cli.ts): account administration on the server
 * for AUTH_PROVIDER=betterauth, with the server's environment. Creates the
 * first admin and test accounts, makes password links,
 * deactivates and reactivates people (the People page's guards and audit),
 * lists accounts.
 * Migrates the database first (with a backup), like a boot would.
 */
export async function authCli(
    argv: string[],
    env: Record<string, string | undefined>,
    print: (line: string) => void = console.log,
) {
    const { positionals, values } = parseArgs({
        args: argv,
        allowPositionals: true,
        options: {
            email: { type: 'string' },
            name: { type: 'string' },
            role: { type: 'string', default: 'admin' },
            link: { type: 'string' },
            'password-file': { type: 'string' },
        },
    });
    const database = env.DATABASE_PATH ?? 'data/company-brain.sqlite';
    const auth = authFromEnv(env, env.HOST ?? '127.0.0.1', { database });
    if (!(auth.provider instanceof BetterAuthProvider)) {
        throw new Error('Set AUTH_PROVIDER=betterauth to manage accounts.');
    }
    const provider = auth.provider;
    bootDatabase(database, {
        backupDirectory: env.BACKUP_DIR ?? 'data/backups',
        keep: Number(env.BACKUP_KEEP ?? 14),
        log: print,
    });
    // Invites as the server makes them: an admin's saved switch over the
    // environment's (CB-352).
    provider.useSavedInviteLinks(() => {
        const connection = openDatabase(database);
        const store = openCoreStore(connection);
        try {
            return store.slices.settings.settings().appInviteLinks;
        } finally {
            store.close();
            if (connection.isOpen) {
                connection.close();
            }
        }
    });
    const linkLines = (link: { url: string; expiresAt: string }) =>
        print(`Password link (one use, until ${link.expiresAt}):\n${link.url}`);
    try {
        switch (positionals[0]) {
            case 'create-user': {
                const role = values.role as Role;
                if ((values.role as string) === 'operator') {
                    throw new Error(
                        'The operator role was retired: use --role admin. Admins hold every power in the workspace; the first admin is also its owner.',
                    );
                }
                if (!ROLES.includes(role)) {
                    throw new Error(USAGE);
                }
                const password = values['password-file']
                    ? readFileSync(values['password-file'], 'utf8').trim()
                    : undefined;
                const id = await provider.createAccount({
                    email: values.email ?? '',
                    name: values.name ?? values.email?.split('@')[0] ?? '',
                    role,
                    ...(values.link ? { userId: values.link } : {}),
                    ...(password ? { password } : {}),
                });
                const account = provider.accounts().find((entry) => entry.id === id)!;
                print(`Created ${account.role} ${account.email} (user ${account.userId}).`);
                // The first admin is the workspace owner (CB-390).
                provider.ensureOwner(CLI_ACTOR).forEach((line) => print(line));
                if (!password) {
                    linkLines(await provider.passwordLink(id));
                }
                return;
            }
            case 'password-link': {
                const email = values.email?.trim().toLowerCase();
                const account = provider.accounts().find((a) => a.email === email);
                if (!account) {
                    throw new Error('No account with that email.');
                }
                linkLines(await provider.passwordLink(account.id));
                return;
            }
            case 'deactivate':
            case 'reactivate': {
                const email = values.email?.trim().toLowerCase();
                const account = provider.accounts().find((a) => a.email === email);
                if (!account) {
                    throw new Error('No account with that email.');
                }
                const deactivate = positionals[0] === 'deactivate';
                if (account.deactivated === deactivate) {
                    print(`${account.email} is ${deactivate ? 'deactivated' : 'active'} already.`);
                    return;
                }
                // From the server's shell the workspace owner may be
                // deactivated (CB-390, at a verified customer contact's
                // request): ownership passes to the earliest-created active
                // admin. The last admin still stays.
                const refusal = deactivate && provider.deactivationRefusal(account, { shell: true });
                if (refusal) {
                    throw new Error(refusal);
                }
                const services = databaseAccountServices(database, env);
                try {
                    provider.onAccountChange(services.lifecycle);
                    // The devices' sign-outs audited and their push
                    // subscriptions removed, as the server does (CB-352).
                    const repositories = sqliteNotificationRepositories(sqliteData(services.workspace.db));
                    const subscriptions = repositories.subscriptions;
                    // The owner deactivated from the shell (CB-390): ownership
                    // passes on, and every active admin finds the notice in
                    // the app (no push from here).
                    const ownerChanges: OwnerChange[] = [];
                    provider.onOwnerChanged((change) => {
                        ownerChanges.push(change);
                    });
                    provider.useDeviceEnds(
                        deviceEndHooks((entries) => services.workspace.auditNow(entries), {
                            byEndpoint: (endpoint) => subscriptions.byEndpoint(endpoint),
                            remove: (userId, id) => subscriptions.removeOwn(userId, id),
                        }),
                    );
                    const changed = deactivate
                        ? await provider.deactivate(account.id, CLI_ACTOR)
                        : await provider.reactivate(account.id, CLI_ACTOR);
                    for (const change of ownerChanges) {
                        const notice = ownerNotice(change);
                        const now = Date.now();
                        for (const admin of provider.users().filter((user) => isAdmin(user))) {
                            const id = randomUUID();
                            await repositories.notifications.insert(
                                id,
                                {
                                    userId: admin.id,
                                    dotId: null,
                                    threadId: null,
                                    trigger: notice.trigger,
                                    causeId: null,
                                    title: notice.title,
                                    message: notice.message,
                                    link: notice.path,
                                    imageToken: null,
                                    presence: 'in_app',
                                },
                                now,
                            );
                            await repositories.inApp.insert({
                                id: randomUUID(),
                                userId: admin.id,
                                notificationId: id,
                                title: notice.title,
                                body: notice.message,
                                link: notice.path,
                                createdAt: now,
                            });
                        }
                        print(
                            `Workspace owner: ${change.to.name} (user ${change.to.userId}); the admins are told in the app.`,
                        );
                    }
                    // What else ended, as the audit line says it.
                    const audit =
                        deactivate && changed.userId
                            ? services.workspace.auditOf('user', changed.userId).at(-1)
                            : undefined;
                    print(
                        `${deactivate ? 'Deactivated' : 'Reactivated'} ${changed.email} (user ${changed.userId || 'none'})${audit?.detail ? `: ${audit.detail}` : ''}.`,
                    );
                } finally {
                    services.close();
                }
                return;
            }
            // The access policy (CB-124): what the app narrows, and the break
            // glass when no admin can sign in or confirm a change: clearing
            // it puts the environment back in force. Audited as `cli`.
            case 'access-policy':
            case 'access-policy-reset': {
                const connection = openDatabase(database);
                try {
                    if (positionals[0] === 'access-policy-reset') {
                        print(
                            resetStoredPolicy(connection, CLI_ACTOR)
                                ? 'Cleared the saved access policy: the environment applies again. Tell the admins; the audit names cli.'
                                : 'Nothing was saved: the environment applies already.',
                        );
                    } else {
                        print(accessPolicyLine(readStoredPolicy(connection)));
                    }
                } finally {
                    connection.close();
                }
                return;
            }
            case 'list':
                for (const account of provider.accounts()) {
                    print(
                        `${account.email}\t${account.role}${account.owner ? ' (owner)' : ''}${account.deactivated ? ' (deactivated)' : ''}\tuser ${account.userId}\t${[
                            account.password && 'password',
                            account.passkeys && `${account.passkeys} passkey(s)`,
                            ...account.providers,
                        ]
                            .filter(Boolean)
                            .join(', ')}`,
                    );
                }
                return;
            default:
                throw new Error(USAGE);
        }
    } finally {
        provider.close();
    }
}
