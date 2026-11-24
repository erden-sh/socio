import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, expect, it, vi } from 'vitest';

import {
    migrate,
    migrateDatabase,
    type Migration,
    migrationChecksum,
    MigrationError,
    planMigrations,
    type SchemaSet,
} from '@socio/data/migrate';
import { legacyCharacterFor } from '@socio/shared/mascot';

import { authSchema } from '../src/server/auth/schema.js';
import { chatSchema } from '../src/server/context/notes.js';
import { dataSchema } from '../src/server/dataspace/migrations.js';
import { issuesSchema } from '../src/server/issues/migrations.js';
import { mediaSchema } from '../src/server/media/migrations.js';
import { schemas } from '../src/server/modules/index.js';
import { Pages, pagesSchema } from '../src/server/pages/pages.js';
import { runsSchema } from '../src/server/runs/migrations.js';
import { schedulesSchema } from '../src/server/schedules/migrations.js';
import { coreSchema } from '../src/server/settings/store.js';
import { SqliteStateStore } from '../src/server/telegram/channel-state.js';
import { workspaceSchema } from '../src/server/workspace/workspace.js';

import { buildRelease1Database } from './fixtures/release-1-db.js';
import { LocalAgentRunner } from './helpers/runners.js';
import { Store, WorkspaceStore } from './helpers/stores.js';

const cleanup: Array<() => void> = [];
afterEach(() =>
    cleanup
        .splice(0)
        .reverse()
        .forEach((fn) => fn()),
);
const scratch = () => {
    const dir = mkdtempSync(join(tmpdir(), 'brain-migrations-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
};
const open = (path: string) => {
    const db = new DatabaseSync(path);
    cleanup.push(() => db.isOpen && db.close());
    return db;
};
const boot = (path: string, backups: string, sets = schemas) =>
    migrateDatabase(path, sets, { backupDirectory: backups });

/** Splits a list at top-level commas. */
function parts(list: string) {
    const out: string[] = [];
    let depth = 0;
    let current = '';
    for (const ch of list) {
        if (ch === '(') {
            depth++;
        }
        if (ch === ')') {
            depth--;
        }
        if (ch === ',' && !depth) {
            out.push(current.trim());
            current = '';
        } else {
            current += ch;
        }
    }
    return [...out, current.trim()];
}
/**
 * sqlite_master, normalized: whitespace and identifier quotes ignored, and a
 * table's column and constraint definitions sorted, since a column added in
 * place (ALTER TABLE ... ADD COLUMN) is appended where a fresh CREATE has it
 * in the middle. Everything else, CHECKs and defaults included, must match.
 */
function schemaOf(db: DatabaseSync) {
    const rows = db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_master').all() as {
        type: string;
        name: string;
        tbl_name: string;
        sql: string;
    }[];
    return rows
        .map((row) => {
            let sql = row.sql
                ?.replace(/\s+/g, ' ')
                .replace(/"/g, '')
                .replace(/\s*([(),])\s*/g, '$1')
                .trim();
            const table = sql?.match(/^CREATE TABLE (\w+)\((.*)\)$/);
            if (table) {
                sql = `${table[1]}(${parts(table[2]).sort().join(',')})`;
            }
            return `${row.type} ${row.name} ${row.tbl_name} ${sql ?? ''}`;
        })
        .sort();
}
/**
 * Every row of every table but the migration log, for before/after checks.
 * Virtual tables (FTS5 indexes) and their shadow tables are left out: they
 * hold derived data, and `_idx` and `_config` have no rowid.
 */
function rowsOf(db: DatabaseSync) {
    const tables = db
        .prepare(
            "SELECT name FROM pragma_table_list WHERE schema='main' AND type='table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations' ORDER BY name",
        )
        .all() as { name: string }[];
    return Object.fromEntries(
        tables.map(({ name }) => [
            name,
            db
                .prepare(`SELECT * FROM "${name}" ORDER BY rowid`)
                .all()
                .map((row) => Object.fromEntries(Object.entries(row).sort(([a], [b]) => (a < b ? -1 : 1)))),
        ]),
    );
}
const log = (db: DatabaseSync) =>
    db.prepare('SELECT module, version, name FROM schema_migrations ORDER BY module').all();

// Building every schema twice takes seconds when the machine is busy.
vi.setConfig({ testTimeout: 20_000 });

it('gives a fresh database and a release-1 database the same schema, keeping its data', () => {
    const dir = scratch();
    const fresh = join(dir, 'fresh.sqlite');
    const prod = join(dir, 'prod.sqlite');
    buildRelease1Database(prod);
    const before = rowsOf(open(prod));

    const created = boot(fresh, join(dir, 'fresh-backups'));
    expect(created.steps.every((step) => step.action === 'apply')).toBe(true);
    expect(created.steps.map((step) => step.module)).toEqual(
        schemas.flatMap((set) => (set.migrations ?? []).map(() => set.id)),
    );
    expect(created.backup).toBeUndefined();

    // Every baseline's objects are there already: nothing runs, all adopted.
    // Release-2 modules (auth, dispatch) are new tables, applied. The Memory
    // and Scheduling contexts' baselines (CB-110) are of tables release 1
    // didn't have yet, or not in their present shape: core 2 to 6 make them
    // in this same boot, before them, so they run and their `IF NOT EXISTS`
    // find them all (the schemas match below).
    const adopted = boot(prod, join(dir, 'prod-backups'));
    expect(adopted.steps.map((step) => `${step.module}:${step.action}`)).toEqual(
        schemas.flatMap((set) =>
            (set.migrations ?? []).map(
                (migration) =>
                    `${set.id}:${migration.baseline && !['memories', 'schedule-tasks'].includes(set.id) ? 'adopt' : 'apply'}`,
            ),
        ),
    );
    expect(adopted.steps.map((step) => step.module)).toContain('dispatch');
    expect(adopted.backup).toMatch(/company-brain-\d{8}-\d{6}\.sqlite$/);
    expect(readdirSync(join(dir, 'prod-backups'))).toHaveLength(1);
    expect(rowsOf(open(adopted.backup!))).toEqual(before);

    const freshDb = open(fresh);
    const prodDb = open(prod);
    expect(schemaOf(prodDb)).toEqual(schemaOf(freshDb));
    // CB-54: data schema v2 says where each file's bytes are (local first);
    // CB-64 pass 2: v3 adds soft delete; CB-62: v4, which key sealed them
    // (legacy first); v5 indexes an overwrite's kept versions; v6 counts
    // each dataset's row history apart; v7 indexes the audit by Dot; v8
    // keeps each dataset's sizes per day and indexes the audit by time
    // (CB-191); v9 marks the audit rows about a socio's shared area (CB-229);
    // v10 keeps the chat a socio's tool acted in (CB-194); v11 bounds row
    // history and v12 counts analytical bytes (CB-369); v13 binds plugin
    // needs to workspace datasets (CB-451); v14 keeps plugins' data budgets (CB-473);
    // v15 places datasets in Spaces (CB-451); v16 keeps field settings (CB-451);
    // v17 keeps admins' data API tokens.
    expect(adopted.steps.filter((step) => step.module === 'data').map((step) => step.action)).toEqual([
        'apply',
        'apply',
        'apply',
        'apply',
        'apply',
        'apply',
        'apply',
        'apply',
        'apply',
        'apply',
        'apply',
        'apply',
        'apply',
        'apply',
        'apply',
        'apply',
        'apply',
    ]);
    // CB-54 steps 2 and 3: the media module's attachments and folders are new;
    // CB-64 pass 2: v3 adds soft delete; CB-157: v4 lets a tool's image be an
    // attachment; CB-230: v5 link card media; CB-308: v6 indexes it by Space;
    // CB-524: v7 a socio's uploads into a Space.
    expect(adopted.steps.filter((step) => step.module === 'media').map((step) => step.action)).toEqual([
        'apply',
        'apply',
        'apply',
        'apply',
        'apply',
        'apply',
        'apply',
    ]);
    // CB-188: Operations' first table, its access log.
    expect(
        adopted.steps.filter((step) => step.module === 'operations').map((step) => `${step.version} ${step.name}`),
    ).toEqual([
        '1 access log',
        '2 resource samples and hourly rollups',
        '3 resource scopes for computers',
        '4 model prices and cost pools',
    ]);
    expect(
        prodDb
            .prepare(
                "SELECT name, dflt_value AS fallback FROM pragma_table_info('data_files') WHERE name IN ('storage', 'sha256', 'name') ORDER BY name",
            )
            .all()
            .map((row) => ({ ...row })),
    ).toEqual([
        // No plaintext digest is kept (CB-54).
        { name: 'name', fallback: null },
        { name: 'storage', fallback: "'local'" },
    ]);
    // Every row is kept; tables new in releases 2 and 3 start empty.
    const after = rowsOf(prodDb);
    // Pages gain their creator (pages migration 2): none for a page without
    // a source conversation, as release 1's is.
    // CB-64: and soft delete stamps (pages migration 3), none deleted.
    expect(after.pages).toEqual(
        before.pages.map((row) => ({
            ...row,
            createdBy: null,
            deletedAt: null,
            deletedBy: null,
            deletedWith: null,
            // CB-308: no cover (pages migration 10).
            coverId: null,
            // CB-328: no structured source attribution (pages migration 13).
            sourceUrl: null,
            sourceTitle: null,
        })),
    );
    // Tasks gain the schedule columns (core migration 2), empty.
    expect(after.tasks).toEqual(
        before.tasks.map((row) => ({
            ...row,
            title: null,
            cadence: null,
            timezone: null,
            dotId: null,
            kind: null,
            jobId: null,
            origin: null,
            lastRunAt: null,
            // CB-64: soft delete (core migration 3), none deleted.
            deletedAt: null,
            deletedBy: null,
            deletedWith: null,
        })),
    );
    // Dots and conversations gain a model choice (workspace migration 3), none,
    // and soft delete stamps (workspace migration 5), none deleted;
    // conversations a renamed flag (workspace migration 6, CB-66), none set,
    // and archive stamps (workspace migration 8), none archived; Dots the
    // board-filing setting (workspace migration 9, CB-31), off, and no owner:
    // company Dots (workspace 10), none archived (11),
    // and no chosen character, so each keeps its id's look (workspace 18, CB-256).
    // CB-207: every conversation is private, with no creator invented
    // (workspace 16).
    for (const table of ['dots', 'thread_bindings']) {
        expect(after[table]).toEqual(
            before[table].map((row) => ({
                ...row,
                inference: null,
                deletedAt: null,
                deletedBy: null,
                ...(table === 'thread_bindings'
                    ? {
                          renamed: 0,
                          archivedAt: null,
                          archivedBy: null,
                          kind: 'private',
                          createdBy: null,
                          convertedAt: null,
                      }
                    : {
                          issuesAllowed: 0,
                          ownerId: null,
                          archivedAt: null,
                          archivedBy: null,
                          // CB-294: migration 19 freezes the look a pre-CB-272 socio had.
                          character: legacyCharacterFor(row.id as string),
                      }),
            })),
        );
    }
    // CB-64: soft delete stamps (core 3, workspace 5, issues 5), none
    // deleted; children that can go with a parent also get `deletedWith`.
    const stamped: Record<string, string[]> = {
        spaces: ['deletedAt', 'deletedBy'],
        issues: ['deletedAt', 'deletedBy'],
        issue_comments: ['deletedAt', 'deletedBy', 'deletedWith'],
        issue_attachments: ['deletedAt', 'deletedBy', 'deletedWith'],
    };
    for (const [table, columns] of Object.entries(stamped)) {
        expect(after[table], table).toEqual(
            before[table].map((row) => ({
                ...row,
                ...Object.fromEntries(columns.map((column) => [column, null])),
            })),
        );
    }
    // CB-64: memories' stamps too (core 3), none deleted; CB-106: they were
    // their people's own, in use, private to them, confirmed when made (core 4).
    expect(after.memories).toEqual(
        before.memories.map((row) => ({
            ...row,
            deletedAt: null,
            deletedBy: null,
            status: 'active',
            source: 'person',
            shareable: 0,
            dotId: null,
            threadId: null,
            updatedAt: row.createdAt,
            confirmedAt: row.createdAt,
        })),
    );
    // CB-179: each socio's Soul starts as its instructions, word for word
    // (workspace 17); with no audit line yet, dated when it was made.
    expect(after.socio_souls).toEqual(
        before.dots!.map((row) => ({
            dotId: row.id,
            version: 1,
            instructions: row.instructions,
            voice: '',
            values: '',
            style: '',
            createdAt: row.createdAt,
            createdBy: 'system',
            source: 'migrated',
            restoredFrom: null,
        })),
    );
    // Learning runs keep their drop reasons (learning migration 3), none;
    // and triage's skips and the analysis's reported use (learning 4,
    // CB-200), none.
    expect(after.learning_runs).toEqual(
        before.learning_runs!.map((row) => ({
            ...row,
            dropReasons: '{}',
            skipped: 0,
            inputTokens: null,
            outputTokens: null,
            costUsd: null,
        })),
    );
    // Agent runs gain a trace (runs migration 4, CB-128), none recorded.
    expect(after.agent_runs).toEqual(before.agent_runs!.map((row) => ({ ...row, trace: null })));
    // Task runs gain a due time (schedule-tasks 2, CB-185), none recorded.
    expect(after.runs).toEqual(before.runs!.map((row) => ({ ...row, dueAt: null })));
    // The history's order is its rowid's (issues 11, CB-110).
    expect(after.issue_events).toEqual(before.issue_events!.map((row, index) => ({ ...row, seq: index + 1 })));
    const changed = [
        'pages',
        'tasks',
        'dots',
        'thread_bindings',
        'learning_runs',
        'agent_runs',
        'runs',
        'memories',
        'issue_events',
        ...Object.keys(stamped),
    ];
    expect(
        Object.fromEntries(Object.entries(after).filter(([name]) => name in before && !changed.includes(name))),
    ).toEqual(Object.fromEntries(Object.entries(before).filter(([name]) => !changed.includes(name))));
    expect(
        Object.entries(after)
            .filter(([name]) => !(name in before))
            .map(([name, rows]) => [name, rows.length]),
    ).toEqual([
        // CB-188: what admins opened in Operations (operations 1), append-only.
        ['access_log', 0],
        // CB-124: the access policy and its append-only audit (auth 4).
        ['access_policy', 0],
        ['access_policy_audit', 0],
        // CB-232: socio grants' append-only audit, contexts and hashed
        // credentials (actors 1).
        ['actor_audit', 0],
        ['actor_contexts', 0],
        ['actor_credentials', 0],
        // CB-90: connected agents' grants and the client domain allowlist
        // (agent-grants 1).
        ['agent_grants', 0],
        ['agent_settings', 0],
        // CB-232: each app's actor-envelope key epoch (apps 7).
        ['app_actor_keys', 0],
        // CB-146: promoted apps' build and start attempts (apps 4).
        ['app_attempts', 0],
        // Promoted apps' grants.
        ['app_grants', 0],
        // CB-291: each app's self-healing state (apps 8).
        ['app_health', 0],
        // CB-108: one-time launch codes, shared by every app instance (apps 6).
        ['app_launch_codes', 0],
        // Mini apps and their sessions.
        ['app_sessions', 0],
        // Packaged versions.
        ['app_versions', 0],
        // Approvals and the data space's metadata.
        ['approval_audit', 0],
        // Auto approvals.
        ['approval_auto_decisions', 0],
        ['approval_guidance', 0],
        // CB-58: the notes of turns carrying on after a decision (approvals 3).
        ['approval_notes', 0],
        ['approval_policies', 0],
        ['approval_requests', 0],
        ['apps', 0],
        // CB-26: the Ask a socio panel's conversations and last socio (ask 1).
        ['ask_preferences', 0],
        ['auth_account', 0],
        // CB-360: when each account last made a signed-in request (auth 5).
        ['auth_activity', 0],
        // CB-352: the app's devices (auth 8).
        ['auth_device', 0],
        // CB-352: the app's sign-in sheet requests (auth 9).
        ['auth_device_code', 0],
        ['auth_device_pairing', 0],
        // CB-352: push endpoints still to clean up (auth 14).
        ['auth_device_push_leftover', 0],
        ['auth_device_request', 0],
        // CB-379: device turns across processes (auth 15).
        ['auth_device_turn', 0],
        // CB-376: groups, Better Auth's organization plugin (auth 6): the one
        // workspace organization, and a member row per account (none here).
        ['auth_invitation', 0],
        ['auth_link_via', 0],
        ['auth_member', 0],
        // CB-90: the OAuth provider's clients, consents and tokens (auth 3).
        ['auth_oauth_access_token', 0],
        ['auth_oauth_client', 0],
        ['auth_oauth_client_assertion', 0],
        ['auth_oauth_client_resource', 0],
        ['auth_oauth_consent', 0],
        ['auth_oauth_refresh_token', 0],
        ['auth_oauth_resource', 0],
        ['auth_organization', 1],
        ['auth_organization_role', 0],
        ['auth_passkey', 0],
        ['auth_session', 0],
        ['auth_user', 0],
        ['auth_verification', 0],
        // CB-352: the workspace's id, made once (auth 8).
        ['auth_workspace', 1],
        // CB-390: the workspace owner (auth 16).
        ['auth_workspace_owner', 0],
        // Live updates step 1: change counters (change-counters 1), bumped by
        // triggers only, so none from a migration.
        ['change_counters', 0],
        // CB-134: every fact the notes pinned (chat 2), kept past their cap.
        ['chat_context_facts', 0],
        // CB-217: each fold of a room's notes (chat 9), written as turns run.
        ['chat_context_note_versions', 0],
        // CB-129: long chats' running notes (chat 1), written as turns run.
        ['chat_context_notes', 0],
        // CB-292: pending and settled name suggestions, one row per chat.
        ['chat_name_suggestions', 0],
        // CB-217: a room's pinned facts and proposals (chat 9), by its people.
        ['chat_pins', 0],
        // CB-143: the workspace's chat skills, their revisions, and the skills
        // on in chats (chat-skills 1), added as people use them.
        ['chat_skill_revisions', 0],
        ['chat_skill_sessions', 0],
        ['chat_skills', 0],
        // CB-151: messages sent while a turn runs (chat 5), until a turn
        // takes them.
        ['chat_steering', 0],
        // CB-141: the date and time told along each thread (chat 4).
        ['chat_time_markers', 0],
        // CB-198: failure labels, the seam's calls and evaluations, and the
        // labeling cursor (classify 1).
        ['classify_calls', 0],
        ['classify_cursors', 0],
        ['classify_evals', 0],
        ['classify_labels', 0],
        ['coding_denials', 0],
        ['coding_runs', 0],
        ['coding_sessions', 0],
        ['coding_settings', 0],
        // CB-326 step 3: the session host's thread events.
        ['coding_thread_events', 0],
        ['context_threads', 0],
        // CB-195, CB-196: backends' providers, cost pools and their meter
        // readings, model prices and the price sync's runs (operations 4),
        // all made as the app runs.
        ['cost_backends', 0],
        ['cost_meter_readings', 0],
        ['cost_pools', 0],
        // Admins' data API tokens (data 17).
        ['data_api_tokens', 0],
        ['data_audit', 0],
        // CB-191: each dataset's sizes per day (data 8).
        ['data_dataset_days', 0],
        ['data_datasets', 0],
        // CB-451: columns' field settings (data 16).
        ['data_field_settings', 0],
        ['data_files', 0],
        ['data_grants', 0],
        // CB-451: plugin needs bound to workspace datasets (data 13).
        ['data_plugin_bindings', 0],
        ['data_plugin_budgets', 0],
        ['dispatch_run_events', 0],
        ['dispatch_runs', 0],
        ['dispatch_settings', 0],
        // Domains: managed hostnames and the operations' audit.
        ['domain_hosts', 0],
        ['domain_ops', 0],
        // Each Dot's own audit (workspace 11): none recorded at upgrade.
        ['dot_audit', 0],
        // Capability requests from Dots.
        ['dot_request_notices', 0],
        ['dot_request_requesters', 0],
        ['dot_requests', 0],
        // CB-169, CB-182: feature flag rules, people's choices and plans
        // (flags 1), set in Settings; flags 2 retired the choices (CB-503).
        ['flag_choices', 0],
        ['flag_rules', 0],
        ['flag_tenant_tiers', 0],
        ['flag_tiers', 0],
        // CB-239: coding models, limits, in-flight reservations, usage counts
        // and dropped field names (gateway 1); coding repositories, Git
        // limits, token mint counts and CB-267's extractions (gateway 2);
        // dispatch runs' credentials by hash and Settings → Coding's switches
        // (gateway 5). No content.
        ['gateway_dispatch_credentials', 0],
        ['gateway_dropped_fields', 0],
        // CB-326 step 6: the coding session gateway exchange log.
        ['gateway_exchanges', 0],
        ['gateway_extractions', 0],
        ['gateway_git_mints', 0],
        ['gateway_git_settings', 0],
        ['gateway_limits', 0],
        ['gateway_model_repositories', 0],
        ['gateway_models', 0],
        ['gateway_options', 0],
        ['gateway_repositories', 0],
        ['gateway_reservations', 0],
        ['gateway_usage', 0],
        // Persistent goals (schedules 5) and their comments (schedules 7).
        ['goal_comments', 0],
        ['goals', 0],
        // CB-380: what workspace bundle imports brought in (bundle 1).
        ['import_map', 0],
        ['import_runs', 0],
        // I1: the env seeds a backend at platform start, not in a migration.
        ['inference_backends', 0],
        ['inference_settings', 0],
        // Response times per model (inference migration 2).
        ['inference_timings', 0],
        // CB-90: connected agents' actions, beside the person's (issues 9).
        ['issue_agent_actions', 0],
        // CB-442: the plugins and apps an issue is about, and their names for history (issues 16).
        ['issue_component_names', 0],
        ['issue_components', 0],
        // CB-39: seeded from the highest issue number.
        ['issue_counter', 1],
        // CB-31: each Dot filing, with the Dot and the person (issues 6);
        // their comments and votes too (issues 8).
        ['issue_dot_actions', 0],
        // CB-29: blocked-by links (issues 10).
        ['issue_links', 0],
        // CB-274: related links (issues 15).
        ['issue_relations', 0],
        // CB-194: the turns items were filed from (issues 14).
        ['issue_runs', 0],
        // CB-30: automatic triage proposals (issues 10).
        ['issue_triage', 0],
        // CB-83: upvotes, one live vote per person per item (issues 8).
        ['issue_votes', 0],
        // CB-243: future-only watches start empty, without historical notices.
        ['issue_watch_members', 0],
        ['issue_watch_outbox', 0],
        ['issue_watches', 0],
        // CB-122: jobs that run until done, their long runs and items
        // (schedules 8).
        ['job_items', 0],
        ['job_long_runs', 0],
        // Jobs, their versions and runs; the runs' counts by status, kept by
        // triggers (schedules 4).
        ['job_run_counts', 0],
        ['job_runs', 0],
        ['job_versions', 0],
        ['jobs', 0],
        // CB-250: personal outbound connections start empty, with no grants,
        // credentials, provider contacts or business calls during migration.
        ['mcp_calls', 0],
        ['mcp_connections', 0],
        ['mcp_grants', 0],
        ['mcp_oauth_attempts', 0],
        // CB-54: chat attachments (media migration 1).
        ['media_attachments', 0],
        // CB-230: link cards' media copies (media 5).
        ['media_embeds', 0],
        // CB-54 step 3: the Media page's empty folders (media migration 2).
        ['media_folders', 0],
        // CB-180: each person's episodes of their own chats (memories 2).
        ['memory_episodes', 0],
        // CB-133: reactions on a Dot's messages (chat 3), given as people use chats.
        ['message_reactions', 0],
        ['model_prices', 0],
        // CB-114: notifications, their deliveries, in-app notices, images,
        // push subscriptions and the sealed push key (notifications 1).
        ['notification_deliveries', 0],
        ['notification_images', 0],
        ['notification_in_app', 0],
        ['notification_push_subscriptions', 0],
        ['notification_settings', 0],
        ['notifications', 0],
        // CB-193: resource measurements start at collection, never backfilled.
        ['ops_samples', 0],
        ['ops_samples_hourly', 0],
        ['page_deletions', 0],
        // CB-328: page links (pages migration 12), new and empty.
        ['page_links', 0],
        // Page revisions (pages migration 6), kept on edits from now on, so
        // none from a migration.
        ['page_revisions', 0],
        // Page search (pages migration 5): the live page's text, freshness
        // from use and the timing rollup.
        ['page_search', 1],
        ['page_search_daily', 0],
        // CB-328: page tags (pages migration 11), new and empty.
        ['page_tags', 0],
        ['page_use', 0],
        ['page_use_days', 0],
        ['person_seeds', 0],
        // Plugins: installs, one-time launch codes and sessions (plugins 1).
        // Empty until an admin installs one. Planner tables are not here; they
        // are created when that plugin is installed.
        ['plugin_access_generation', 0],
        ['plugin_codes', 0],
        // Socio Secrets phase 2: each plugin's identity tokens, hashed (plugins 4).
        ['plugin_identities', 0],
        ['plugin_installs', 0],
        // CB-527: plugins' release notes, the version read, who saw them (plugins 5).
        ['plugin_release_notes', 0],
        ['plugin_release_seen', 0],
        ['plugin_release_state', 0],
        ['plugin_sessions', 0],
        ['price_sync_runs', 0],
        // CB-166: the newest release each person has seen (workspace 14).
        ['release_seen', 0],
        // CB-166: when each person was first shown each release (workspace 15).
        ['release_views', 0],
        // CB-207: rooms' people, socios, limits, events and Telegram bindings
        // (rooms 1); no private chat gets a row.
        ['room_events', 0],
        // CB-206: the handoffs between a room's socios (rooms 4), none yet.
        ['room_handoffs', 0],
        ['room_members', 0],
        // CB-216: people mentioned, notices sent and each member's level per
        // room (rooms 3), none yet.
        ['room_mentions', 0],
        ['room_notices', 0],
        ['room_notify_settings', 0],
        // CB-215: each member's read cursor (rooms 2), none yet.
        ['room_read_state', 0],
        ['room_settings', 0],
        ['room_socios', 0],
        ['room_source_bindings', 0],
        // CB-194: what grounded each turn (runs 5).
        ['run_refs', 0],
        // CB-204: settings that are secrets, sealed (core 7), none yet.
        // CB-108: durable runtime identities and fencing metadata, no user content.
        // Data tokens by hash and cross-runtime stop signals (runtime 2).
        // CB-232: which actor-access contract each runtime enforces (runtime 3).
        ['runtime_contracts', 0],
        ['runtime_data_tokens', 0],
        ['runtime_instances', 0],
        ['runtime_leases', 0],
        ['runtime_recoveries', 0],
        ['runtime_signals', 0],
        ['runtime_work', 0],
        ['secret_settings', 0],
        // CB-57: service accounts and their keys (workspace migration 4).
        ['service_accounts', 0],
        ['service_keys', 0],
        // CB-232: socios' delegation grants (actors 1).
        ['socio_grants', 0],
        // CB-179: each socio's Soul (workspace 17), version 1 its instructions.
        ['socio_souls', 1],
        // CB-181: a Space's people and access (spaces 1) and its shared
        // memory (memories 3): nothing until an editor sets them.
        ['space_members', 0],
        ['space_memories', 0],
        ['space_settings', 0],
        // CB-145: which socio reply each bot message in a Telegram DM shows
        // (telegram 2), for reactions there.
        ['telegram_replies', 0],
        // CB-214: codes that bind a forum topic to a room, and who a bound
        // topic did not answer (telegram 3).
        ['telegram_room_codes', 0],
        ['telegram_topic_senders', 0],
        // CB-176: the note of a detected time zone that moved (core 6).
        ['time_zone_notes', 0],
        ['user_inference_connections', 0],
        // CB-101: a person's own preferences (workspace 13).
        ['user_preferences', 0],
        // CB-106: a person's profile (core 4), written by them; CB-159: its
        // time zone may be detected (core 5).
        ['user_profiles', 0],
        // Per-Dot web identity and the web-read audit.
        ['web_audit', 0],
        ['web_identity', 0],
        // CB-64: deletes without an audit of their own (workspace migration 5).
        // CB-211: work cycles and the rate limit's message times (cycles 1).
        ['work_cycle_submissions', 0],
        ['work_cycles', 0],
        ['workspace_audit', 0],
        // Socio Secrets, phase 1: workloads' secrets, their sealed versions
        // and their grants (workspace-secrets 1), none until an admin sets one.
        // Phase 4: read flags (workspace-secrets 2), none until a rule fires.
        ['workspace_secret_flags', 0],
        ['workspace_secret_grants', 0],
        ['workspace_secret_versions', 0],
        ['workspace_secrets', 0],
    ]);
    expect(log(prodDb)).toEqual(log(freshDb));
    freshDb.close();
    prodDb.close();

    // The second boot applies nothing and takes no backup.
    for (const [path, backups] of [
        [fresh, 'fresh-backups'],
        [prod, 'prod-backups'],
    ]) {
        const again = boot(path, join(dir, backups));
        expect(again).toEqual({ steps: [], backup: undefined });
    }
    expect(readdirSync(join(dir, 'prod-backups'))).toHaveLength(1);

    // Opening the stores as the server does changes no schema either.
    for (const path of [fresh, prod]) {
        const schema = schemaOf(open(path));
        const store = new Store(path);
        const workspace = new WorkspaceStore(path);
        const runner = new LocalAgentRunner(path);
        const state = new SqliteStateStore(path);
        state.close();
        runner.close();
        workspace.close();
        store.close();
        expect(schemaOf(open(path))).toEqual(schema);
    }
    expect(rowsOf(open(prod)).agent_runs).toEqual(before.agent_runs!.map((row) => ({ ...row, trace: null })));
});

it('runs a baseline that finds objects missing, filling in what an older database lacks', () => {
    const dir = scratch();
    const path = join(dir, 'old.sqlite');
    const old = open(path);
    old.exec(
        "CREATE TABLE agent_runs (seq INTEGER PRIMARY KEY AUTOINCREMENT, threadId TEXT NOT NULL, runId TEXT NOT NULL UNIQUE, status TEXT NOT NULL, events TEXT NOT NULL, startedAt INTEGER NOT NULL, finishedAt INTEGER); INSERT INTO agent_runs (threadId, runId, status, events, startedAt) VALUES ('t', 'r', 'finished', '[]', 1)",
    );
    old.close();
    const { steps, backup } = boot(path, join(dir, 'backups'));
    expect(steps.find((step) => step.module === 'runs')?.action).toBe('apply');
    expect(backup).toBeDefined();
    const db = open(path);
    expect(db.prepare('SELECT runId, source, errorDetail FROM agent_runs').all()).toEqual([
        { runId: 'r', source: null, errorDetail: null },
    ]);
});

it('applies a new migration once, after a backup, and rolls back a failing one', () => {
    const dir = scratch();
    const path = join(dir, 'db.sqlite');
    const backups = join(dir, 'backups');
    boot(path, backups);
    const db = open(path);
    db.exec("INSERT INTO memories (id, text, createdAt) VALUES ('m', 'kept', 1)");
    db.close();
    const next = (up: string): SchemaSet[] =>
        schemas.map((set) =>
            set.id === 'core'
                ? {
                      ...set,
                      migrations: [...set.migrations!, { version: 8, name: 'memory pins', up }],
                  }
                : set,
        );

    expect(() =>
        boot(path, backups, next('ALTER TABLE memories ADD COLUMN pinned INTEGER; SELECT * FROM nowhere')),
    ).toThrow(/nowhere/);
    const failed = open(path);
    expect(
        failed
            .prepare('PRAGMA table_info(memories)')
            .all()
            .some((column) => column.name === 'pinned'),
    ).toBe(false);
    expect(failed.prepare("SELECT * FROM schema_migrations WHERE module='core'").all()).toHaveLength(7);
    failed.close();

    const sets = next('ALTER TABLE memories ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0');
    const first = boot(path, backups, sets);
    expect(first.steps).toEqual([{ module: 'core', version: 8, name: 'memory pins', action: 'apply' }]);
    expect(first.backup).toBeDefined();
    expect(boot(path, backups, sets).steps).toEqual([]);
    expect(open(path).prepare('SELECT id, text, pinned FROM memories').all()).toEqual([
        { id: 'm', text: 'kept', pinned: 0 },
    ]);
    // Core 8 only expanded (CB-108): a store opened by this older code still
    // runs on the newer database, as the previous release does while a
    // start-first deploy overlaps the two.
    expect(() => new Store(path).close()).not.toThrow();
});

it('refuses a database a newer build contracted, and runs on one it only expanded', () => {
    const dir = scratch();
    const path = join(dir, 'db.sqlite');
    boot(path, join(dir, 'backups'));
    const db = open(path);
    const known = issuesSchema.migrations!.length;
    db.exec(`INSERT INTO schema_migrations VALUES ('issues', ${known + 1}, 'issue reactions', 1, 'x')`);
    // An expand migration (CB-108): this build runs on it.
    expect(planMigrations(db, schemas, { strict: true })).toEqual([]);
    // A contract that needs builds knowing it: refused.
    db.exec('CREATE TABLE schema_readers(module TEXT PRIMARY KEY, minVersion INTEGER NOT NULL)');
    db.exec(`INSERT INTO schema_readers VALUES ('issues', ${known + 1})`);
    expect(() => planMigrations(db, schemas)).toThrow(
        new RegExp(`issues migration ${known + 1}, but this build of Socio knows only up to ${known}`),
    );
    db.exec(`DELETE FROM schema_migrations WHERE module='issues' AND version=${known + 1}`);
    db.exec("DELETE FROM schema_readers WHERE module='issues'");
    db.exec("INSERT INTO schema_migrations VALUES ('billing', 1, 'baseline', 1, 'x')");
    // A module this build lacks, which only expanded: it runs.
    expect(planMigrations(db, schemas, { strict: true })).toEqual([]);
    db.exec("INSERT INTO schema_readers VALUES ('billing', 1)");
    db.close();
    expect(() => boot(path, join(dir, 'backups'))).toThrow(/module "billing", which this build of Socio doesn't have/);
    // A store checks only its own module, so tests can open such a file.
    expect(() => new Store(path).close()).not.toThrow();
});

it('rejects malformed migration lists and warns about an edited migration', () => {
    const db = new DatabaseSync(':memory:');
    cleanup.push(() => db.close());
    const up = 'CREATE TABLE t(id TEXT)';
    expect(() => migrate(db, [{ id: 'Bad', migrations: [] }])).toThrow(/Invalid module id/);
    expect(() =>
        migrate(db, [
            { id: 'a', migrations: [] },
            { id: 'a', migrations: [] },
        ]),
    ).toThrow(/listed twice/);
    expect(() =>
        migrate(db, [
            {
                id: 'a',
                migrations: [
                    { version: 2, name: 'two', up },
                    { version: 1, name: 'one', up },
                ],
            },
        ]),
    ).toThrow(/increasing/);
    expect(() => migrate(db, [{ id: 'a', migrations: [{ version: 2, name: 'b', baseline: true, up }] }])).toThrow(
        /Only version 1/,
    );

    migrate(db, [{ id: 'a', migrations: [{ version: 1, name: 'one', up }] }]);
    const lines: string[] = [];
    migrate(
        db,
        [
            {
                id: 'a',
                migrations: [{ version: 1, name: 'one', up: 'CREATE TABLE t(id TEXT, x TEXT)' }],
            },
        ],
        { log: (line) => lines.push(line) },
    );
    expect(lines).toEqual(['Migration a 1 (one) changed after it was applied.']);
});

it('takes a former checksum of a migration as unchanged, and only that one', () => {
    const db = new DatabaseSync(':memory:');
    cleanup.push(() => db.close());
    const before: Migration = { version: 1, name: 'one', up: 'CREATE TABLE t(id TEXT)' };
    migrate(db, [{ id: 'a', migrations: [before] }]);
    const lines: string[] = [];
    const log = (line: string) => lines.push(line);
    const reformatted = { ...before, up: 'CREATE TABLE  t( id TEXT )' };
    migrate(db, [{ id: 'a', migrations: [{ ...reformatted, formerChecksums: [migrationChecksum(before)] }] }], {
        log,
    });
    expect(lines).toEqual([]);
    migrate(db, [{ id: 'a', migrations: [{ ...reformatted, formerChecksums: ['0000000000000000'] }] }], { log });
    expect(lines).toEqual(['Migration a 1 (one) changed after it was applied.']);
});

it('leaves migrating to boot: a store refuses a database nothing migrated', () => {
    expect(() => new Store(':memory:')).toThrow(/no such table/);
    expect(() => new WorkspaceStore(':memory:')).toThrow(/no such table/);
    const db = new DatabaseSync(':memory:');
    cleanup.push(() => db.close());
    expect(migrate(db, [coreSchema]).map((step) => step.action)).toEqual([
        'apply',
        'apply',
        'apply',
        'apply',
        'apply',
        'apply',
        'apply',
    ]);
    expect(migrate(db, [coreSchema])).toEqual([]);
});

it('lets users have the operator role, keeping every user (workspace 2)', () => {
    const db = new DatabaseSync(':memory:');
    cleanup.push(() => db.close());
    migrate(db, [{ ...workspaceSchema, migrations: workspaceSchema.migrations!.slice(0, 1) }]);
    const insert = db.prepare('INSERT INTO users (id, name, role, createdAt, lastSeenAt) VALUES (?, ?, ?, 1, 2)');
    insert.run('alice', 'Alice', 'admin');
    insert.run('bob', 'Bob', 'member');
    expect(() => insert.run('olga', 'Olga', 'operator')).toThrow(/CHECK/);
    migrate(db, [workspaceSchema]);
    const users = () => db.prepare('SELECT * FROM users ORDER BY id').all();
    expect(users()).toEqual([
        { id: 'alice', name: 'Alice', role: 'admin', createdAt: 1, lastSeenAt: 2 },
        { id: 'bob', name: 'Bob', role: 'member', createdAt: 1, lastSeenAt: 2 },
    ]);
    db.prepare("UPDATE users SET role='operator' WHERE id='alice'").run();
    expect(users()[0]).toMatchObject({ role: 'operator' });
    expect(() => db.prepare('INSERT INTO users VALUES (?, ?, ?, 1, 2)').run('eve', 'Eve', 'owner')).toThrow(/CHECK/);
});

it('records connected agents’ actions with both identities, refusing either missing (issues 9)', () => {
    const db = new DatabaseSync(':memory:');
    cleanup.push(() => db.close());
    migrate(db, [{ ...issuesSchema, migrations: issuesSchema.migrations!.slice(0, 8) }]);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='issue_agent_actions'").get()).toBeUndefined();
    expect(migrate(db, [issuesSchema]).map((step) => step.version)).toEqual([9, 10, 11, 12, 13, 14, 15, 16]);
    const insert = db.prepare(
        'INSERT INTO issue_agent_actions (id, issueId, action, targetId, grantId, clientId, clientName, label, userId, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const row = {
        id: 'a1',
        issueId: 'i1',
        action: 'comment',
        targetId: 'c1',
        grantId: 'g1',
        clientId: 'https://claude.ai/cimd',
        clientName: 'Claude Code',
        label: 'Claude Code on laptop',
        userId: 'bob',
        createdAt: 1,
    };
    const run = (fields: Partial<Record<keyof typeof row, unknown>>) =>
        insert.run(...(Object.values({ ...row, ...fields }) as Array<string | number | null>));
    run({});
    run({ id: 'a2', action: 'create', targetId: null });
    for (const [field, value] of [
        ['action', 'delete'],
        ['action', null],
        ['targetId', null],
        ['targetId', ''],
        ['grantId', ''],
        ['grantId', null],
        ['clientId', ''],
        ['clientName', ''],
        ['label', ''],
        ['userId', ''],
        ['userId', null],
        ['issueId', ''],
    ] as const) {
        expect(() => run({ id: `x-${field}`, [field]: value })).toThrow(/CHECK|NOT NULL/);
    }
    expect(db.prepare('SELECT COUNT(*) AS n FROM issue_agent_actions').get()).toEqual({ n: 2 });
});

it('keeps blocked-by links to one live link per pair, and a triage proposal complete (issues 10)', () => {
    const db = new DatabaseSync(':memory:');
    cleanup.push(() => db.close());
    migrate(db, [issuesSchema]);
    const link = db.prepare(
        "INSERT INTO issue_links (id, fromId, toId, kind, createdBy, createdAt, removedAt, removedBy) VALUES (?, ?, ?, 'blocked_by', ?, 1, ?, ?)",
    );
    link.run('l1', 'a', 'b', 'alice', null, null);
    // One live link per pair; a removed one (stamped) doesn't count.
    expect(() => link.run('l2', 'a', 'b', 'alice', null, null)).toThrow(/UNIQUE/);
    link.run('l3', 'a', 'c', 'alice', 2, 'alice');
    link.run('l4', 'a', 'c', 'alice', null, null);
    // Not itself, and removal records who.
    expect(() => link.run('l5', 'a', 'a', 'alice', null, null)).toThrow(/CHECK/);
    expect(() => link.run('l6', 'a', 'd', 'alice', 2, null)).toThrow(/CHECK/);
    expect(() => link.run('l7', 'a', 'd', '', null, null)).toThrow(/CHECK/);
    const triage = db.prepare(
        'INSERT INTO issue_triage (issueId, state, kind, area, priority, labels, reason, commentId, error, createdAt, decidedAt, decidedBy) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)',
    );
    triage.run('i1', 'pending', null, null, null, null, null, null, null, null, null);
    triage.run('i2', 'proposed', 'bug', null, 'high', '[]', 'Why', 'c1', null, null, null);
    triage.run('i3', 'applied', 'bug', 'server', 'low', '[]', 'Why', 'c1', null, 2, 'alice');
    triage.run('i4', 'failed', null, null, null, null, null, null, 'No answer.', null, null);
    // A proposal has every field; a decision its time and person; a failure its why.
    for (const row of [
        ['x1', 'proposed', null, null, 'high', '[]', 'Why', 'c1', null, null, null],
        ['x2', 'proposed', 'bug', null, 'high', '[]', null, 'c1', null, null, null],
        ['x3', 'ignored', 'bug', null, 'high', '[]', 'Why', 'c1', null, null, null],
        ['x4', 'failed', null, null, null, null, null, null, null, null, null],
        ['x5', 'maybe', null, null, null, null, null, null, null, null, null],
        ['x6', null, null, null, null, null, null, null, null, null, null],
    ] as const) {
        expect(() => triage.run(...row)).toThrow(/CHECK|NOT NULL/);
    }
    expect(() => triage.run('i1', 'pending', null, null, null, null, null, null, null, null, null)).toThrow(
        /UNIQUE|PRIMARY/,
    );
});

it('adds the deactivation columns, keeping every account and session (auth 2)', () => {
    const db = new DatabaseSync(':memory:');
    cleanup.push(() => db.close());
    migrate(db, [{ ...authSchema, migrations: authSchema.migrations!.slice(0, 1) }]);
    db.prepare(
        "INSERT INTO auth_user (id, name, email, emailVerified, createdAt, updatedAt, appUserId, role) VALUES ('a1', 'Ada', 'ada@example.com', 1, '2026-10-01', '2026-10-01', 'alice', 'admin')",
    ).run();
    db.prepare(
        "INSERT INTO auth_session (id, expiresAt, token, createdAt, updatedAt, userId) VALUES ('s1', '2026-10-20', 't1', '2026-10-01', '2026-10-01', 'a1')",
    ).run();
    // Up to auth 6: auth 7 ends sessions with no sign-in method, as this one.
    migrate(db, [{ ...authSchema, migrations: authSchema.migrations!.filter((migration) => migration.version <= 6) }]);
    expect(db.prepare('SELECT * FROM auth_user').all()).toEqual([
        {
            id: 'a1',
            name: 'Ada',
            email: 'ada@example.com',
            emailVerified: 1,
            image: null,
            createdAt: '2026-10-01',
            updatedAt: '2026-10-01',
            appUserId: 'alice',
            role: 'admin',
            banned: 0,
            banReason: null,
            banExpires: null,
        },
    ]);
    expect(db.prepare('SELECT id, impersonatedBy FROM auth_session').all()).toEqual([
        { id: 's1', impersonatedBy: null },
    ]);
});

it('ends the sessions with no sign-in method and keeps the rest (auth 7)', () => {
    const db = new DatabaseSync(':memory:');
    cleanup.push(() => db.close());
    migrate(db, [{ ...authSchema, migrations: authSchema.migrations!.filter((migration) => migration.version <= 6) }]);
    db.prepare(
        "INSERT INTO auth_user (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('a1', 'Ada', 'ada@example.com', 1, '2026-10-01', '2026-10-01')",
    ).run();
    const session = db.prepare(
        "INSERT INTO auth_session (id, expiresAt, token, createdAt, updatedAt, userId, signInMethod) VALUES (?, '2026-12-20', ?, '2026-10-01', '2026-10-01', 'a1', ?)",
    );
    session.run('legacy', 't1', null);
    session.run('password', 't2', 'password');
    session.run('provider', 't3', 'provider:logto');
    migrate(db, [authSchema]);
    expect(db.prepare('SELECT id, signInMethod FROM auth_session ORDER BY id').all()).toEqual([
        { id: 'password', signInMethod: 'password' },
        { id: 'provider', signInMethod: 'provider:logto' },
    ]);
});

it('keeps the first of two live sheet requests with the same challenge or state (auth 12)', () => {
    const db = new DatabaseSync(':memory:');
    cleanup.push(() => db.close());
    migrate(db, [{ ...authSchema, migrations: authSchema.migrations!.filter((migration) => migration.version <= 11) }]);
    const later = Date.now() + 600_000;
    const insert = db.prepare(
        "INSERT INTO auth_device_request (id, challenge, state, platform, variant, createdAt, expiresAt) VALUES (?, ?, ?, 'ios', 'production', ?, ?)",
    );
    // A start URL retried on the previous release: both still live.
    insert.run('first', 'c1', 's1', 1, later);
    insert.run('retry', 'c1', 's1', 2, later);
    insert.run('other', 'c2', 's1', 3, later);
    insert.run('alone', 'c3', 's3', 4, later);
    migrate(db, [authSchema]);
    expect(db.prepare('SELECT id FROM auth_device_request ORDER BY id').all()).toEqual([
        { id: 'alone' },
        { id: 'first' },
    ]);
});

it('records page creators from their source conversation and adds tombstones (pages 2)', () => {
    const db = new DatabaseSync(':memory:');
    cleanup.push(() => db.close());
    migrate(db, [workspaceSchema, { ...pagesSchema, migrations: pagesSchema.migrations!.slice(0, 1) }]);
    db.exec(`INSERT INTO thread_bindings (id, dotId, ownerId, title, createdAt) VALUES ('t1', 'd1', 'bob', 'Notes', 1);
    INSERT INTO pages VALUES ('saved', 's1', NULL, 'Saved', '', 1, 1, 1, 't1');
    INSERT INTO pages VALUES ('typed', 's1', NULL, 'Typed', '', 1, 1, 1, NULL);
    INSERT INTO pages VALUES ('orphan', 's1', NULL, 'Orphan', '', 1, 1, 1, 'gone');`);
    migrate(db, [workspaceSchema, pagesSchema]);
    expect(db.prepare('SELECT id, createdBy FROM pages ORDER BY id').all()).toEqual([
        { id: 'orphan', createdBy: null },
        { id: 'saved', createdBy: 'bob' },
        { id: 'typed', createdBy: null },
    ]);
    expect(db.prepare('SELECT * FROM page_deletions').all()).toEqual([]);
});

it('indexes a Space’s live pages for the list, titles and recent queries (pages 4)', () => {
    const db = new DatabaseSync(':memory:');
    cleanup.push(() => db.close());
    migrate(db, [workspaceSchema, { ...pagesSchema, migrations: pagesSchema.migrations!.slice(0, 3) }]);
    const insert = db.prepare(
        "INSERT INTO pages (id, spaceId, parentId, title, content, revision, createdAt, updatedAt, sourceThreadId, createdBy, deletedAt) VALUES (?, ?, NULL, ?, '', 1, ?, ?, NULL, NULL, ?)",
    );
    for (let index = 0; index < 40; index++) {
        insert.run(`p${index}`, `s${index % 4}`, `Page ${index}`, index, 100 - index, index % 5 === 0 ? 1000 : null);
    }
    const before = db.prepare('SELECT * FROM pages ORDER BY id').all();
    migrate(db, [workspaceSchema, { ...pagesSchema, migrations: pagesSchema.migrations!.slice(0, 4) }]);
    expect(
        db.prepare("SELECT version, name FROM schema_migrations WHERE module='pages' ORDER BY version").all().at(-1),
    ).toEqual({ version: 4, name: 'space page indexes' });
    // Every row is kept as it was.
    expect(db.prepare('SELECT * FROM pages ORDER BY id').all()).toEqual(before);
    // Partial: deleted pages are not in either index.
    expect(
        db
            .prepare(
                "SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='pages' AND sql IS NOT NULL ORDER BY name",
            )
            .all()
            .map((row) => ({ ...row })),
    ).toEqual([
        {
            name: 'pages_space_live',
            sql: 'CREATE INDEX pages_space_live ON pages(spaceId, createdAt, id) WHERE deletedAt IS NULL',
        },
        {
            name: 'pages_space_recent',
            sql: 'CREATE INDEX pages_space_recent ON pages(spaceId, updatedAt DESC, title) WHERE deletedAt IS NULL',
        },
    ]);

    migrate(db, [workspaceSchema, pagesSchema]);
    // The store's own queries, as it prepares them: each searches a Space's
    // live pages by index and none sorts or scans the table.
    const plans = new Map<string, string[]>();
    const recording = new Proxy(db, {
        get(target, key) {
            if (key !== 'prepare') {
                return Reflect.get(target, key, target);
            }
            return (sql: string) => {
                if (/FROM pages WHERE spaceId=\?/.test(sql) && !plans.has(sql)) {
                    plans.set(
                        sql,
                        target
                            .prepare(`EXPLAIN QUERY PLAN ${sql}`)
                            .all(...(sql.includes('LIMIT') ? ['s1', 5] : ['s1']))
                            .map((row) => String(row.detail)),
                    );
                }
                return target.prepare(sql);
            };
        },
    });
    const pages = new Pages(recording, () => true);
    expect(pages.list('s1').map((page) => page.id)).toEqual(['p1', 'p9', 'p13', 'p17', 'p21', 'p29', 'p33', 'p37']);
    expect(pages.titles('s1')).toHaveLength(8);
    expect(pages.recent('s1', 5)).toMatchObject({
        total: 8,
        // Newest edit first: updatedAt falls as the index grows.
        pages: ['p1', 'p9', 'p13', 'p17', 'p21'].map((id) => ({ id })),
    });
    // list, titles, recent and its count, in that order.
    const [list, titles, recent, count] = [...plans.values()].map((plan) => plan.join(' | '));
    expect(plans.size).toBe(4);
    expect(list).toBe('SEARCH pages USING INDEX pages_space_live (spaceId=?)');
    expect(titles).toBe(list);
    expect(recent).toBe('SEARCH pages USING INDEX pages_space_recent (spaceId=?)');
    expect(count).toMatch(/^SEARCH pages USING INDEX pages_space_(live|recent) \(spaceId=\?\)$/);
});

it('rebuilds jobs keeping every row, so a deleted job’s name is free again (schedules 2, CB-64)', () => {
    const db = new DatabaseSync(':memory:');
    cleanup.push(() => db.close());
    migrate(db, [
        {
            ...schedulesSchema,
            migrations: schedulesSchema.migrations!.slice(0, 1),
        },
    ]);
    const insert = db.prepare('INSERT INTO jobs VALUES (?, ?, ?, ?, ?, ?, ?)');
    insert.run('j1', 'alice', 'd1', 'Collect prices', 2, 1, 5);
    insert.run('j2', 'bob', 'd1', 'Collect prices', 1, 2, 2);
    db.exec("INSERT INTO job_versions VALUES ('j1', 1, 'main.sh', '[]', 'x', 30, '[]', NULL, 1)");
    const before = db.prepare('SELECT * FROM jobs ORDER BY id').all();
    migrate(db, [schedulesSchema]);
    expect(db.prepare('SELECT * FROM jobs ORDER BY id').all()).toEqual(
        before.map((row) => ({ ...row, deletedAt: null, deletedBy: null })),
    );
    expect(db.prepare('SELECT COUNT(*) AS n FROM job_versions').get()).toEqual({
        n: 1,
    });
    expect(db.prepare("SELECT sql FROM sqlite_master WHERE name='jobs_name'").get()?.sql).toMatch(
        /UNIQUE INDEX jobs_name ON jobs\(userId, dotId, name\) WHERE deletedAt IS NULL/,
    );
    const add = db.prepare(
        "INSERT INTO jobs (id, userId, dotId, name, version, createdAt, updatedAt) VALUES (?, 'alice', 'd1', 'Collect prices', 1, 9, 9)",
    );
    expect(() => add.run('j3')).toThrow(/UNIQUE/);
    db.exec("UPDATE jobs SET deletedAt=9, deletedBy='alice' WHERE id='j1'");
    add.run('j3');
    expect(
        db
            .prepare("SELECT id FROM jobs WHERE name='Collect prices' ORDER BY id")
            .all()
            .map((row) => row.id),
    ).toEqual(['j1', 'j2', 'j3']);
});

it('indexes the audit and run history, which keep every row now, on a release-1 database (computers 2, domains 2, schedules 3)', () => {
    const dir = scratch();
    const path = join(dir, 'prod.sqlite');
    buildRelease1Database(path);
    const before = rowsOf(open(path)).computer_audit;
    const { steps } = boot(path, join(dir, 'backups'));
    expect(
        steps
            .filter((step) => ['computers', 'domains', 'schedules'].includes(step.module) && step.version > 1)
            .map((step) => `${step.module} ${step.version} ${step.name}`),
    ).toEqual(
        expect.arrayContaining([
            'computers 2 audit index',
            'domains 2 ops by host',
            'schedules 3 keep runs, trim output',
        ]),
    );
    const db = open(path);
    expect(rowsOf(db).computer_audit).toEqual(before);
    expect(before.length).toBeGreaterThan(0);
    expect(
        db
            .prepare(
                "SELECT name, sql FROM sqlite_master WHERE name IN ('computer_audit_dot', 'web_audit_dot', 'domain_ops_host', 'job_runs_untrimmed') ORDER BY name",
            )
            .all()
            .map((row) => ({ ...row })),
    ).toEqual([
        {
            name: 'computer_audit_dot',
            sql: 'CREATE INDEX computer_audit_dot ON computer_audit(dotId, createdAt)',
        },
        {
            name: 'domain_ops_host',
            sql: 'CREATE INDEX domain_ops_host ON domain_ops(hostname, startedAt)',
        },
        {
            name: 'job_runs_untrimmed',
            sql: 'CREATE INDEX job_runs_untrimmed ON job_runs(jobId, queuedAt) WHERE outputTrimmedAt IS NULL',
        },
        {
            name: 'web_audit_dot',
            sql: 'CREATE INDEX web_audit_dot ON web_audit(dotId, createdAt)',
        },
    ]);
});

it('adds the output trim stamp to job runs, keeping every run and its output, and counts them by status (schedules 3, 4)', () => {
    const db = new DatabaseSync(':memory:');
    cleanup.push(() => db.close());
    migrate(db, [{ ...schedulesSchema, migrations: schedulesSchema.migrations!.slice(0, 2) }]);
    db.exec(
        "INSERT INTO job_runs (id, jobId, version, userId, dotId, trigger, status, queuedAt, exitCode, stdout, stderr) VALUES ('r1', 'j1', 1, 'alice', 'd1', 'manual', 'succeeded', 1, 0, 'ok', ''), ('r2', 'j1', 1, 'alice', 'd1', 'schedule', 'interrupted', 2, NULL, NULL, NULL)",
    );
    const before = db.prepare('SELECT * FROM job_runs ORDER BY id').all();
    migrate(db, [schedulesSchema]);
    // CB-122: and the long run a batch belongs to (schedules 8), none.
    expect(db.prepare('SELECT * FROM job_runs ORDER BY id').all()).toEqual(
        before.map((row) => ({ ...row, outputTrimmedAt: null, longRunId: null })),
    );
    // The counts start from the runs there, and follow every write.
    const counts = () =>
        Object.fromEntries(
            db
                .prepare('SELECT status, n FROM job_run_counts')
                .all()
                .map((row) => [row.status, row.n]),
        );
    expect(counts()).toEqual({ interrupted: 1, succeeded: 1 });
    db.exec(
        "INSERT INTO job_runs (id, jobId, version, userId, dotId, trigger, status, queuedAt) VALUES ('r3', 'j1', 1, 'alice', 'd1', 'manual', 'queued', 3)",
    );
    expect(counts()).toEqual({ interrupted: 1, queued: 1, succeeded: 1 });
    db.exec("UPDATE job_runs SET status='running' WHERE id='r3'");
    db.exec("UPDATE job_runs SET status='failed', exitCode=1 WHERE id='r3'");
    db.exec("UPDATE job_runs SET stdout=NULL WHERE id='r3'");
    expect(counts()).toEqual({
        failed: 1,
        interrupted: 1,
        queued: 0,
        running: 0,
        succeeded: 1,
    });
    db.exec("DELETE FROM job_runs WHERE id='r2'");
    expect(counts()).toMatchObject({ interrupted: 0, failed: 1, succeeded: 1 });
});

it('adds goal comments beside existing goals, which keep every column (schedules 7, CB-135)', () => {
    const db = new DatabaseSync(':memory:');
    cleanup.push(() => db.close());
    migrate(db, [
        {
            ...schedulesSchema,
            migrations: schedulesSchema.migrations!.filter((migration) => migration.version <= 6),
        },
    ]);
    db.exec(
        "INSERT INTO goals VALUES ('G-1', 'alice', 'd1', 'Keep it current', '', 's1', 'active', 'Started', 1, 2, NULL)",
    );
    const before = db.prepare('SELECT * FROM goals').all();
    // And long runs (8, CB-122), which leave goals alone.
    expect(migrate(db, [schedulesSchema]).map((step) => step.version)).toEqual([7, 8]);
    expect(db.prepare('SELECT * FROM goals').all()).toEqual(before);
    const insert = db.prepare('INSERT INTO goal_comments VALUES (?, ?, ?, ?, ?, ?)');
    insert.run('GC-1', 'G-1', 'person', 'alice', 'Also this.', 3);
    insert.run('GC-2', 'G-1', 'dot', 'd1', 'Done.', 4);
    // Who wrote it and what, both required.
    expect(() => insert.run('GC-3', 'G-1', 'robot', 'x', 'No.', 5)).toThrow();
    expect(() => insert.run('GC-4', 'G-1', 'dot', '', 'No.', 5)).toThrow();
    expect(() => insert.run('GC-5', 'G-1', 'dot', 'd1', '', 5)).toThrow();
    expect(db.prepare('SELECT COUNT(*) AS n FROM goal_comments').get()).toEqual({
        n: 2,
    });
});

it('adds long runs and their items beside existing jobs, which run once as before (schedules 8, CB-122)', () => {
    const db = new DatabaseSync(':memory:');
    cleanup.push(() => db.close());
    migrate(db, [
        {
            ...schedulesSchema,
            migrations: schedulesSchema.migrations!.filter((migration) => migration.version <= 7),
        },
    ]);
    db.exec("INSERT INTO job_versions VALUES ('j1', 1, 'main.sh', '[]', 'x', 30, '[]', NULL, 1)");
    expect(migrate(db, [schedulesSchema]).map((step) => step.version)).toEqual([8]);
    expect(db.prepare('SELECT untilDone FROM job_versions WHERE jobId=?').get('j1')).toEqual({ untilDone: 0 });
    const run = db.prepare(
        'INSERT INTO job_long_runs (id, jobId, userId, dotId, trigger, status, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, 1, 1)',
    );
    run.run('L1', 'j1', 'alice', 'd1', 'manual', 'running');
    // One open long run per job; an ended one may sit beside it.
    expect(() => run.run('L2', 'j1', 'alice', 'd1', 'manual', 'waiting')).toThrow();
    run.run('L3', 'j1', 'alice', 'd1', 'manual', 'done');
    // A person, a Dot and a known status, all required.
    expect(() => run.run('L4', 'j2', '', 'd1', 'manual', 'waiting')).toThrow();
    expect(() => run.run('L5', 'j2', 'alice', 'd1', 'manual', 'paused')).toThrow();
    const item = db.prepare("INSERT INTO job_items (longRunId, key, status, updatedAt) VALUES ('L1', ?, ?, 1)");
    item.run('a', 'pending');
    // A key once per long run, between 1 and 200 characters.
    expect(() => item.run('a', 'pending')).toThrow();
    expect(() => item.run('', 'pending')).toThrow();
    expect(() => item.run('x'.repeat(201), 'pending')).toThrow();
    expect(() => item.run('b', 'skipped')).toThrow();
});

it('rebuilds data files keeping every row, so a deleted file’s path and a deleted scratch dataset are free again (data 3, media 3, CB-64)', () => {
    const db = new DatabaseSync(':memory:');
    cleanup.push(() => db.close());
    migrate(db, [
        { ...dataSchema, migrations: dataSchema.migrations!.slice(0, 2) },
        { ...mediaSchema, migrations: mediaSchema.migrations!.slice(0, 2) },
    ]);
    const file = db.prepare(
        "INSERT INTO data_files (id, ownerUserId, path, size, storedSize, mediaType, createdByDotId, createdAt, updatedAt, storage, name) VALUES (?, ?, ?, 4, 36, 'text/plain', NULL, 1, 2, ?, ?)",
    );
    file.run('f1', 'alice', 'reports/q3.md', 's3', 'Q3.md');
    file.run('f2', 'alice', 'notes.txt', 'local', null);
    file.run('f3', 'bob', 'reports/q3.md', 'local', null);
    db.exec(
        "INSERT INTO data_datasets (id, ownerUserId, name, createdByDotId, scratchForDotId, createdAt, updatedAt) VALUES ('s1', 'alice', 'Socio scratch', 'd1', 'd1', 1, 1), ('p1', 'alice', 'Prices', NULL, NULL, 1, 1)",
    );
    db.exec(
        "INSERT INTO media_attachments (id, fileId, ownerUserId, threadId, dotId, messageId, name, mediaType, kind, size, source, createdAt, boundAt) VALUES ('a1', 'f1', 'alice', 't1', 'd1', 'm1', 'Q3.md', 'text/plain', 'text', 4, 'web', 1, 2)",
    );
    const before = {
        files: db.prepare('SELECT * FROM data_files ORDER BY id').all(),
        datasets: db.prepare('SELECT * FROM data_datasets ORDER BY id').all(),
        attachments: db.prepare('SELECT * FROM media_attachments').all(),
    };
    migrate(db, [dataSchema, mediaSchema]);
    const stamps = { deletedAt: null, deletedBy: null, deletedWith: null };
    // Data v4 (CB-62) adds the seal key: these were sealed before it.
    expect(db.prepare('SELECT * FROM data_files ORDER BY id').all()).toEqual(
        before.files.map((row) => ({ ...row, ...stamps, sealKey: 'legacy' })),
    );
    // Data v6 (SOFT-DELETE 17.3): no row history counted until a write; v11
    // (CB-369): every dataset keeps all of its history, with no compaction asked.
    expect(db.prepare('SELECT * FROM data_datasets ORDER BY id').all()).toEqual(
        before.datasets.map((row) => ({
            ...row,
            ...stamps,
            historyBytes: 0,
            historyDays: null,
            compactRequestedAt: null,
            analyticalBytes: 0,
            // v15 (CB-451): in no Space, so no place in one.
            spaceParentId: null,
            spacePosition: null,
            spaceAddedAt: null,
        })),
    );
    expect(db.prepare('SELECT * FROM media_attachments').all()).toEqual(
        before.attachments.map((row) => ({ ...row, ...stamps })),
    );
    const indexes = Object.fromEntries(
        (
            db
                .prepare(
                    "SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name IN ('data_files', 'data_datasets') AND sql IS NOT NULL ORDER BY name",
                )
                .all() as Array<{ name: string; sql: string }>
        ).map((row) => [row.name, row.sql.replace(/\s+/g, ' ')]),
    );
    expect(indexes).toEqual({
        data_datasets_owner: 'CREATE INDEX data_datasets_owner ON data_datasets(ownerUserId)',
        data_datasets_space:
            'CREATE INDEX data_datasets_space ON data_datasets(sharedSpaceId, spaceParentId) WHERE sharedSpaceId IS NOT NULL AND deletedAt IS NULL',
        data_datasets_scratch:
            'CREATE UNIQUE INDEX data_datasets_scratch ON data_datasets(ownerUserId, scratchForDotId) WHERE scratchForDotId IS NOT NULL AND deletedAt IS NULL',
        data_files_path: 'CREATE UNIQUE INDEX data_files_path ON data_files(ownerUserId, path) WHERE deletedAt IS NULL',
        data_files_seal: 'CREATE INDEX data_files_seal ON data_files(sealKey)',
        data_files_storage: 'CREATE INDEX data_files_storage ON data_files(storage)',
        data_files_versions:
            'CREATE INDEX data_files_versions ON data_files(deletedWith) WHERE deletedWith IS NOT NULL',
    });
    // A live path stays taken; once deleted, a new file can have it.
    const add = (id: string) => file.run(id, 'alice', 'reports/q3.md', 'local', null);
    expect(() => add('f4')).toThrow(/UNIQUE/);
    db.exec("UPDATE data_files SET deletedAt=9, deletedBy='alice' WHERE id='f1'");
    add('f4');
    // The same for a Dot's scratch dataset.
    const scratch = db.prepare(
        "INSERT INTO data_datasets (id, ownerUserId, name, createdByDotId, scratchForDotId, createdAt, updatedAt) VALUES (?, 'alice', 'Socio scratch', 'd1', 'd1', 9, 9)",
    );
    expect(() => scratch.run('s2')).toThrow(/UNIQUE/);
    db.exec("UPDATE data_datasets SET deletedAt=9, deletedBy='alice' WHERE id='s1'");
    scratch.run('s2');
    expect(
        db
            .prepare("SELECT id FROM data_files WHERE path='reports/q3.md' ORDER BY id")
            .all()
            .map((row) => row.id),
    ).toEqual(['f1', 'f3', 'f4']);
});

it('rebuilds media attachments keeping every row, so a tool’s image can be one (media 4, CB-157)', () => {
    const db = new DatabaseSync(':memory:');
    cleanup.push(() => db.close());
    migrate(db, [dataSchema, { ...mediaSchema, migrations: mediaSchema.migrations!.slice(0, 3) }]);
    db.exec(
        "INSERT INTO media_attachments (id, fileId, ownerUserId, threadId, dotId, messageId, name, mediaType, kind, size, source, createdAt, boundAt, deletedAt, deletedBy, deletedWith) VALUES ('a1', 'f1', 'alice', 't1', 'd1', 'm1', 'photo.png', 'image/png', 'image', 4, 'telegram', 1, 2, 3, 'alice', 'file:f1'), ('a2', 'f2', 'alice', NULL, NULL, NULL, 'q3.md', 'text/plain', 'text', 4, 'web', 1, NULL, NULL, NULL, NULL)",
    );
    const before = db.prepare('SELECT * FROM media_attachments ORDER BY id').all();
    migrate(db, [dataSchema, mediaSchema]);
    expect(db.prepare('SELECT * FROM media_attachments ORDER BY id').all()).toEqual(before);
    const insert = db.prepare(
        "INSERT INTO media_attachments (id, fileId, ownerUserId, threadId, dotId, name, mediaType, kind, size, source, createdAt, boundAt) VALUES (?, 'f3', 'alice', 't1', 'd1', 'screenshot.jpg', 'image/jpeg', 'image', 4, ?, 1, 1)",
    );
    insert.run('a3', 'tool');
    expect(() => insert.run('a4', 'robot')).toThrow();
    expect(
        db
            .prepare(
                "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='media_attachments' AND sql IS NOT NULL ORDER BY name",
            )
            .all()
            .map((row) => (row as { name: string }).name),
    ).toEqual([
        'media_attachments_file',
        'media_attachments_owner',
        'media_attachments_pending',
        'media_attachments_thread',
    ]);
});

it('finds a file’s kept versions by index, not by scanning the files (data 5)', () => {
    const db = new DatabaseSync(':memory:');
    cleanup.push(() => db.close());
    migrate(db, [{ ...dataSchema, migrations: dataSchema.migrations!.slice(0, 4) }]);
    const file = db.prepare(
        "INSERT INTO data_files (id, ownerUserId, path, size, storedSize, mediaType, createdAt, updatedAt, deletedAt, deletedWith) VALUES (?, 'alice', ?, 4, 36, 'text/plain', 1, ?, ?, ?)",
    );
    for (let index = 0; index < 50; index++) {
        file.run(`f${index}`, `notes/${index}.txt`, index, null, null);
    }
    file.run('v1', 'notes/1.txt', 0, 5, 'file:f1');
    file.run('v2', 'notes/1.txt', 0, 6, 'file:f1');
    const before = db.prepare('SELECT * FROM data_files ORDER BY id').all();
    migrate(db, [dataSchema]);
    expect(db.prepare('SELECT * FROM data_files ORDER BY id').all()).toEqual(before);
    // withDeletedVersions' query (dataspace/space.ts).
    const query = 'SELECT * FROM data_files WHERE deletedWith=? ORDER BY updatedAt, deletedAt';
    const plan = (
        db.prepare(`EXPLAIN QUERY PLAN ${query}`).all('file:f1') as Array<{
            detail: string;
        }>
    ).map((row) => row.detail);
    expect(plan[0]).toBe('SEARCH data_files USING INDEX data_files_versions (deletedWith=?)');
    expect(plan.join(' ')).not.toMatch(/SCAN data_files/);
    expect(
        db
            .prepare(query)
            .all('file:f1')
            .map((row) => row.id),
    ).toEqual(['v1', 'v2']);
});

it('lists an owner’s conversations by index, not by scanning everyone’s (workspace 7)', () => {
    const db = new DatabaseSync(':memory:');
    cleanup.push(() => db.close());
    migrate(db, [{ ...workspaceSchema, migrations: workspaceSchema.migrations!.slice(0, 6) }]);
    const thread = db.prepare(
        "INSERT INTO thread_bindings (id, dotId, ownerId, title, createdAt) VALUES (?, 'd1', ?, 'Chat', ?)",
    );
    for (let index = 0; index < 40; index++) {
        thread.run(`t${index}`, index % 4 ? 'bob' : 'alice', index);
    }
    const before = db.prepare('SELECT * FROM thread_bindings ORDER BY id').all();
    migrate(db, [workspaceSchema]);
    // Rows are kept as they were; workspace 8 adds the (empty) archive
    // stamps, workspace 16 (CB-207) the kind, all private, and no creator.
    expect(db.prepare('SELECT * FROM thread_bindings ORDER BY id').all()).toEqual(
        before.map((row) => ({
            ...row,
            archivedAt: null,
            archivedBy: null,
            kind: 'private',
            createdBy: null,
            convertedAt: null,
        })),
    );
    // WorkspaceStore.conversations' query (workspace.ts).
    const query = `SELECT * FROM thread_bindings WHERE (ownerId=? OR id IN (SELECT value FROM json_each(?))) AND kind = 'private' AND deletedAt IS NULL AND archivedAt IS NULL ORDER BY createdAt DESC`;
    const plan = (
        db.prepare(`EXPLAIN QUERY PLAN ${query}`).all('alice', '[]') as Array<{
            detail: string;
        }>
    ).map((row) => row.detail);
    expect(plan).toContain('SEARCH thread_bindings USING INDEX thread_bindings_owner (ownerId=?)');
    expect(plan).not.toContain('SCAN thread_bindings');
    expect(
        db
            .prepare(query)
            .all('alice', '["t1"]')
            .map((row) => row.id),
    ).toEqual(['t36', 't32', 't28', 't24', 't20', 't16', 't12', 't8', 't4', 't1', 't0']);
});

it('fills the search index from the live pages (pages 5)', () => {
    const db = new DatabaseSync(':memory:');
    cleanup.push(() => db.close());
    migrate(db, [workspaceSchema, { ...pagesSchema, migrations: pagesSchema.migrations!.slice(0, 4) }]);
    db.exec(`INSERT INTO pages (id, spaceId, title, content, revision, createdAt, updatedAt) VALUES
    ('live', 's1', 'Vendor plan', '# Plan\n\nThe **invoice** [run](https://x).', 1, 1, 1),
    ('second', 's2', 'Notes', '', 1, 2, 2);
    INSERT INTO pages (id, spaceId, title, content, revision, createdAt, updatedAt, deletedAt) VALUES
    ('gone', 's1', 'Deleted', 'invoice', 1, 3, 3, 9);`);
    migrate(db, [workspaceSchema, pagesSchema]);
    expect(
        db
            .prepare('SELECT pageId, title, body FROM page_search ORDER BY id')
            .all()
            .map((row) => ({ ...row })),
    ).toEqual([
        { pageId: 'live', title: 'Vendor plan', body: 'Plan The invoice run.' },
        { pageId: 'second', title: 'Notes', body: '' },
    ]);
    for (const table of ['page_search_fts', 'page_search_tri']) {
        db.prepare(`INSERT INTO ${table}(${table}, rank) VALUES ('integrity-check', 1)`).run();
    }
    expect(
        db
            .prepare('SELECT rowid FROM page_search_fts WHERE page_search_fts MATCH \'"invo"*\'')
            .all()
            .map((row) => row.rowid),
    ).toEqual([1]);
    // PRAGMA integrity_check doesn't see FTS5 drift; FTS5's own check does.
    db.exec("DROP TRIGGER page_search_au; UPDATE page_search SET body = 'changed behind the index' WHERE id = 1");
    expect(db.prepare('PRAGMA integrity_check').get()).toEqual({
        integrity_check: 'ok',
    });
    expect(() =>
        db.prepare("INSERT INTO page_search_fts(page_search_fts, rank) VALUES ('integrity-check', 1)").run(),
    ).toThrow();
});

it('adds page revisions without touching the pages (pages 6)', () => {
    const db = new DatabaseSync(':memory:');
    cleanup.push(() => db.close());
    migrate(db, [workspaceSchema, { ...pagesSchema, migrations: pagesSchema.migrations!.slice(0, 5) }]);
    db.exec(`INSERT INTO pages (id, spaceId, title, content, revision, createdAt, updatedAt) VALUES
    ('live', 's1', 'Plan', 'Old words', 4, 1, 2);
    INSERT INTO pages (id, spaceId, title, content, revision, createdAt, updatedAt, deletedAt) VALUES
    ('gone', 's1', 'Deleted', 'x', 1, 3, 3, 9);`);
    const before = db.prepare('SELECT * FROM pages ORDER BY id').all();
    const search = db.prepare('SELECT * FROM page_search ORDER BY id').all();
    migrate(db, [workspaceSchema, pagesUpTo(6)]);
    expect(
        db
            .prepare("SELECT version, name FROM schema_migrations WHERE module='pages' ORDER BY version DESC LIMIT 1")
            .get(),
    ).toEqual({ version: 6, name: 'page revisions' });
    expect(db.prepare('SELECT * FROM pages ORDER BY id').all()).toEqual(before);
    expect(db.prepare('SELECT * FROM page_search ORDER BY id').all()).toEqual(search);
    expect(db.prepare('SELECT COUNT(*) AS n FROM page_revisions').get()).toEqual({
        n: 0,
    });
    expect(revisionSchema(db)).toEqual([
        {
            name: 'page_revisions',
            sql: 'CREATE TABLE page_revisions(id INTEGER PRIMARY KEY, pageId TEXT NOT NULL, spaceId TEXT NOT NULL, revision INTEGER NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, authorId TEXT, createdAt INTEGER NOT NULL, replacedAt INTEGER NOT NULL)',
        },
        REVISION_INDEX,
    ]);
});

/** The pages schema up to `version`, as an older build had it. */
const pagesUpTo = (version: number) => ({
    ...pagesSchema,
    migrations: pagesSchema.migrations!.filter((migration) => migration.version <= version),
});
const revisionSchema = (db: DatabaseSync) =>
    db
        .prepare(
            "SELECT name, sql FROM sqlite_master WHERE tbl_name='page_revisions' AND sql IS NOT NULL ORDER BY type DESC, name",
        )
        .all()
        .map((row) => ({ ...row }));
const REVISION_INDEX = {
    name: 'page_revisions_page',
    sql: 'CREATE INDEX page_revisions_page ON page_revisions(pageId, replacedAt)',
};
/** Markdown like a seeded 4 kB page: compresses well. */
const LONG_BODY = Array.from(
    { length: 80 },
    (_, n) => `## Section ${n}\n\nThe vendor budget review for quarter ${n % 4} and the zephyrine plan.`,
)
    .join('\n\n')
    .slice(0, 4000);

it('compresses every kept revision body, keeping every row and column (pages 7)', async () => {
    const db = new DatabaseSync(':memory:');
    cleanup.push(() => db.close());
    migrate(db, [workspaceSchema, pagesUpTo(6)]);
    db.exec(`INSERT INTO pages (id, spaceId, title, content, revision, createdAt, updatedAt) VALUES
    ('live', 's1', 'Plan', 'Now', 5, 1, 2);
    INSERT INTO pages (id, spaceId, title, content, revision, createdAt, updatedAt, deletedAt) VALUES
    ('gone', 's1', 'Deleted', 'x', 2, 3, 3, 9);`);
    // Rows as migration 6's store wrote them: a long body, a tiny one, an
    // empty one, one with characters outside ASCII, an unknown author, and
    // a revision of a deleted page.
    const insert = db.prepare(
        'INSERT INTO page_revisions(id, pageId, spaceId, revision, title, body, authorId, createdAt, replacedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    insert.run(3, 'live', 's1', 1, 'Plan', LONG_BODY, 'u1', 1, 5);
    insert.run(7, 'live', 's1', 2, 'Plan', 'a', 'dot:d1', 5, 6);
    insert.run(8, 'live', 's1', 3, 'Plan v0', '', null, 6, 7);
    insert.run(9, 'live', 's1', 4, 'Café', 'Naïve — 東京 🙂\r\n', 'u2', 7, 8);
    insert.run(12, 'gone', 's1', 1, 'Deleted', `${LONG_BODY} gone`, 'u1', 3, 4);
    const v6 = db
        .prepare('SELECT * FROM page_revisions ORDER BY id')
        .all()
        .map((row) => ({ ...row }));
    const pages = db.prepare('SELECT * FROM pages ORDER BY id').all();
    const search = db.prepare('SELECT * FROM page_search ORDER BY id').all();

    migrate(db, [workspaceSchema, pagesSchema]);
    expect(
        db
            .prepare("SELECT version, name FROM schema_migrations WHERE module='pages' ORDER BY version DESC LIMIT 1")
            .get(),
        // Later additive steps preserve migration 7's compression guarantees.
    ).toEqual({ version: 13, name: 'page source attribution' });
    expect(revisionSchema(db)).toEqual([
        {
            name: 'page_revisions',
            sql: 'CREATE TABLE page_revisions(id INTEGER PRIMARY KEY, pageId TEXT NOT NULL, spaceId TEXT NOT NULL, revision INTEGER NOT NULL, title TEXT NOT NULL, body BLOB NOT NULL, encoding TEXT NOT NULL, authorId TEXT, createdAt INTEGER NOT NULL, replacedAt INTEGER NOT NULL)',
        },
        REVISION_INDEX,
    ]);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%_v6'").all()).toEqual([]);
    expect(db.prepare('PRAGMA integrity_check').get()).toEqual({
        integrity_check: 'ok',
    });
    // Pages gain only an empty cover (pages migration 10) and source
    // attribution columns (pages migration 13, CB-328).
    expect(db.prepare('SELECT * FROM pages ORDER BY id').all()).toEqual(
        pages.map((row) => ({ ...row, coverId: null, sourceUrl: null, sourceTitle: null })),
    );
    expect(db.prepare('SELECT * FROM page_search ORDER BY id').all()).toEqual(search);
    // Every row and column but the body as it was; bodies stored as bytes,
    // Brotli where that is smaller.
    const stored = db
        .prepare('SELECT *, typeof(body) AS type, length(body) AS size FROM page_revisions ORDER BY id')
        .all()
        .map((row) => ({ ...row }));
    expect(stored.map(({ body: _body, encoding: _encoding, type: _t, size: _s, ...row }) => row)).toEqual(
        v6.map(({ body: _body, ...row }) => row),
    );
    expect(stored.map(({ id, encoding, type }) => [id, encoding, type])).toEqual([
        [3, 'br', 'blob'],
        [7, 'utf8', 'blob'],
        [8, 'utf8', 'blob'],
        [9, 'utf8', 'blob'],
        [12, 'br', 'blob'],
    ]);
    expect(Number(stored[0].size)).toBeLessThan(LONG_BODY.length / 3);
    expect(
        db.prepare("SELECT COUNT(*) AS n FROM page_revisions WHERE CAST(body AS TEXT) LIKE '%zephyrine%'").get(),
    ).toEqual({ n: 0 });
    // The store reads each back exactly as migration 6 kept it.
    const store = new Pages(db, () => true);
    const plain = (pageId: string) =>
        v6.filter((row) => row.pageId === pageId).sort((a, b) => Number(b.replacedAt) - Number(a.replacedAt));
    expect(store.revisionsOf('live')).toEqual(plain('live'));
    expect(store.revisionsOf('gone')).toEqual(plain('gone'));
    // Its next edit writes a compressed revision, found by the index.
    await store.update('s1', 'live', { expectedRevision: 5, content: LONG_BODY }, { by: 'u1', now: 10 });
    await store.update('s1', 'live', { expectedRevision: 6, content: 'Short' }, { by: 'u2', now: 11 });
    expect(store.revisionsOf('live').slice(0, 2)).toMatchObject([
        { id: 14, revision: 6, body: LONG_BODY, authorId: 'u2', replacedAt: 11 },
        { id: 13, revision: 5, body: 'Now', authorId: 'u1', replacedAt: 10 },
    ]);
    expect(
        db
            .prepare('SELECT id, encoding FROM page_revisions WHERE id > 12')
            .all()
            .map((row) => ({ ...row })),
    ).toEqual([
        { id: 13, encoding: 'utf8' },
        { id: 14, encoding: 'br' },
    ]);
    const plan = db
        .prepare(
            'EXPLAIN QUERY PLAN SELECT authorId, replacedAt FROM page_revisions WHERE pageId=? ORDER BY replacedAt DESC, id DESC LIMIT 1',
        )
        .all('live')
        .map((row) => String(row.detail));
    expect(plan[0]).toMatch(/^SEARCH page_revisions USING INDEX page_revisions_page \(pageId=\?\)$/);
});

it('compresses the revisions of a release-1 database migrated to pages 6, matching a fresh schema (pages 7)', () => {
    const dir = scratch();
    const prod = join(dir, 'prod.sqlite');
    const fresh = join(dir, 'fresh.sqlite');
    buildRelease1Database(prod);
    const atSix = schemas.map((set) => (set.id === 'pages' ? pagesUpTo(6) : set));
    boot(prod, join(dir, 'backups'), atSix);
    const db = open(prod);
    // Two edits of release 1's page as migration 6's store kept them.
    db.prepare(
        'INSERT INTO page_revisions(pageId, spaceId, revision, title, body, authorId, createdAt, replacedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run('page-1', 'space-1', 1, 'Notes', '# Notes', 'alice', 1000, 2000);
    db.prepare(
        'INSERT INTO page_revisions(pageId, spaceId, revision, title, body, authorId, createdAt, replacedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run('page-1', 'space-1', 2, 'Notes', LONG_BODY, 'bob', 2000, 3000);
    db.close();
    const before = rowsOf(open(prod));

    const steps = boot(prod, join(dir, 'backups')).steps;
    expect(steps).toEqual([
        {
            module: 'pages',
            version: 7,
            name: 'compressed page revisions',
            action: 'apply',
        },
        {
            module: 'pages',
            version: 8,
            name: 'live page keys',
            action: 'apply',
        },
        {
            module: 'pages',
            version: 9,
            name: 'page use retention index',
            action: 'apply',
        },
        {
            module: 'pages',
            version: 10,
            name: 'page covers',
            action: 'apply',
        },
        {
            module: 'pages',
            version: 11,
            name: 'page tags',
            action: 'apply',
        },
        {
            module: 'pages',
            version: 12,
            name: 'page links',
            action: 'apply',
        },
        {
            module: 'pages',
            version: 13,
            name: 'page source attribution',
            action: 'apply',
        },
    ]);
    boot(fresh, join(dir, 'fresh-backups'));
    const prodDb = open(prod);
    expect(schemaOf(prodDb)).toEqual(schemaOf(open(fresh)));
    // Every other table's rows as they were.
    const after = rowsOf(prodDb);
    expect({ ...after, page_revisions: [] }).toEqual({
        ...before,
        // Pages gain only an empty cover (pages migration 10) and source
        // attribution columns (pages migration 13, CB-328).
        pages: before.pages.map((row) => ({ ...row, coverId: null, sourceUrl: null, sourceTitle: null })),
        page_revisions: [],
        // CB-328: page knowledge graph tables (pages migrations 11 and 12),
        // new and empty.
        page_links: [],
        page_tags: [],
    });
    expect(
        new Pages(prodDb, () => true)
            .revisionsOf('page-1')
            .map(({ body, authorId, revision }) => [revision, authorId, body]),
    ).toEqual([
        [2, 'bob', LONG_BODY],
        [1, 'alice', '# Notes'],
    ]);
});

it('adds the page-use retention index without changing data and matches the current fresh schema (pages 9)', () => {
    const upgraded = new DatabaseSync(':memory:');
    const fresh = new DatabaseSync(':memory:');
    cleanup.push(
        () => upgraded.close(),
        () => fresh.close(),
    );
    migrate(upgraded, [workspaceSchema, pagesUpTo(8)]);
    upgraded.exec(`INSERT INTO page_use_days(pageId, userId, day) VALUES
    ('page-1', 'alice', 1), ('page-1', 'bob', 2), ('page-2', 'alice', 3);`);
    const before = rowsOf(upgraded);
    expect(migrate(upgraded, [workspaceSchema, pagesUpTo(9)])).toEqual([
        {
            module: 'pages',
            version: 9,
            name: 'page use retention index',
            action: 'apply',
        },
    ]);
    expect(rowsOf(upgraded)).toEqual(before);
    expect(upgraded.prepare("SELECT sql FROM sqlite_master WHERE name='page_use_days_time'").get()).toEqual({
        sql: 'CREATE INDEX page_use_days_time ON page_use_days(day)',
    });
    expect(
        upgraded
            .prepare("PRAGMA index_info('page_use_days_time')")
            .all()
            .map((row) => row.name),
    ).toEqual(['day']);
    const plan = upgraded
        .prepare('EXPLAIN QUERY PLAN DELETE FROM page_use_days WHERE day < ?')
        .all(2)
        .map((row) => String(row.detail));
    expect(plan.some((line) => /SEARCH page_use_days USING INDEX page_use_days_time/.test(line))).toBe(true);
    migrate(fresh, [workspaceSchema, pagesUpTo(9)]);
    expect(schemaOf(upgraded)).toEqual(schemaOf(fresh));
    expect(upgraded.prepare('PRAGMA integrity_check').get()).toEqual({
        integrity_check: 'ok',
    });
    expect(migrate(upgraded, [workspaceSchema, pagesUpTo(9)])).toEqual([]);
});

it('orders the issue history by an explicit seq, which rows from an older build get too (issues 11)', () => {
    const db = new DatabaseSync(':memory:');
    cleanup.push(() => db.close());
    migrate(db, [{ ...issuesSchema, migrations: issuesSchema.migrations!.slice(0, 10) }]);
    const insert = db.prepare("INSERT INTO issue_events (id, issueId, kind, createdAt) VALUES (?, 'i1', 'created', 1)");
    for (const id of ['b', 'a', 'c']) {
        insert.run(id);
    }
    expect(migrate(db, [issuesSchema]).map((step) => step.version)).toEqual([11, 12, 13, 14, 15, 16]);
    const seqs = () =>
        db
            .prepare('SELECT id, seq FROM issue_events ORDER BY seq')
            .all()
            .map((row) => `${row.id}${row.seq}`);
    // Filled in the order the rows were written, not by id.
    expect(seqs()).toEqual(['b1', 'a2', 'c3']);
    // A build from before writes no seq: the trigger gives it the next one.
    insert.run('d');
    db.prepare(
        "INSERT INTO issue_events (id, issueId, kind, createdAt, seq) VALUES ('e', 'i1', 'created', 1, 9)",
    ).run();
    insert.run('f');
    expect(seqs()).toEqual(['b1', 'a2', 'c3', 'd4', 'e9', 'f10']);
    expect(() =>
        db
            .prepare("INSERT INTO issue_events (id, issueId, kind, createdAt, seq) VALUES ('g', 'i1', 'created', 1, 9)")
            .run(),
    ).toThrow(/UNIQUE/);
});

it('marks whom notes and markers were written for, older ones unknown (chat 8, CB-210)', () => {
    const db = new DatabaseSync(':memory:');
    cleanup.push(() => db.close());
    migrate(db, [
        {
            ...chatSchema,
            migrations: chatSchema.migrations!.filter((migration) => migration.version <= 7),
        },
    ]);
    db.prepare(
        "INSERT INTO chat_context_notes (threadId, turns, anchor, summary, pinned, names, updatedAt) VALUES ('t', 1, 'a', 'Older notes.', '[]', '[]', 1)",
    ).run();
    db.prepare(
        "INSERT INTO chat_time_markers (threadId, messageId, text, toldAt, sentAt) VALUES ('t', 'm', '[Date]', 1, 1)",
    ).run();
    expect(migrate(db, [chatSchema]).map((step) => step.version)).toEqual([8, 9]);
    // Rows from before say nothing: a shared chat never uses them as they are.
    expect({
        ...db.prepare('SELECT audience FROM chat_context_notes').get(),
    }).toEqual({ audience: null });
    expect({
        ...db.prepare('SELECT audience FROM chat_time_markers').get(),
    }).toEqual({ audience: null });
    db.exec("UPDATE chat_context_notes SET audience='shared'");
    expect(() => db.exec("UPDATE chat_time_markers SET audience='everyone'")).toThrow(/CHECK/);
});

it('rebuilds the queued messages for attachments, keeping their rows, order and index (chat 7, CB-223)', () => {
    const db = new DatabaseSync(':memory:');
    cleanup.push(() => db.close());
    migrate(db, [
        {
            ...chatSchema,
            migrations: chatSchema.migrations!.filter((migration) => migration.version <= 6),
        },
    ]);
    const queue = db.prepare(
        'INSERT INTO chat_steering (id, threadId, userId, text, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)',
    );
    queue.run('m1', 't1', 'alice', 'First.', 10, 10);
    queue.run('m2', 't1', 'alice', 'Second, same time.', 10, 11);
    queue.run('m3', 't2', 'bob', 'Elsewhere.', 5, 5);
    // A canceled one leaves a gap: the next number stays past it.
    queue.run('m4', 't1', 'alice', 'Cancelled.', 12, 12);
    db.exec("DELETE FROM chat_steering WHERE id='m4'");
    const before = db
        .prepare('SELECT * FROM chat_steering ORDER BY seq')
        .all()
        .map((row) => ({ ...row }));

    expect(
        migrate(db, [
            {
                ...chatSchema,
                migrations: chatSchema.migrations!.filter((migration) => migration.version <= 7),
            },
        ]).map((step) => step.version),
    ).toEqual([7]);
    // Every row, with its order, and no attachments.
    expect(
        db
            .prepare('SELECT seq, id, threadId, userId, text, createdAt, updatedAt FROM chat_steering ORDER BY seq')
            .all()
            .map((row) => ({ ...row })),
    ).toEqual(before);
    expect(db.prepare('SELECT COUNT(*) AS n FROM chat_steering WHERE attachments IS NULL').get()).toEqual({ n: 3 });
    // The index is back, on the table under its old name.
    expect(
        db
            .prepare(
                "SELECT name, tbl_name AS tableName FROM sqlite_master WHERE type='index' AND name='chat_steering_thread'",
            )
            .all()
            .map((row) => ({ ...row })),
    ).toEqual([{ name: 'chat_steering_thread', tableName: 'chat_steering' }]);
    expect(
        db
            .prepare("SELECT name FROM pragma_index_info('chat_steering_thread')")
            .all()
            .map((row) => row.name),
    ).toEqual(['threadId', 'userId', 'seq']);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='chat_steering_next'").all()).toEqual([]);
    // New rows number on after the old ones, the canceled one's too.
    queue.run('m5', 't1', 'alice', 'After.', 20, 20);
    expect(db.prepare("SELECT seq FROM chat_steering WHERE id='m5'").get()).toEqual({ seq: 5 });
    // Files alone are a message now; neither words nor files is not.
    const files = db.prepare(
        'INSERT INTO chat_steering (id, threadId, userId, text, attachments, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    files.run('m6', 't1', 'alice', '', '[{"id":"cbatt_x"}]', 21, 21);
    expect(() => files.run('m7', 't1', 'alice', '', null, 22, 22)).toThrow();
    expect(() => files.run('m8', 't1', 'alice', '', '[]', 22, 22)).toThrow();
    expect(() => files.run('m9', 't1', 'alice', 'x', 'not json', 22, 22)).toThrow();
});

it('requires a pre-upgrade database restore before the pre-provenance v0.15 build can boot the combined v0.16 schemas', () => {
    const dir = scratch(),
        path = join(dir, 'combined.sqlite'),
        backups = join(dir, 'backups');
    const ceilings: Record<string, number> = { operations: 2, apps: 4 };
    const prior = schemas.map((set) =>
        set.id in ceilings
            ? {
                  ...set,
                  migrations: set.migrations?.filter((m) => m.version <= ceilings[set.id]),
              }
            : set,
    );
    boot(path, backups, prior);
    const before = open(path);
    expect(planMigrations(before, prior, { strict: true })).toEqual([]);
    expect(
        before.prepare("SELECT count(*) AS n FROM channel_kv WHERE key LIKE 'telegram:ingress:v1:primed-at:%'").get(),
    ).toEqual({ n: 0 });
    before.close();
    const migrated = boot(path, backups);
    expect(migrated.steps.map((step) => [step.module, step.version])).toEqual(
        expect.arrayContaining([
            ['operations', 3],
            ['apps', 5],
        ]),
    );
    expect(migrated.backup).toBeDefined();
    const restorable = open(migrated.backup!);
    expect(planMigrations(restorable, prior, { strict: true })).toEqual([]);
    expect(
        restorable
            .prepare("SELECT count(*) AS n FROM channel_kv WHERE key LIKE 'telegram:ingress:v1:primed-at:%'")
            .get(),
    ).toEqual({ n: 0 });
    restorable.close();
    const after = open(path);
    expect(() => planMigrations(after, prior, { strict: true })).toThrow(
        /(?:operations migration 3|apps migration [5-8]).*knows only up to (?:2|4)/,
    );
    after.close();
    expect(() => boot(path, join(dir, 'old-build-backups'), prior)).toThrow(MigrationError);
    // These are the real strict startup planner/entry point, not a binary-version label.
    expect(readdirSync(dir)).not.toContain('old-build-backups');
});

it('preserves existing socio action provenance when admitting new history updates (issues 12)', () => {
    const db = new DatabaseSync(':memory:');
    cleanup.push(() => db.close());
    migrate(db, [{ ...issuesSchema, migrations: issuesSchema.migrations!.slice(0, 11) }]);
    db.prepare(
        "INSERT INTO issue_dot_actions(id,issueId,action,targetId,dotId,dotOwnerId,userId,trigger,causeId,threadId,createdAt) VALUES('existing','issue','comment','comment','dot',NULL,'alice','scheduled','task','private-thread',10)",
    ).run();
    const before = db.prepare('SELECT * FROM issue_dot_actions').all();
    expect(migrate(db, [issuesSchema]).map((step) => step.version)).toEqual([12, 13, 14, 15, 16]);
    expect(db.prepare('SELECT * FROM issue_dot_actions').all()).toEqual(before);
    expect(db.prepare("SELECT COUNT(*) n FROM issue_dot_actions WHERE action='update'").get()?.n).toBe(0);
    expect(() =>
        db
            .prepare(
                "INSERT INTO issue_dot_actions(id,issueId,action,targetId,dotId,userId,trigger,causeId,createdAt) VALUES('missing-target','issue','update',NULL,'dot','alice','goal','goal',20)",
            )
            .run(),
    ).toThrow();
    expect(() =>
        db
            .prepare(
                "INSERT INTO issue_dot_actions(id,issueId,action,targetId,dotId,userId,trigger,causeId,createdAt) VALUES('missing-cause','issue','update','event','dot','alice','goal',NULL,20)",
            )
            .run(),
    ).toThrow();
    expect(() =>
        db
            .prepare(
                "INSERT INTO issue_dot_actions(id,issueId,action,targetId,dotId,userId,trigger,causeId,threadId,createdAt) VALUES('new-event','issue','update','event','dot','alice','goal','goal','private-source',20)",
            )
            .run(),
    ).not.toThrow();
});

it('adds empty future-only issue subscription tables without touching prior history and requires pre-upgrade restore to downgrade (issues13)', () => {
    const db = new DatabaseSync(':memory:');
    cleanup.push(() => db.close());
    const previous = {
        ...issuesSchema,
        migrations: issuesSchema.migrations!.filter((m) => m.version <= 12),
    };
    migrate(db, [previous]);
    db.prepare(
        "INSERT INTO issue_events(id,issueId,actorId,kind,fromValue,toValue,createdAt) VALUES('old','issue','actor','status','open','done',123)",
    ).run();
    const history = db.prepare('SELECT * FROM issue_events').all();
    expect(migrate(db, [issuesSchema]).map((m) => m.version)).toEqual([13, 14, 15, 16]);
    expect(db.prepare('SELECT * FROM issue_events').all()).toEqual(history);
    for (const table of ['issue_watches', 'issue_watch_members', 'issue_watch_outbox']) {
        expect(db.prepare('SELECT COUNT(*) n FROM ' + table).get()?.n).toBe(0);
    }
    // Its newest: issues 14 (CB-194), 15 (CB-274) and 16 (CB-442) came after.
    expect(() => planMigrations(db, [previous])).toThrow(/issues migration 16/);
});

it('adds grounding refs, issue run links and the data audit’s chat, keeping every row (runs 5, issues 14, data 10)', () => {
    const db = new DatabaseSync(':memory:');
    cleanup.push(() => db.close());
    const before = (set: typeof runsSchema, version: number) => ({
        ...set,
        migrations: set.migrations!.filter((m) => m.version < version),
    });
    migrate(db, [before(runsSchema, 5), before(issuesSchema, 14), before(dataSchema, 10)]);
    db.exec(
        `INSERT INTO agent_runs (threadId, runId, status, events, startedAt) VALUES ('t1', 'r1', 'failed', '[]', 1);
    INSERT INTO data_audit (id, ownerUserId, actorKind, actorId, dotId, datasetId, target, action, outcome, detail, createdAt) VALUES ('a1', 'alice', 'dot', 'd1', 'd1', 'ds1', 'Prices', 'query', 'ok', NULL, 1);`,
    );
    const runs = db.prepare('SELECT * FROM agent_runs').all();
    expect(
        migrate(db, [runsSchema, issuesSchema, dataSchema]).map(
            (step) => `${step.module} ${step.version} ${step.name}`,
        ),
    ).toEqual([
        'runs 5 run refs',
        'issues 14 issue runs',
        'issues 15 related issue links',
        'issues 16 issue components',
        'data 10 audit chat',
        'data 11 dataset history retention',
        'data 12 dataset analytical bytes',
        'data 13 plugin dataset bindings',
        'data 14 plugin data budgets',
        'data 15 datasets in Spaces',
        'data 16 field settings',
        'data 17 data api tokens',
    ]);
    expect(db.prepare('SELECT * FROM agent_runs').all()).toEqual(runs);
    // Older audit rows have no chat.
    expect(db.prepare("SELECT threadId FROM data_audit WHERE id = 'a1'").get()).toEqual({ threadId: null });
    // Both new tables start empty and refuse what they can't hold.
    for (const table of ['run_refs', 'issue_runs']) {
        expect(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({
            n: 0,
        });
    }
    const ref = db.prepare(
        'INSERT INTO run_refs (runId, threadId, kind, spaceId, refId, at) VALUES (?, ?, ?, ?, ?, 1)',
    );
    ref.run('r1', 't1', 'page', 's1', 'p1');
    expect(() => ref.run('r1', 't1', 'page', 's1', 'p1')).toThrow(/UNIQUE/);
    expect(() => ref.run('r1', 't1', 'content', null, 'p1')).toThrow(/CHECK/);
    expect(() => ref.run('r1', 't1', 'page', null, 'x'.repeat(201))).toThrow(/CHECK/);
    const link = db.prepare(
        "INSERT INTO issue_runs (issueId, runId, threadId, via, linkedBy, createdAt) VALUES ('i1', 'r1', 't1', ?, 'alice', 1)",
    );
    link.run('report');
    expect(() => link.run('report')).toThrow(/UNIQUE|PRIMARY/);
    expect(() =>
        db
            .prepare(
                "INSERT INTO issue_runs (issueId, runId, threadId, via, linkedBy, createdAt) VALUES ('i2', 'r1', 't1', 'email', 'alice', 1)",
            )
            .run(),
    ).toThrow(/CHECK/);
});
