import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { expect, it } from 'vitest';

import { PACKAGE_SOURCES } from './support/package-sources.js';

// CB-64: deleting user content hides it and keeps it (soft delete). A hard
// delete is a decision: every `DELETE FROM` and file removal in the server
// is listed here with why it may stay hard. A new one fails this test
// until it is added, with a reason.

const ROOTS = ['src/server', 'src/apps-runtime', ...PACKAGE_SOURCES];

/** Tables whose rows may be deleted, and why. */
const TABLES: Record<string, string> = {
    // Security, ephemeral and settings state.
    app_sessions: 'sessions',
    app_launch_codes: 'one-time secrets',
    // CB-108: runtime coordination, none of it user content; a dead
    // runtime's rows go a day after it ended.
    runtime_data_tokens: 'hashed data tokens, ending with their issuer',
    // CB-338: the offline user rename merges a counter into the new id's.
    change_counters: 'cache-invalidation counters, merged when a user id is renamed',
    person_seeds: 'a renamed person’s seed, moved to their new id (CB-338)',
    runtime_signals: 'stop requests between runtimes, consumed once',
    runtime_work: 'ownership records of dead runtimes',
    runtime_recoveries: 'recovery records of dead runtimes',
    runtime_instances: 'dead runtime identities',
    runtime_contracts: 'contract versions of pruned runtime identities',
    actor_credentials: 'hashed socio credentials of revoked grants, ended work or past expiry (CB-232)',
    // CB-239: the model gateway's settings (every change in actor_audit)
    // and the reservations of requests in flight, each settled into a
    // gateway_usage row when its request ends.
    gateway_models: 'settings; a removal is in actor_audit',
    gateway_model_repositories: 'settings; every change is in actor_audit',
    gateway_limits: 'settings back to their default; changes in actor_audit',
    gateway_reservations: 'requests in flight, settled into gateway_usage',
    // CB-239: Settings → Coding → Repositories and the Git limits; every
    // change is a `setting` row in actor_audit. Token mint counts are
    // per-hour counters with no content, dropped after two days.
    gateway_repositories: 'settings; every change is a setting row in actor_audit (CB-239)',
    gateway_git_settings: 'settings; every change is a setting row in actor_audit (CB-239)',
    gateway_git_mints: 'hourly counts of minted tokens, no content (CB-239)',
    // CB-239: a switch back to its environment default (the change is in
    // actor_audit).
    gateway_options: 'settings back to their default; changes in actor_audit',
    // CB-239: Settings → Coding → Sandboxes back to their env default;
    // every change is a `setting` row in actor_audit.
    coding_settings: 'settings back to their default; every change is a setting row in actor_audit (CB-239)',
    // Plugin sign-in is a row so any replica can redeem it. A used or expired
    // code is gone; uninstall drops the install, its codes and its sessions.
    // The plugin's own rows (posts, replies) stay.
    plugin_codes: 'one-time launch codes',
    plugin_sessions: 'sessions',
    plugin_installs: 'the install row; the plugin’s saved data stays',
    // CB-527: a plugin's stored release notes, past the 50 newest versions or
    // when it is uninstalled, and what a person saw of them once they can't
    // open it. Copies of the manifest's text and read markers, no one's content.
    plugin_release_notes: 'copies of a plugin manifest’s notes, beyond 50 versions or after uninstall (CB-527)',
    plugin_release_state: 'the version a plugin’s notes were read for, after uninstall (CB-527)',
    plugin_release_seen: 'read markers of people who can no longer open the plugin (CB-527)',
    // The calendar plugin (CB-254): deleting an event is the person's own
    // choice (canceling keeps it, with its status); a feed token is a hashed
    // secret that a new link or turning it off replaces.
    calendar_events: 'an event its creator or an admin deleted; cancelled ones stay',
    calendar_feeds: 'hashed subscription tokens, replaced or turned off',
    telegram_link_codes: 'one-time secrets',
    telegram_room_codes: 'one-time secrets (CB-214)',
    // CB-216: a queued message's picked mentions go with its cancel or once
    // checked against it (only ids and the picked name); a room notice's
    // claim is a dedupe key, dropped after 30 days.
    room_mentions: 'pending mentions of a cancelled or delivered message, ids only (CB-216)',
    room_notices: 'dedupe keys of notices sent, after 30 days (CB-216)',
    // CB-292: a settled or cleared name suggestion; no content beyond the
    // suggested name and its state.
    chat_name_suggestions: 'a settled or cleared name suggestion (CB-292)',
    telegram_links: 'account binding; an unlink is audited',
    // CB-360: an admin removes a revoked service key for good (audited in
    // workspace_audit by name and id); a live key is only ever revoked.
    service_keys: 'a revoked API key an admin removed for good; audited by name and id (CB-360)',
    channel_kv: 'channel cache with expiry',
    channel_lists: 'channel cache with expiry',
    channel_locks: 'locks',
    channel_queue: 'queue',
    data_grants: 'access; every end is in data_audit',
    app_grants: 'access, rewritten by promotion; deleted apps are re-keyed',
    app_attempts: 'start and build logs (CB-146): the newest 5 per version, 50 per app',
    approval_policies: 'settings; changes are in approval_audit',
    approval_guidance: 'settings',
    inference_backends: 'settings holding secrets; a removal is audited',
    user_inference_connections: 'settings holding secrets',
    mcp_connections:
        'personal settings holding secrets; removal first revokes generation and grants; approval and call history remain',
    mcp_oauth_attempts: 'one-time PKCE secrets and browser bindings, expired or invalidated on reconnect',
    workspace_secret_grants:
        'access to a workspace secret: revoked, or ended with the secret or its app, audited first (Socio Secrets)',
    mcp_grants: 'current reviewed access; pending approvals and call history retain the exact grant revision',
    // CB-204: a sealed key, cleared by an admin or a new URL.
    secret_settings: 'settings holding secrets',
    // The GitHub App's rows, still in dispatch's old key-value table (CB-325).
    dispatch_settings: 'settings',
    inference_settings: 'settings',
    web_identity: 'settings',
    learning_container_pins: 'settings',
    domain_hosts: 'infrastructure state; domain_ops records the removal',
    inference_timings: 'performance samples, 200 per key',
    dot_spaces: 'a join, rewritten on edit',
    // Connected agents (CB-90): a revoked grant's tokens and consent go at
    // once, so nothing can use them; the grant row keeps the record.
    auth_oauth_access_token: 'credentials of a revoked grant',
    auth_oauth_refresh_token: 'credentials of a revoked grant',
    auth_oauth_consent: 'the plugin’s copy of a revoked grant',
    agent_grants: 'a grant whose consent failed: it never had tokens',
    // CB-124: sessions a tightened access policy no longer allows; the
    // change and how many ended are in access_policy_audit.
    auth_session: 'sessions; an access policy change audits how many ended',
    // CB-352: the sign-in sheet's requests, a day after they expired: a used
    // one's sign-in is in workspace_audit, an unused one signed nobody in.
    auth_device_request: 'expired one-time sign-in requests; sign-ins are in workspace_audit',
    auth_device_pairing: 'expired Add a device QR codes; sign-ins are in workspace_audit',
    auth_device_code: 'expired sign-in codes; sign-ins are in workspace_audit',
    auth_link_via: 'the channel of expired sign-in links; a link lives 15 minutes',
    auth_device_push_leftover: 'a push endpoint once its subscription is removed; the sign-out is in workspace_audit',
    auth_device_turn: 'a lease for one person’s device turn, let go when the turn ends; it records nothing',
    // CB-376: a group an admin deleted; its members' roles drop it at once.
    auth_organization_role: 'a deleted group (settings); the change is logged',
    agent_settings: 'settings',
    // Feature flags (CB-169, CB-182): clearing a rule or plan goes back to
    // the layer below; workspace_audit keeps each one. People's early-access
    // choices are retired (CB-503): flags 2 deleted them and deletes any an
    // older release still writes; each was in workspace_audit.
    flag_rules: 'settings; every change is in workspace_audit',
    flag_choices: 'retired early-access choices (CB-503); each one was in workspace_audit',
    flag_tiers: 'settings; a removal is in workspace_audit',
    flag_tenant_tiers: 'settings; every change is in workspace_audit',
    page_threads: 'a page conversation lease; the conversation is kept',
    // CB-360: a transfer moves a person's conversations; a context link
    // the new owner has already, and the old owner's Telegram chat binding,
    // go. The conversation is kept, and the transfer is in workspace_audit.
    context_threads: 'a context’s link to a conversation; the conversation is kept',
    telegram_threads: 'a Telegram chat’s binding to a conversation; the conversation is kept',
    media_folders: 'an empty folder marker; no content',
    issue_labels: 'labels, rewritten on edit; changes are in issue_events',
    // CB-442: an issue's components, rewritten on edit; changes are in issue_events.
    issue_components: 'components, rewritten on edit; changes are in issue_events',
    // CB-328: a tag membership; removing a tag deletes the row (idempotent),
    // and a deleted page's tags go with it. No content of their own.
    page_tags: 'a tag membership; removing a tag deletes the row, and a deleted page’s tags go with it',
    message_reactions: 'a reaction its person takes back; no content',
    // CB-151: a message waiting for a turn, like a draft: gone once a turn
    // takes it (it is in the stored conversation then) or its person
    // cancels it before it was sent.
    chat_steering: 'a queued message, delivered (and stored) or cancelled',
    // CB-211: when messages reached a chat, for its rate; no content.
    work_cycle_submissions: 'message times for the rate limit, no content: pruned after an hour',
    sqlite_sequence: 'SQLite’s own AUTOINCREMENT counter, carried over when chat 7 rebuilds a table (CB-223)',
    // Page search: derived from pages, or counts only.
    page_search: 'the search copy of a live page; a deleted page leaves it',
    page_use: 'a page’s freshness from use, an aggregate; goes with the page',
    page_use_days: 'daily page-use aggregates; configurable 400-day default, 0 keeps history (CB-193)',
    page_search_daily:
        'search timing aggregates without query text; forever by default, configurable retention (CB-193)',
    // CB-180: the owner's decision. A person deletes their episodes for
    // real, and retention deletes them; derived from chats that stay stored.
    memory_episodes: 'a person’s episodes: deleted by them (audited by id) or past retention (owner decision, CB-180)',
    // CB-181: a Space's shared memory keeps every version until it has been
    // out of use past retention; an editor deletes a retired entry for real.
    space_memories:
        'Space memory out of use past retention, or a retired entry an editor deleted (audited by id, CB-181)',
    // CB-181: a person removed from a Space; the workspace audit keeps it.
    space_members: 'a person’s role in a Space, removed by an editor (audited, CB-181)',
    // Long chats (CB-134): derived from the thread's turns, which stay stored.
    chat_context_facts: 'facts the notes pinned from a history that changed; the turns are kept',
    // CB-217: a room's notes' older versions past the newest 20, derived
    // from the room's turns, which stay stored.
    chat_context_note_versions: 'older versions of a room’s notes, derived from its kept turns',
    // The audit and run history caps are gone: computer_audit,
    // web_audit, domain_ops and job_runs keep every row.
    // Notifications (CB-114, CB-193): independent record/delivery/notice
    // retention; no cascade may bypass a child history policy. Images expire in 7 days.
    notifications:
        'notification records; configurable forever default, retained while deliveries or notices need them (CB-193)',
    notification_deliveries: 'delivery audit; independent configurable 400-day default, 0 keeps history (CB-193)',
    notification_in_app: 'in-app notice state; independent configurable forever default (CB-193)',
    notification_images: 'a notification’s image copy, kept 7 days',
    notification_push_subscriptions: 'a browser’s push endpoint: removed by its person or its push service',
    // Only a dataset a failed move half made: it held nothing of its own.
    data_datasets: 'a half-made dataset (moveToNewDataset)',
    // The analytics DuckDB store (CB-187): copies of SQLite's turns and
    // their totals, rewritten by the ETL, never the data itself.
    f_turn: 'analytics facts, rewritten from agent_runs; retention',
    f_message: 'analytics facts, rewritten from agent_runs; retention',
    f_tool: 'analytics facts, rewritten from agent_runs; retention',
    f_participant: 'derived from the analytics facts',
    r_hourly:
        'recomputed analytics totals; forever by default, configurable retention bounded by retained facts (CB-193)',
    r_daily: 'totals of the analytics facts, recomputed',
    d_calendar: 'the reporting time zone’s buckets, made again',
    // CB-189: the board's items, copied whole from SQLite when they change.
    f_issue: 'analytics copy of the board’s items, made again',
    // Resource telemetry is sampled operational data, not user content or raw runs.
    ops_samples: 'resource measurements; configurable 400-day default, 0 keeps history (CB-193)',
    ops_samples_hourly: 'hourly resource aggregates; same configurable sample retention, 0 keeps history (CB-193)',
    // Health's (CB-192).
    f_round: 'analytics facts, rewritten from agent_runs; retention',
    f_job_run: 'analytics facts, rewritten from job_runs; retention',
    f_cycle: 'analytics facts, rewritten from work_cycles; retention (CB-218)',
    f_task_run: 'analytics facts, rewritten from runs; retention',
    // Activity and Value (CB-190): copies of approvals, reactions, page
    // writes and memories, rewritten by the ETL.
    f_approval: 'analytics facts, copied from approval_audit; retention',
    f_space_write: 'analytics facts, copied from pages; retention',
    f_reaction: 'analytics facts, copied whole from message_reactions',
    f_memory: 'analytics facts, copied whole from memories',
    // CB-191: copies of pages, edits, dataset access and sizes, rewritten.
    d_page: 'analytics copy of the live pages, rewritten as they change',
    f_page_edit: 'analytics facts, rewritten from page_revisions',
    f_data_access: 'analytics facts, rewritten from data_audit',
    f_dataset_day: 'analytics facts, rewritten from data_dataset_days',
    // Grounding (CB-194).
    f_run_ref: 'analytics facts, rewritten from run_refs; retention',
    f_issue_run: 'analytics copy of items’ links to turns, made again',
    // Cost (CB-195, CB-196): admins' own prices, cost pools and meter
    // readings, removed by an admin and recorded in workspace_audit; pool
    // hours, recomputed by the ETL from the pools.
    model_prices: 'an admin’s own price, removed by an admin (audited)',
    cost_pools: 'a cost pool, removed by an admin (audited)',
    cost_meter_readings: 'a meter reading, removed by an admin or with its pool (audited)',
    f_pool_hour: 'analytics pool hours, recomputed from the cost pools',
    // CB-198: the failure label in force per subject, replaced when it changes.
    f_label: 'analytics copy of classify_labels, replaced per subject',
    // CB-199: sessions' intent and topics in force, replaced per turn; retention.
    f_intent: 'analytics copy of classify_labels, replaced per turn; retention',
    f_theme: 'analytics copy of classify_labels, replaced per turn; retention',
};
/** `DELETE FROM ${table}` sites, by file. */
const DYNAMIC: Record<string, string> = {
    // The operator purge (purge-cli.ts): test records an operator lists, removed
    // for good with what belongs to them, after a backup; references.ts says
    // which tables, and keeps audit and board history.
    'src/server/purge/purge.ts': 'records an operator purges for good, listed by id, after a backup',
    // CB-380: an issue filed here and deleted, whose number a workspace bundle's
    // issue takes, removed for good with its rows (replace.ts lists them).
    'src/server/bundle/replace.ts': 'a deleted issue, and its rows, whose number an imported issue takes',
    'src/server/telegram/channel-state.ts': 'channel caches with expiry',
    // The analytics DuckDB store (CB-187): facts and dimensions it rewrites.
    'src/server/operations/etl/runs-step.ts': 'analytics facts of the turns a batch reads again',
    'src/server/operations/etl/dimensions-step.ts': 'analytics dimensions, copied whole from SQLite',
    'src/server/operations/etl/health-steps.ts':
        'analytics facts of the runs a batch reads again, and copies of schedules, goals and long runs (CB-192)',
    'src/server/operations/etl/activity-steps.ts': 'analytics facts past retention (CB-190)',
    'src/server/operations/etl/knowledge-steps.ts':
        'analytics copies of pages, search, datasets, storage and requests, copied whole from SQLite (CB-191)',
    // CB-369 Phase H: row history an owner bounded, in the dataset's own file.
    'src/server/dataspace/engine.ts':
        'kept rows past a dataset’s historyDays or of a table without history, and the _writes records nothing names (the nightly prune)',
    // CB-451 step 3b: row stamps' tombstones, in the dataset's own file.
    'src/server/dataspace/stamps.ts':
        'deleted rows’ stamps past stampTombstoneDays (the nightly prune), which raise the file’s stamp floor',
};
/** Files that remove files or directories, and why. */
const REMOVALS: Record<string, string> = {
    'src/server/purge/purge.ts': 'the files of records an operator purges, after their backup',
    'src/server/purge/run.ts': 'the cleanup manifest of a purge that rolled back',
    // CB-380: workspace bundles.
    'src/server/bundle/files.ts': 'a bundle export’s own partial directory, when the export fails',
    'src/server/bundle/safety.ts': 'the export’s own snapshot of the database, once it has been read',
    'src/server/bundle/live.ts':
        'the live CLI channel’s own socket file, when its server stops (never a newer server’s)',
    'src/server/dataspace/transfer.ts':
        'a transfer’s old dataset links after its commit, or its new ones after a rollback (CB-360); the dataset stays',
    'packages/data/src/backup.ts': 'backup rotation and partial backups',
    'src/server/backup/backup-service.ts': 'the backup run lock',
    'src/server/backup/backup-offsite.ts': 'the off-site copy’s sealed file once it is sent (CB-378)',
    'src/server/backup/purge-backups.ts': 'permanent removals’ backups once past their days (CB-391)',
    'src/server/backup/plugin-store.ts':
        'plugin snapshots past their retention, the chunks no kept snapshot lists, failed chunks’ temporary files and the level 1 drill’s scratch copies (CB-458)',
    'packages/foundation/src/keys/sealed-files.ts': 'an opened file whose tag did not check out (CB-378)',
    'src/server/backup/restore-drill.ts': 'the restore drill’s scratch copies',
    'src/server/backup/rename-user.ts':
        'a user rename’s prior file copies after its commit, its own partial copies on failure, and the derived analytics file (CB-338)',
    'src/server/healthcheck.ts': 'stall captures past the newest five, and their placeholders (CB-318)',
    'src/server/storage/local-store.ts': 'temp files, and stray copies of objects kept in the other store',
    'src/server/dataspace/space.ts':
        'a half-written dataset export; an append body once staged, and what interrupted analytical appends left, an hour on (CB-369)',
    'src/server/dataspace/engine.ts':
        'a copy target before it is written, a half-made dataset, its analytical parts with it, and parts of a refused or duplicate append (CB-369)',
    'src/server/dataspace/routes.ts': 'an append body cut off past its size limit (CB-369)',
    'src/server/dataspace/analytics/worker.ts':
        'a failed append’s staged parts, and a query’s spill directory (CB-369)',
    'src/apps-runtime/supervisor.ts': 'unpacked bundles and sockets (copies)',
    'src/apps-runtime/identity-delivery.ts':
        'development copies of plugin identity tokens, replaced or retired; Socio keeps every version’s hash (Socio Secrets)',
    'src/server/operations/analytics/engine.ts':
        'the analytics DuckDB file: data derived from SQLite, rebuilt (CB-186)',
};

function files(dir: string): string[] {
    // src/server/plugins/planner/ui is the planner's built client, there only after a build.
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        if (join(dir, entry.name) === join('src/server/plugins/planner/ui')) {
            return [];
        }
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
            return files(path);
        }
        return /\.(ts|tsx|js|mjs)$/.test(entry.name) ? [path] : [];
    });
}

it('deletes rows hard only from tables that are allowed to, each with a reason', () => {
    const found = new Set<string>();
    const unexpected: string[] = [];
    const sources = ROOTS.flatMap((root) => files(root)).map((path) => ({
        name: relative('.', path),
        source: readFileSync(path, 'utf8'),
    }));
    // Drizzle schemas (CB-110): each table's variable, so `.delete(issueLabels)`
    // counts as `DELETE FROM issue_labels`.
    const tableOf = new Map(
        sources.flatMap(({ source }) =>
            [...source.matchAll(/export const (\w+) = sqliteTable\(\s*'(\w+)'/g)].map(
                (match) => [match[1]!, match[2]!] as const,
            ),
        ),
    );
    for (const { name, source } of sources) {
        for (const match of source.matchAll(/\.delete\((\w+)\)/g)) {
            const table = tableOf.get(match[1]!);
            if (!table) {
                continue;
            }
            found.add(table);
            if (!TABLES[table]) {
                unexpected.push(`${name}: delete(${match[1]})`);
            }
        }
        for (const match of source.matchAll(/DELETE FROM\s+(\$\{\w+\}|\w+)/g)) {
            const table = match[1];
            if (table.startsWith('$')) {
                if (!DYNAMIC[name]) {
                    unexpected.push(`${name}: DELETE FROM ${table}`);
                }
                continue;
            }
            found.add(table);
            if (!TABLES[table]) {
                unexpected.push(`${name}: DELETE FROM ${table}`);
            }
        }
    }
    expect(unexpected).toEqual([]);
    // The soft-deleted tables of passes 1 and 2 have no hard delete left.
    for (const table of [
        'thread_bindings',
        'tasks',
        'runs',
        'events',
        'memories',
        'pages',
        'calls',
        'captures',
        'page_reviews',
        'learning_evidence',
        'agent_runs',
        'issues',
        'issue_comments',
        'issue_attachments',
        'issue_events',
        'dot_requests',
        'jobs',
        'job_versions',
        'apps',
        'app_versions',
        'dots',
        'spaces',
        // Pass 2.
        'data_files',
        'media_attachments',
        // Kept page revisions.
        'page_revisions',
    ]) {
        expect(found.has(table), table).toBe(false);
    }
    // The list stays exact: a table soft-deleted later (pass 2) leaves it.
    expect(Object.keys(TABLES).filter((table) => !found.has(table))).toEqual([]);
});

it('removes files only where that is allowed, each with a reason', () => {
    const removing = ROOTS.flatMap((root) => files(root))
        .map((path) => relative('.', path))
        // Files that import a removal from node:fs.
        .filter((name) =>
            /import\s*\{[^}]*\b(rm|rmSync|unlink|unlinkSync)\b[^}]*\}\s*from\s*'node:fs(\/promises)?'/.test(
                readFileSync(name, 'utf8'),
            ),
        );
    expect(removing.filter((name) => !REMOVALS[name])).toEqual([]);
    expect(Object.keys(REMOVALS).filter((name) => !removing.includes(name))).toEqual([]);
});
