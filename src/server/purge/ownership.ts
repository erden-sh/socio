// What a transfer of ownership (CB-360) does with each column that names a
// person: the transfer's view of references.ts. Socio is a B2B app: the
// company owns what its people make, so an admin can hand all of it to
// another active person. What is a person's own (how they sign in, their
// secrets, their choices, their reading and their notices) stays theirs;
// a deactivation already ends what acts for them. Attribution (who made,
// decided or did something) is history, and never changes.
//
// tests/ownership.test.ts holds every `users` and `owners` reference of
// REFERENCES to a decision here: a column whose purge decision is
// `history` is history unless listed; any other must be listed. A new
// table that names a person can't ship without one.
import type { AssetKind } from '@socio/shared/auth';

export type Ownership =
    /** Moved to the new owner with `kind` (`auth/accounts.ts`'s `assetTransfers`). */
    | { as: 'transferred'; kind: AssetKind; why?: string }
    /** Stays the person's: it is theirs, or ends with them (a deactivation ends it). */
    | { as: 'personal'; why: string }
    /** Attribution or audit: untouched. */
    | { as: 'history'; why?: string };

const moved = (kind: AssetKind, why?: string): Ownership => ({ as: 'transferred', kind, ...(why ? { why } : {}) });
const personal = (why: string): Ownership => ({ as: 'personal', why });
const history = (why: string): Ownership => ({ as: 'history', why });

/** By `table.column`. */
export const OWNERSHIP: Record<string, Ownership> = {
    // ---- what moves -----------------------------------------------------------
    'apps.ownerUserId': moved('apps', 'its bundles and datasets are in the data space: `apps` moves `data` too'),
    'tasks.userId': moved('schedules', 'paused ones stay paused; the new owner resumes them'),
    'jobs.userId': moved('schedules', 'a live job whose name the new owner uses for that socio is renamed'),
    'goals.userId': moved('schedules', 'a goal is a schedule with its conversation'),
    'dots.ownerId': moved('socios', 'a personal socio the new owner has a namesake of is renamed'),
    'space_members.userId': moved('spaces', 'where the new owner is a member already, the higher role stays'),
    'data_datasets.ownerUserId': moved('data', 'private scratch areas too; the dataset files move with them'),
    'data_files.ownerUserId': moved('data', 'deleted versions too; the sealed bytes move to the new owner’s keys'),
    'data_grants.ownerUserId': moved('data', 'grants to socios on what moves; a duplicate keeps the wider access'),
    'media_attachments.ownerUserId': moved('data', 'they name a file of the data space'),
    'media_folders.ownerUserId': moved('data', 'library folders; one the new owner has is kept once'),
    'media_embeds.ownerUserId': moved('data', 'they name a file of the data space'),
    'thread_bindings.ownerId': moved('conversations', 'their own conversations, never rooms'),
    'context_threads.userId': moved('conversations', 'follows its conversation; dropped on a clash'),
    'page_threads.userId': moved('conversations', 'follows its conversation; dropped on a clash'),
    'learning_evidence.ownerId': moved('conversations', 'names its conversation’s owner'),
    'memory_episodes.userId': moved('conversations', 'a summary of one conversation, which it follows'),
    'memories.userId': moved('memories', 'they arrive as proposals: true of one person is not of another'),

    // ---- the person's own: stays theirs, or ends with them ----------------------
    'auth_user.appUserId': personal('their sign-in account'),
    'agent_grants.userId': personal('agents they connected act as them; a deactivation ends them'),
    'service_accounts.userId': personal('a service account’s own user, not a person'),
    'service_keys.userId': personal('a service account’s key'),
    'user_preferences.userId': personal('their preferences'),
    'user_profiles.userId': personal('what socios know about them'),
    'user_inference_connections.userId': personal('their own subscription logins: secrets, never handed over'),
    'time_zone_notes.userId': personal('where they are'),
    'flag_choices.userId': personal('their feature choices'),
    'release_seen.userId': personal('what they have read'),
    'release_views.userId': personal('what they have read'),
    'plugin_access_generation.userId': personal('their plugin sign-ins'),
    'plugin_codes.userId': personal('their plugin sign-ins'),
    'plugin_sessions.userId': personal('their plugin sign-ins'),
    'plugin_release_seen.userId': personal('what they have read'),
    'app_launch_codes.userId': personal('their mini app sign-ins: having an app open is not owning it'),
    'app_sessions.userId': personal('their mini app sign-ins: having an app open is not owning it'),
    'telegram_link_codes.userId': personal('their Telegram'),
    'telegram_links.userId': personal('their Telegram'),
    'telegram_members.userId': personal('their Telegram'),
    'telegram_room_codes.userId': personal('their Telegram'),
    'notification_images.userId': personal('notices to them'),
    'notification_in_app.userId': personal('notices to them'),
    'notification_push_subscriptions.userId': personal('their devices'),
    'notifications.userId': personal('notices to them'),
    'approval_guidance.userId': personal('their own guidance for approvals'),
    'approval_policies.userId': personal('their own approval choices'),
    'approval_requests.userId': personal('waiting for their answer; nobody answers for them'),
    'approval_notes.userId': personal('their notes on approvals'),
    'mcp_connections.userId': personal('their logins to MCP servers hold their secrets; a deactivation ends them'),
    'mcp_grants.userId': personal('grants of their MCP connections'),
    'mcp_oauth_attempts.userId': personal('their MCP logins in progress'),
    'mcp_calls.userId': personal('calls through their MCP connections'),
    'issue_watches.userId': personal('what they follow on the board'),
    'issue_watch_outbox.userId': personal('notices to them'),
    'issue_votes.userId': personal('their votes'),
    'dot_request_notices.userId': personal('notices to them'),
    'dot_request_requesters.userId': personal('their requests for a socio'),
    'ask_preferences.userId': personal('their preferences'),
    'chat_steering.userId': personal('their messages waiting for a turn'),
    'message_reactions.userId': personal('their reactions'),
    'page_use_days.userId': personal('their reading'),
    'socio_grants.personId': personal('access they delegated to socios; a deactivation ends it'),
    'actor_contexts.personId': personal('a socio acting for them'),
    'gateway_reservations.personId': personal('their budget held for a call in flight'),
    'coding_sessions.personId': personal('a coding sandbox in their name: end it in the app'),
    'coding_thread_events.personId': personal('their coding requests'),
    'coding_thread_events.requesterId': personal('their coding requests'),
    'gateway_extractions.personId': personal('a file made for them; it expires'),
    'room_members.userId': personal('rooms are nobody’s: their place in one is theirs'),
    'room_mentions.userId': personal('mentions of them'),
    'room_notices.userId': personal('notices to them'),
    'room_notify_settings.userId': personal('their room notices'),
    'room_read_state.userId': personal('their reading'),

    // ---- attribution whose purge decision is `owns` -----------------------------
    'job_runs.userId': history('who a run ran for'),
    'job_long_runs.userId': history('who a long run runs for; one in progress finishes as it started'),
};
