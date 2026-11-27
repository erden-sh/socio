// What the purge removes with each kind of record, and what it leaves.
//
// Every column of the app's database that names a person, socio, Space,
// page, dataset, app, job, room or conversation is listed here once, with
// how it relates to the record it names (tests/purge.test.ts fails on a
// column of a migrated database that is missing, so a new table has to be
// placed here before it ships):
//
//   owns     the row belongs to the record: it goes with it (sessions,
//            sign-in accounts, memberships, grants, preferences, a
//            conversation's messages);
//   child    the row is a record of its own kind that lives under it (a
//            person's socios, a Space's pages): it must be in the purge
//            list too, or the list must cascade to that kind;
//   history  attribution and audit (who created, decided, commented): the
//            row stays and keeps naming an id that no longer resolves;
//   blocks   something the purge doesn't remove (a schedule, a coding
//            session that still holds a sandbox): any such row refuses
//            the purge.

export const PURGE_KINDS = [
    'users',
    'socios',
    'spaces',
    'pages',
    'datasets',
    'apps',
    'jobs',
    'rooms',
    'conversations',
] as const;
export type PurgeKind = (typeof PURGE_KINDS)[number];

/**
 * The id sets a column can name: a purge kind, or one derived from them.
 * `auth`: the people's sign-in accounts (`auth_user.id`); `owners`: the
 * data space owners, people and socios' shared areas (`socio:<id>`);
 * `threads`: rooms and conversations, which share `thread_bindings`.
 */
export type IdSet = PurgeKind | 'auth' | 'owners' | 'threads';

export type How = 'owns' | 'child' | 'history' | 'blocks';

export interface Reference {
    table: string;
    column: string;
    ids: IdSet;
    how: How;
    /** For `child`: the kind of record the row is. */
    child?: PurgeKind;
    /** Narrows the rows, as SQL on the table's own columns. */
    where?: string;
}

/** A row that goes because a row of `parent` it names by `key` goes. */
export interface Nested {
    table: string;
    column: string;
    parent: string;
    key: string;
}

/** Where each kind's own rows are. */
export const ENTITIES: Record<PurgeKind, { table: string; where?: string }> = {
    users: { table: 'users' },
    socios: { table: 'dots' },
    spaces: { table: 'spaces' },
    pages: { table: 'pages' },
    datasets: { table: 'data_datasets' },
    apps: { table: 'apps' },
    jobs: { table: 'jobs' },
    rooms: { table: 'thread_bindings', where: "kind='room'" },
    conversations: { table: 'thread_bindings', where: "kind<>'room'" },
};

const r = (table: string, column: string, ids: IdSet, how: How, extra: Partial<Reference> = {}): Reference => ({
    table,
    column,
    ids,
    how,
    ...extra,
});
const owns = (table: string, column: string, ids: IdSet, where?: string) =>
    r(table, column, ids, 'owns', where ? { where } : {});
const history = (table: string, column: string, ids: IdSet) => r(table, column, ids, 'history');
const blocks = (table: string, column: string, ids: IdSet, where?: string) =>
    r(table, column, ids, 'blocks', where ? { where } : {});
const child = (table: string, column: string, ids: IdSet, kind: PurgeKind, where?: string) =>
    r(table, column, ids, 'child', { child: kind, ...(where ? { where } : {}) });

/** A coding session that still holds a sandbox or a volume (or isn't ended). */
const CODING_HELD = "state<>'ended' OR sandboxGoneAt IS NULL OR volumeGoneAt IS NULL";
/** A coding session's events, by whether their session still holds one. */
const CODING_EVENTS_HELD = `sessionId IN (SELECT id FROM coding_sessions WHERE ${CODING_HELD})`;

export const REFERENCES: Reference[] = [
    // ---- people and their sign-in accounts ---------------------------------
    owns('auth_user', 'appUserId', 'users'),
    owns('auth_session', 'userId', 'auth'),
    owns('auth_account', 'userId', 'auth'),
    owns('auth_passkey', 'userId', 'auth'),
    owns('auth_activity', 'accountId', 'auth'),
    // CB-352: their devices (the app's installs).
    owns('auth_device', 'userId', 'auth'),
    // CB-352: the sign-in sheet's requests they approved.
    owns('auth_device_request', 'userId', 'auth'),
    // CB-352: the QR codes they made to add a device.
    owns('auth_device_pairing', 'userId', 'auth'),
    // CB-352: the sign-in codes sent to them.
    owns('auth_device_code', 'userId', 'auth'),
    // CB-352: their push endpoints still to clean up.
    owns('auth_device_push_leftover', 'userId', 'auth'),
    // CB-379: a turn of theirs in progress (a lease that runs out).
    owns('auth_device_turn', 'accountId', 'auth'),
    // CB-376: their membership of the workspace organization (their groups).
    owns('auth_member', 'userId', 'auth'),
    owns('auth_oauth_access_token', 'userId', 'auth'),
    owns('auth_oauth_refresh_token', 'userId', 'auth'),
    owns('auth_oauth_consent', 'userId', 'auth'),
    // A registered client others may use: removing it would end their tokens.
    blocks('auth_oauth_client', 'userId', 'auth'),
    history('auth_session', 'impersonatedBy', 'auth'),
    owns('agent_grants', 'userId', 'users'),
    owns('agent_grants', 'authUserId', 'auth'),
    history('agent_grants', 'revokedBy', 'users'),
    owns('service_accounts', 'userId', 'users'),
    history('service_accounts', 'createdBy', 'users'),
    owns('service_keys', 'userId', 'users'),
    history('service_keys', 'createdBy', 'users'),
    // CB-338: a renamed person's seed stays after a purge, so the id it
    // retired is never passed on to someone given it later.
    history('person_seeds', 'userId', 'users'),
    owns('user_preferences', 'userId', 'users'),
    owns('user_profiles', 'userId', 'users'),
    history('user_profiles', 'deletedBy', 'users'),
    owns('user_inference_connections', 'userId', 'users'),
    owns('time_zone_notes', 'userId', 'users'),
    owns('flag_choices', 'userId', 'users'),
    owns('release_seen', 'userId', 'users'),
    owns('release_views', 'userId', 'users'),
    owns('plugin_access_generation', 'userId', 'users'),
    owns('plugin_codes', 'userId', 'users'),
    owns('plugin_sessions', 'userId', 'users'),
    owns('plugin_release_seen', 'userId', 'users'),
    owns('app_launch_codes', 'userId', 'users'),
    owns('app_sessions', 'userId', 'users'),
    owns('telegram_link_codes', 'userId', 'users'),
    owns('telegram_links', 'userId', 'users'),
    owns('telegram_members', 'userId', 'users'),
    owns('telegram_room_codes', 'userId', 'users'),
    owns('notification_images', 'userId', 'users'),
    owns('notification_in_app', 'userId', 'users'),
    owns('notification_push_subscriptions', 'userId', 'users'),
    owns('notifications', 'userId', 'users'),
    owns('notifications', 'dotId', 'socios'),
    owns('notifications', 'threadId', 'threads'),
    owns('approval_guidance', 'userId', 'users'),
    owns('mcp_connections', 'userId', 'users'),
    owns('mcp_grants', 'userId', 'users'),
    owns('mcp_grants', 'dotId', 'socios'),
    owns('mcp_oauth_attempts', 'userId', 'users'),
    owns('mcp_calls', 'userId', 'users'),
    owns('mcp_calls', 'dotId', 'socios'),
    owns('issue_watches', 'userId', 'users'),
    history('issue_watches', 'threadId', 'threads'),
    history('issue_watches', 'cancelThreadId', 'threads'),
    owns('issue_watch_outbox', 'userId', 'users'),
    owns('issue_votes', 'userId', 'users'),
    owns('issue_votes', 'dotId', 'socios'),
    owns('dot_request_notices', 'userId', 'users'),
    owns('dot_request_requesters', 'userId', 'users'),
    owns('dot_request_requesters', 'dotId', 'socios'),
    owns('goals', 'userId', 'users'),
    owns('goals', 'dotId', 'socios'),
    history('goal_comments', 'authorId', 'users'),
    owns('memories', 'userId', 'users'),
    owns('memories', 'dotId', 'socios'),
    history('memories', 'threadId', 'threads'),
    history('memories', 'deletedBy', 'users'),
    owns('memory_episodes', 'userId', 'users'),
    owns('memory_episodes', 'dotId', 'socios'),
    owns('memory_episodes', 'threadId', 'threads'),
    owns('ask_preferences', 'userId', 'users'),
    owns('ask_preferences', 'dotId', 'socios'),
    owns('context_threads', 'userId', 'users'),
    owns('context_threads', 'dotId', 'socios'),
    owns('context_threads', 'threadId', 'threads'),
    owns('approval_policies', 'userId', 'users'),
    owns('approval_policies', 'dotId', 'socios'),
    owns('approval_requests', 'userId', 'users'),
    owns('approval_requests', 'dotId', 'socios'),
    owns('approval_requests', 'threadId', 'threads'),
    owns('approval_notes', 'userId', 'users'),
    owns('approval_notes', 'threadId', 'threads'),
    history('approval_audit', 'userId', 'users'),
    history('approval_audit', 'dotId', 'socios'),
    history('approval_audit', 'actor', 'users'),
    history('approval_auto_decisions', 'userId', 'users'),
    history('approval_auto_decisions', 'dotId', 'socios'),
    owns('chat_steering', 'userId', 'users'),
    owns('chat_steering', 'threadId', 'threads'),
    owns('message_reactions', 'userId', 'users'),
    owns('message_reactions', 'threadId', 'threads'),
    // CB-382: a person's reply reports; what went is at Ingenio for its year, not here.
    owns('cloud_outbox', 'userId', 'users'),
    owns('cloud_outbox', 'threadId', 'threads'),
    owns('page_use_days', 'userId', 'users'),
    owns('page_use_days', 'pageId', 'pages'),
    owns('page_threads', 'userId', 'users'),
    owns('page_threads', 'dotId', 'socios'),
    owns('page_threads', 'pageId', 'pages'),
    owns('page_threads', 'threadId', 'threads'),
    owns('learning_evidence', 'ownerId', 'users'),
    owns('learning_evidence', 'dotId', 'socios'),
    owns('learning_evidence', 'threadId', 'threads'),
    owns('socio_grants', 'personId', 'users'),
    owns('socio_grants', 'socioId', 'socios'),
    owns('socio_grants', 'conversationId', 'threads'),
    history('socio_grants', 'revokedBy', 'users'),
    owns('actor_contexts', 'personId', 'users'),
    owns('actor_contexts', 'socioId', 'socios'),
    history('actor_audit', 'personId', 'users'),
    history('actor_audit', 'socioId', 'socios'),
    history('actor_audit', 'actorBy', 'users'),
    owns('gateway_reservations', 'personId', 'users'),
    owns('gateway_reservations', 'socioId', 'socios'),
    history('gateway_usage', 'personId', 'users'),
    history('gateway_usage', 'socioId', 'socios'),
    history('gateway_exchanges', 'holderId', 'users'),
    history('gateway_exchanges', 'requesterId', 'users'),
    history('gateway_exchanges', 'deletedBy', 'users'),
    // A coding session has a sandbox and a volume: end it in the app first.
    // Once it is ended and both are gone it holds nothing: what is left are
    // their requests and the agent's reports, which go with it (its runs,
    // denials and events are NESTED below).
    blocks('coding_sessions', 'personId', 'users', CODING_HELD),
    blocks('coding_sessions', 'socioId', 'socios', CODING_HELD),
    blocks('coding_sessions', 'threadId', 'threads', CODING_HELD),
    owns('coding_sessions', 'personId', 'users', `NOT (${CODING_HELD})`),
    owns('coding_sessions', 'socioId', 'socios', `NOT (${CODING_HELD})`),
    owns('coding_sessions', 'threadId', 'threads', `NOT (${CODING_HELD})`),
    blocks('coding_thread_events', 'personId', 'users', CODING_EVENTS_HELD),
    blocks('coding_thread_events', 'requesterId', 'users', CODING_EVENTS_HELD),
    owns('coding_thread_events', 'personId', 'users', `NOT (${CODING_EVENTS_HELD})`),
    owns('coding_thread_events', 'requesterId', 'users', `NOT (${CODING_EVENTS_HELD})`),
    history('coding_thread_events', 'deletedBy', 'users'),
    // A file extraction has a file of its own: let it expire first.
    blocks('gateway_extractions', 'personId', 'users'),
    blocks('gateway_extractions', 'socioId', 'socios'),
    blocks('gateway_extractions', 'appId', 'apps'),
    blocks('gateway_extractions', 'threadId', 'threads'),
    // Schedules are never purged: move or delete them in the app first.
    blocks('tasks', 'userId', 'users'),
    blocks('tasks', 'dotId', 'socios'),
    blocks('tasks', 'jobId', 'jobs'),
    blocks('task_threads', 'threadId', 'threads'),
    history('tasks', 'deletedBy', 'users'),

    // ---- the board: its history stays -------------------------------------
    history('issues', 'reporterId', 'users'),
    history('issues', 'assigneeId', 'users'),
    history('issues', 'deletedBy', 'users'),
    history('issue_comments', 'authorId', 'users'),
    history('issue_comments', 'deletedBy', 'users'),
    history('issue_events', 'actorId', 'users'),
    history('issue_attachments', 'uploaderId', 'users'),
    history('issue_attachments', 'deletedBy', 'users'),
    history('issue_links', 'createdBy', 'users'),
    history('issue_links', 'removedBy', 'users'),
    history('issue_relations', 'createdBy', 'users'),
    history('issue_components', 'addedBy', 'users'),
    history('issue_relations', 'removedBy', 'users'),
    history('issue_triage', 'decidedBy', 'users'),
    history('issue_agent_actions', 'userId', 'users'),
    history('issue_dot_actions', 'userId', 'users'),
    history('issue_dot_actions', 'dotId', 'socios'),
    history('issue_dot_actions', 'dotOwnerId', 'users'),
    history('issue_dot_actions', 'threadId', 'threads'),
    owns('issue_runs', 'threadId', 'threads'),
    history('issue_runs', 'linkedBy', 'users'),
    history('dispatch_runs', 'dotId', 'socios'),
    history('dispatch_runs', 'threadId', 'threads'),
    history('dispatch_runs', 'requestedBy', 'users'),

    // ---- audit and settings attribution ------------------------------------
    history('access_log', 'viewerId', 'users'),
    history('access_policy', 'updatedBy', 'users'),
    history('access_policy_audit', 'actor', 'users'),
    history('workspace_audit', 'actor', 'users'),
    history('computer_audit', 'userId', 'users'),
    history('computer_audit', 'dotId', 'socios'),
    history('computer_audit', 'actor', 'users'),
    history('web_audit', 'userId', 'users'),
    history('web_audit', 'dotId', 'socios'),
    history('dot_audit', 'dotId', 'socios'),
    history('dot_audit', 'actor', 'users'),
    history('data_audit', 'ownerUserId', 'owners'),
    history('data_audit', 'actorId', 'users'),
    history('data_audit', 'dotId', 'socios'),
    history('data_audit', 'datasetId', 'datasets'),
    history('data_audit', 'threadId', 'threads'),
    // A data API token's line: the admin who made the token.
    history('data_audit', 'byUserId', 'users'),
    history('room_events', 'actor', 'users'),
    history('domain_hosts', 'createdBy', 'users'),
    history('domain_ops', 'actor', 'users'),
    history('classify_evals', 'startedBy', 'users'),
    history('classify_labels', 'actorId', 'users'),
    history('coding_settings', 'updatedBy', 'users'),
    history('flag_rules', 'updatedBy', 'users'),
    history('flag_tiers', 'updatedBy', 'users'),
    history('flag_tenant_tiers', 'updatedBy', 'users'),
    history('gateway_git_settings', 'updatedBy', 'users'),
    history('gateway_limits', 'updatedBy', 'users'),
    history('gateway_model_repositories', 'allowedBy', 'users'),
    history('gateway_models', 'updatedBy', 'users'),
    history('gateway_options', 'updatedBy', 'users'),
    history('gateway_repositories', 'pushChecklistBy', 'users'),
    history('gateway_repositories', 'updatedBy', 'users'),
    history('chat_skills', 'createdBy', 'users'),
    history('chat_skills', 'updatedBy', 'users'),
    history('chat_skills', 'deletedBy', 'users'),
    history('chat_skill_revisions', 'createdBy', 'users'),
    history('learning_container_revisions', 'createdBy', 'users'),
    history('learning_skill_revisions', 'createdBy', 'users'),
    history('learning_proposals', 'reviewedBy', 'users'),
    history('learning_runs', 'startedBy', 'users'),
    history('workspace_secrets', 'createdBy', 'users'),
    history('workspace_secrets', 'lastReadBy', 'users'),
    history('workspace_secrets', 'deletedBy', 'users'),
    history('workspace_secret_versions', 'setBy', 'users'),
    history('workspace_secret_grants', 'grantedBy', 'users'),
    history('workspace_secret_flags', 'dismissedBy', 'users'),
    history('work_cycles', 'actingUserId', 'users'),
    history('work_cycles', 'initiatorId', 'users'),
    history('work_cycles', 'billingUserId', 'users'),
    history('work_cycles', 'dotId', 'socios'),
    history('work_cycles', 'dotOwnerId', 'users'),
    owns('work_cycles', 'conversationId', 'threads'),
    history('work_cycle_submissions', 'actorId', 'users'),
    owns('work_cycle_submissions', 'conversationId', 'threads'),

    // ---- socios ---------------------------------------------------------------
    child('dots', 'ownerId', 'users', 'socios'),
    child('dots', 'spaceId', 'spaces', 'socios'),
    history('dots', 'deletedBy', 'users'),
    history('dots', 'archivedBy', 'users'),
    owns('dot_spaces', 'dotId', 'socios'),
    owns('dot_spaces', 'spaceId', 'spaces'),
    owns('socio_souls', 'dotId', 'socios'),
    history('socio_souls', 'createdBy', 'users'),
    owns('computer_permissions', 'dotId', 'socios'),
    owns('web_identity', 'dotId', 'socios'),
    owns('runtime_data_tokens', 'dotId', 'socios'),

    // ---- Spaces and pages ---------------------------------------------------
    child('pages', 'spaceId', 'spaces', 'pages'),
    child('pages', 'parentId', 'pages', 'pages'),
    history('pages', 'createdBy', 'users'),
    history('pages', 'deletedBy', 'users'),
    history('pages', 'sourceThreadId', 'threads'),
    history('spaces', 'deletedBy', 'users'),
    owns('space_members', 'spaceId', 'spaces'),
    owns('space_members', 'userId', 'users'),
    history('space_members', 'addedBy', 'users'),
    owns('space_settings', 'spaceId', 'spaces'),
    history('space_settings', 'updatedBy', 'users'),
    owns('space_memories', 'spaceId', 'spaces'),
    history('space_memories', 'proposedBy', 'users'),
    history('space_memories', 'decidedBy', 'users'),
    history('space_memories', 'endedBy', 'users'),
    history('space_memories', 'dotId', 'socios'),
    history('space_memories', 'threadId', 'threads'),
    owns('page_deletions', 'spaceId', 'spaces'),
    owns('page_reviews', 'spaceId', 'spaces'),
    owns('page_reviews', 'pageId', 'pages'),
    owns('page_reviews', 'threadId', 'threads'),
    owns('page_revisions', 'spaceId', 'spaces'),
    owns('page_revisions', 'pageId', 'pages'),
    history('page_revisions', 'authorId', 'users'),
    owns('page_search', 'spaceId', 'spaces'),
    owns('page_search', 'pageId', 'pages'),
    owns('page_use', 'pageId', 'pages'),
    owns('page_tags', 'pageId', 'pages'),
    owns('page_tags', 'spaceId', 'spaces'),
    history('page_tags', 'createdBy', 'users'),
    // Workspace bundles (CB-380): the operator who ran an import.
    history('import_runs', 'startedBy', 'users'),
    owns('page_links', 'fromPageId', 'pages'),
    owns('page_links', 'toPageId', 'pages'),
    owns('page_links', 'fromSpaceId', 'spaces'),
    owns('page_links', 'toSpaceId', 'spaces'),
    history('page_links', 'createdBy', 'users'),
    history('page_links', 'removedBy', 'users'),
    owns('run_refs', 'spaceId', 'spaces'),
    owns('run_refs', 'threadId', 'threads'),
    owns('media_embeds', 'spaceId', 'spaces'),
    owns('media_embeds', 'ownerUserId', 'owners'),
    owns('media_embeds', 'dotId', 'socios'),
    // CB-524: the page an upload was for. The upload stays, as other pages
    // may name it; the clean-up removes it once none does.
    history('media_embeds', 'pageId', 'pages'),
    // Shared into a Space: unshare it in the app first.
    blocks('apps', 'sharedSpaceId', 'spaces'),
    blocks('data_datasets', 'sharedSpaceId', 'spaces'),

    // ---- data spaces ----------------------------------------------------------
    child('data_datasets', 'ownerUserId', 'owners', 'datasets'),
    child('data_datasets', 'scratchForDotId', 'socios', 'datasets'),
    history('data_datasets', 'createdByDotId', 'socios'),
    history('data_datasets', 'deletedBy', 'users'),
    owns('data_dataset_days', 'datasetId', 'datasets'),
    owns('data_grants', 'ownerUserId', 'owners'),
    owns('data_grants', 'dotId', 'socios'),
    owns('data_grants', 'datasetId', 'datasets'),
    history('data_grants', 'createdBy', 'users'),
    // A plugin need's binding (CB-451) goes with its dataset; who bound it is history.
    owns('data_plugin_bindings', 'datasetId', 'datasets'),
    history('data_plugin_bindings', 'boundBy', 'users'),
    // A plugin's data budget (CB-473): the admin who set it is history.
    history('data_plugin_budgets', 'setBy', 'users'),
    // Admins' data API tokens: who made and who revoked each (`system` too).
    history('data_api_tokens', 'createdBy', 'users'),
    history('data_api_tokens', 'revokedBy', 'users'),
    // A column's field setting (CB-451) goes with its dataset; who last saved it is history.
    owns('data_field_settings', 'datasetId', 'datasets'),
    history('data_field_settings', 'updatedBy', 'users'),
    owns('data_files', 'ownerUserId', 'owners'),
    history('data_files', 'createdByDotId', 'socios'),
    history('data_files', 'deletedBy', 'users'),
    owns('media_attachments', 'ownerUserId', 'owners'),
    owns('media_attachments', 'dotId', 'socios'),
    owns('media_attachments', 'threadId', 'threads'),
    history('media_attachments', 'deletedBy', 'users'),
    owns('media_folders', 'ownerUserId', 'owners'),
    owns('app_grants', 'datasetId', 'datasets'),

    // ---- apps and jobs --------------------------------------------------------
    child('apps', 'ownerUserId', 'users', 'apps'),
    child('apps', 'dotId', 'socios', 'apps'),
    history('apps', 'deletedBy', 'users'),
    owns('app_actor_keys', 'appId', 'apps'),
    owns('app_attempts', 'appId', 'apps'),
    owns('app_grants', 'appId', 'apps'),
    owns('app_health', 'appId', 'apps'),
    owns('app_launch_codes', 'appId', 'apps'),
    owns('app_sessions', 'appId', 'apps'),
    owns('app_versions', 'appId', 'apps'),
    history('app_versions', 'createdByDotId', 'socios'),
    owns('workspace_secrets', 'workloadId', 'apps', "workloadKind='app'"),
    owns('workspace_secret_grants', 'workloadId', 'apps', "workloadKind='app'"),
    owns('workspace_secret_flags', 'workloadId', 'apps', "workloadKind='app'"),
    child('jobs', 'userId', 'users', 'jobs'),
    child('jobs', 'dotId', 'socios', 'jobs'),
    history('jobs', 'deletedBy', 'users'),
    owns('job_versions', 'jobId', 'jobs'),
    owns('job_runs', 'jobId', 'jobs'),
    owns('job_runs', 'userId', 'users'),
    owns('job_runs', 'dotId', 'socios'),
    owns('job_long_runs', 'jobId', 'jobs'),
    owns('job_long_runs', 'userId', 'users'),
    owns('job_long_runs', 'dotId', 'socios'),
    history('job_long_runs', 'threadId', 'threads'),

    // ---- rooms and conversations ----------------------------------------------
    child('thread_bindings', 'ownerId', 'users', 'conversations', "kind<>'room'"),
    child('thread_bindings', 'dotId', 'socios', 'conversations', "kind<>'room'"),
    child('thread_bindings', 'dotId', 'socios', 'rooms', "kind='room'"),
    history('thread_bindings', 'createdBy', 'users'),
    history('thread_bindings', 'deletedBy', 'users'),
    history('thread_bindings', 'archivedBy', 'users'),
    owns('room_members', 'roomId', 'rooms'),
    owns('room_members', 'userId', 'users'),
    history('room_members', 'invitedBy', 'users'),
    history('room_members', 'endedBy', 'users'),
    owns('room_mentions', 'roomId', 'rooms'),
    owns('room_mentions', 'userId', 'users'),
    history('room_mentions', 'authorId', 'users'),
    owns('room_notices', 'roomId', 'rooms'),
    owns('room_notices', 'userId', 'users'),
    owns('room_notify_settings', 'roomId', 'rooms'),
    owns('room_notify_settings', 'userId', 'users'),
    owns('room_read_state', 'roomId', 'rooms'),
    owns('room_read_state', 'userId', 'users'),
    owns('room_settings', 'roomId', 'rooms'),
    history('room_settings', 'updatedBy', 'users'),
    owns('room_socios', 'roomId', 'rooms'),
    owns('room_socios', 'dotId', 'socios'),
    history('room_socios', 'requestedBy', 'users'),
    history('room_socios', 'authorizedBy', 'users'),
    owns('room_source_bindings', 'roomId', 'rooms'),
    history('room_source_bindings', 'boundBy', 'users'),
    owns('room_events', 'roomId', 'rooms'),
    owns('room_handoffs', 'roomId', 'rooms'),
    history('room_handoffs', 'fromDotId', 'socios'),
    history('room_handoffs', 'toDotId', 'socios'),
    history('room_handoffs', 'requestedBy', 'users'),
    owns('telegram_topic_senders', 'roomId', 'rooms'),
    owns('agent_runs', 'threadId', 'threads'),
    owns('calls', 'threadId', 'threads'),
    owns('captures', 'threadId', 'threads'),
    owns('chat_context_facts', 'threadId', 'threads'),
    owns('chat_context_notes', 'threadId', 'threads'),
    owns('chat_context_note_versions', 'threadId', 'threads'),
    history('chat_context_note_versions', 'dotId', 'socios'),
    history('chat_context_note_versions', 'actingUserId', 'users'),
    owns('chat_pins', 'threadId', 'threads'),
    history('chat_pins', 'pinnedBy', 'users'),
    history('chat_pins', 'proposedBy', 'users'),
    history('chat_pins', 'decidedBy', 'users'),
    history('chat_pins', 'endedBy', 'users'),
    owns('chat_skill_sessions', 'threadId', 'threads'),
    history('chat_skill_sessions', 'startedBy', 'users'),
    history('chat_skill_sessions', 'endedBy', 'users'),
    owns('chat_time_markers', 'threadId', 'threads'),
    owns('chat_name_suggestions', 'threadId', 'threads'),
    owns('telegram_replies', 'threadId', 'threads'),
    owns('telegram_threads', 'threadId', 'threads'),
];

/** Rows that go with a row of another table that goes. */
export const NESTED: Nested[] = [
    { table: 'goal_comments', column: 'goalId', parent: 'goals', key: 'id' },
    { table: 'issue_watch_members', column: 'watchId', parent: 'issue_watches', key: 'id' },
    { table: 'issue_watch_outbox', column: 'watchId', parent: 'issue_watches', key: 'id' },
    { table: 'mcp_grants', column: 'connectionId', parent: 'mcp_connections', key: 'id' },
    { table: 'mcp_oauth_attempts', column: 'connectionId', parent: 'mcp_connections', key: 'id' },
    { table: 'mcp_calls', column: 'connectionId', parent: 'mcp_connections', key: 'id' },
    { table: 'job_items', column: 'longRunId', parent: 'job_long_runs', key: 'id' },
    { table: 'notification_deliveries', column: 'notificationId', parent: 'notifications', key: 'id' },
    { table: 'actor_credentials', column: 'grantId', parent: 'socio_grants', key: 'id' },
    { table: 'actor_credentials', column: 'contextId', parent: 'actor_contexts', key: 'id' },
    { table: 'workspace_secret_versions', column: 'secretId', parent: 'workspace_secrets', key: 'id' },
    { table: 'workspace_secret_grants', column: 'secretId', parent: 'workspace_secrets', key: 'id' },
    { table: 'workspace_secret_flags', column: 'secretId', parent: 'workspace_secrets', key: 'id' },
    { table: 'coding_runs', column: 'sessionId', parent: 'coding_sessions', key: 'id' },
    { table: 'coding_denials', column: 'sessionId', parent: 'coding_sessions', key: 'id' },
    { table: 'coding_thread_events', column: 'sessionId', parent: 'coding_sessions', key: 'id' },
];

/**
 * Columns whose names look like a reference but hold something else, with
 * why: the coverage test reads this list, and so does a reviewer.
 */
export const NOT_REFERENCES: Record<string, string> = {
    'actor_credentials.holderId': 'a context, prompt run or grant id; covered by grantId and contextId',
    'actor_credentials.holderKind': 'a kind name',
    'actor_credentials.issuedBy': 'a component name',
    'apps.datasets': 'a JSON list the app asked for, checked when it starts',
    'app_grants.createdByPromotion': 'a flag',
    'auth_oauth_access_token.authorizationCodeId': 'a code id',
    'auth_oauth_refresh_token.authorizationCodeId': 'a code id',
    'auth_session.userAgent': 'a browser string',
    'coding_sessions.conversationKind': 'a kind name',
    'coding_thread_events.nativeThreadId': "the coding harness's own thread id",
    'gateway_repositories.users': 'a JSON allow list',
    'job_items.claimedBy': 'a runtime instance id',
    'job_versions.datasets': 'a JSON list the job asked for',
    'learning_proposals.evidenceThreadIds': 'a JSON list kept as the proposal’s evidence',
    'room_socios.authorizedAt': 'a time',
    'runtime_leases.ownerId': 'a runtime instance id',
    'runtime_work.ownerId': 'a runtime instance id',
    'socio_grants.replacedBy': 'a grant id',
    'socio_grants.conversationKind': 'a kind name',
    'user_inference_connections.refreshLeasedBy': 'a runtime instance id',
    'work_cycles.initiatorKind': 'a kind name',
    'work_cycles.billingKind': 'a kind name',
    'data_audit.actorKind': 'a kind name',
    'data_field_settings.declaredBy': 'the plugin whose manifest set it (CB-451); no purge removes a plugin',
    'goal_comments.authorKind': 'a kind name',
    'issue_comments.authorKind': 'a kind name',
    'telegram_links.telegramUserId': "Telegram's own id",
    'telegram_topic_senders.telegramUserId': "Telegram's own id",
};
