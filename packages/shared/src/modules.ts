/**
 * Module ids, shared by the client and the server registries. A feature
 * that has a module on both sides uses the same id on both (and the same
 * access: `packages/client/tests/client-modules.test.tsx` checks it). Server ids also name
 * a module's `schema_migrations` rows and its `/api/<id>` prefix, so they
 * never change once shipped.
 */
export const MODULE_IDS = {
    help: 'help',
    chat: 'chat',
    spaces: 'spaces',
    activity: 'activity',
    memories: 'memories',
    learning: 'learning',
    issues: 'issues',
    runs: 'runs',
    telegram: 'telegram',
    settings: 'settings',
    // CB-325: dispatch was removed; the id still names its kept migrations.
    dispatch: 'dispatch',
    operator: 'operator',
    data: 'data',
    approvals: 'approvals',
    apps: 'apps',
    schedules: 'schedules',
    domains: 'domains',
    media: 'media',
    notifications: 'notifications',
    dots: 'dots',
    connectedAgents: 'connected-agents',
    computers: 'computers',
    web: 'web',
    chatSkills: 'chat-skills',
    operations: 'operations',
    mcpConnections: 'mcp-connections',
    updates: 'updates',
    flags: 'flags',
    ask: 'ask',
    rooms: 'rooms',
    cycles: 'cycles',
    classify: 'classify',
    plugins: 'plugins',
    // CB-232, CB-239: server only (no client module).
    actors: 'actors',
    gateway: 'gateway',
    // CB-325: the GitHub App, server only (its card is in Settings → General).
    github: 'github',
    // Socio Secrets, phase 1: server only (its card is in Settings → Secrets).
    workspaceSecrets: 'workspace-secrets',
    // CB-330: a socio's own Soul edit tool, server only (no tables of its own;
    // the Soul's table is the workspace schema's).
    souls: 'souls',
    // CB-292: content-based name suggestions for rooms and chats, server only.
    chatNames: 'chat-names',
} as const;

export type ModuleId = (typeof MODULE_IDS)[keyof typeof MODULE_IDS];
