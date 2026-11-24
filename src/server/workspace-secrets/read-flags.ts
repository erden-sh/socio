import { randomUUID } from 'node:crypto';

import {
    FLAG_LOOKBACK_MS,
    parseWorkloadKey,
    REVOKE_GRACE_MS,
    REVOKED_READS_MIN,
    SPIKE_BASELINE_MS,
    SPIKE_FACTOR,
    SPIKE_MIN_HISTORY_MS,
    SPIKE_MIN_READS,
    SPIKE_RECENT_MS,
    STALE_IDENTITY_GRACE_MS,
    STALE_IDENTITY_MIN,
    type SecretFlagRule,
} from '@socio/shared/workspace-secrets';

import type { SecretAuditLines, StoredFlag } from './infra/sqlite/audit-lines.js';

/** What a rule found: one per (rule, workload, secret, cause), never a value. */
export interface Finding {
    rule: SecretFlagRule;
    dedupKey: string;
    /** The workload's key: an app id, or `plugin:<id>`. */
    workload: string;
    secretId: string | null;
    explanation: string;
    lastSeenAt: number;
}

export interface ReadFlagDeps {
    lines: SecretAuditLines;
    write<T>(label: string, fn: () => T): Promise<T>;
    workloadName(key: string): string;
    secretName(id: string): string;
    /** Every active admin, from the app (`AdminNotices.notifyAdmins`). */
    notifyAdmins?(notice: { trigger: string; title: string; message: string; path: string }): Promise<unknown>;
}

/** The marker a read's audit line carries when made with a stale plugin identity. */
export const STALE_MARK = /identity v(\d+) stale \(current (v\d+|none)\)/;

/** An audit actor (`app:<id>`, `plugin:<id>`) as a workload key, or undefined for people and Socio. */
export function workloadOfActor(actor: string): string | undefined {
    if (actor.startsWith('app:')) {
        return actor.slice(4);
    }
    if (actor.startsWith('plugin:')) {
        return actor;
    }
    return undefined;
}
const labelOf = (key: string) => {
    const ref = parseWorkloadKey(key);
    return `${ref.kind}=${ref.id}`;
};
const minute = (at: number) => `${new Date(at).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
const times = (n: number) => (n === 1 ? 'once' : `${n} times`);

/**
 * Socio Secrets: read-anomaly flags for admins. Each rule reads the secrets'
 * audit lines, is conservative, and explains itself with its numbers; none
 * ever sees a value. A finding is one flag while open (`dedupKey`): running
 * again refreshes it, never repeats it or its notification. Once an admin
 * dismisses it, only evidence newer than the dismissal raises it again.
 */
export class SecretReadFlags {
    constructor(private deps: ReadFlagDeps) {}

    /** Evidence counts from here: the window's start, or just after the key's last dismissal. */
    private floor(dedupKey: string, windowStart: number) {
        const dismissed = this.deps.lines.lastDismissed(dedupKey);
        return dismissed === null ? windowStart : Math.max(windowStart, dismissed + 1);
    }

    /** `read-spike`: far more reads in the last hour than the workload's own hourly average the week before. */
    spikes(now: number): Finding[] {
        const { lines } = this.deps;
        const recentFrom = now - SPIKE_RECENT_MS;
        const found: Finding[] = [];
        for (const actor of lines.readersSince(recentFrom)) {
            const workload = workloadOfActor(actor);
            if (!workload) {
                continue;
            }
            const dedupKey = `read-spike|${actor}`;
            const recent = lines.readsBetween(actor, this.floor(dedupKey, recentFrom), now + 1);
            if (recent.count < SPIKE_MIN_READS || !lines.readBefore(actor, recentFrom - SPIKE_MIN_HISTORY_MS)) {
                continue;
            }
            const baseline = lines.readsBetween(actor, recentFrom - SPIKE_BASELINE_MS, recentFrom).count;
            const hourly = baseline / (SPIKE_BASELINE_MS / SPIKE_RECENT_MS);
            if (recent.count < SPIKE_FACTOR * hourly) {
                continue;
            }
            const ratio = hourly > 0 ? ` (${Math.round(recent.count / hourly)}×)` : '';
            found.push({
                rule: 'read-spike',
                dedupKey,
                workload,
                secretId: null,
                explanation: `${this.deps.workloadName(workload)} read its secrets ${recent.count} times in the last hour; its hourly average over the week before was ${hourly.toFixed(1)}${ratio}. Flagged at ${SPIKE_MIN_READS} reads or more and ${SPIKE_FACTOR}× its own average.`,
                lastSeenAt: recent.lastAt ?? now,
            });
        }
        return found;
    }

    /** `read-after-revoke`: refused attempts to read a secret after an admin revoked the workload's grant. */
    revoked(now: number): Finding[] {
        const { lines } = this.deps;
        const since = now - FLAG_LOOKBACK_MS;
        const found: Finding[] = [];
        for (const { secretId, actor } of lines.refusedSince(since)) {
            const workload = workloadOfActor(actor);
            if (!workload) {
                continue;
            }
            const label = labelOf(workload);
            const revoke = lines.latestEndingWith(secretId, 'revoke', `grant to ${label} revoked`);
            if (!revoke) {
                continue;
            }
            const regrant = lines.latestEndingWith(secretId, 'grant', `granted to ${label}`);
            if (regrant && regrant.id > revoke.id) {
                continue;
            }
            const dedupKey = `read-after-revoke|${secretId}|${actor}|${revoke.id}`;
            const from = Math.max(this.floor(dedupKey, since), revoke.createdAt + REVOKE_GRACE_MS);
            const refused = lines.refusalsSince(secretId, actor, from);
            if (refused.count < REVOKED_READS_MIN) {
                continue;
            }
            found.push({
                rule: 'read-after-revoke',
                dedupKey,
                workload,
                secretId,
                explanation: `${this.deps.workloadName(workload)} tried to read ${this.deps.secretName(secretId)} ${times(refused.count)} after its grant was revoked (${minute(revoke.createdAt)}); each attempt was refused. Flagged at ${REVOKED_READS_MIN} refused attempts or more, starting ${REVOKE_GRACE_MS / 60_000} minutes after the revoke, in the last ${FLAG_LOOKBACK_MS / 3_600_000} hours. It may still need the secret, or something retries with an old setup.`,
                lastSeenAt: refused.lastAt ?? now,
            });
        }
        return found;
    }

    /** `stale-identity`: a plugin read, or tried to, with an identity version older than its current one. */
    stale(now: number): Finding[] {
        const { lines } = this.deps;
        const since = now - FLAG_LOOKBACK_MS;
        const found: Finding[] = [];
        for (const actor of lines.staleReadersSince(since)) {
            const workload = workloadOfActor(actor);
            const first = lines.staleUsesSince(actor, since);
            const mark = first.last && STALE_MARK.exec(first.last.detail);
            if (!workload || !mark) {
                continue;
            }
            const dedupKey = `stale-identity|${actor}|v${mark[1]}`;
            const uses = lines.staleUsesSince(actor, this.floor(dedupKey, since));
            if (uses.count < STALE_IDENTITY_MIN) {
                continue;
            }
            const current =
                mark[2] === 'none' ? 'it has no current identity' : `version ${mark[2].slice(1)} was issued`;
            found.push({
                rule: 'stale-identity',
                dedupKey,
                workload,
                secretId: null,
                explanation: `${this.deps.workloadName(workload)} used identity version ${mark[1]} ${times(uses.count)} in the last ${FLAG_LOOKBACK_MS / 3_600_000} hours after ${current}, more than ${STALE_IDENTITY_GRACE_MS / 60_000} minutes on, when its rolling update should be over. An old task may still be running, or the old token was copied: rotate its identity if this is unexpected.`,
                lastSeenAt: uses.last?.createdAt ?? now,
            });
        }
        return found;
    }

    /**
     * Runs every rule: a new finding is a new open flag, and the admins hear
     * about the new ones in one notification; an open one is refreshed.
     * Returns the flags it opened.
     */
    async evaluate(now: number): Promise<StoredFlag[]> {
        const findings = [...this.spikes(now), ...this.revoked(now), ...this.stale(now)];
        const opened = await this.deps.write('workspace secret read flags', () => {
            const created: StoredFlag[] = [];
            for (const finding of findings) {
                const open = this.deps.lines.openFlag(finding.dedupKey);
                if (open) {
                    this.deps.lines.refreshFlag(open.id, finding.explanation, finding.lastSeenAt);
                    continue;
                }
                const ref = parseWorkloadKey(finding.workload);
                const row: StoredFlag = {
                    id: randomUUID(),
                    rule: finding.rule,
                    dedupKey: finding.dedupKey,
                    workloadKind: ref.kind,
                    workloadId: ref.id,
                    secretId: finding.secretId,
                    explanation: finding.explanation,
                    firstSeenAt: now,
                    lastSeenAt: finding.lastSeenAt,
                    notifiedAt: null,
                    dismissedAt: null,
                    dismissedBy: null,
                };
                this.deps.lines.insertFlag(row);
                created.push(row);
            }
            return created;
        });
        if (opened.length && this.deps.notifyAdmins) {
            const more = opened.length > 1 ? ` (and ${opened.length - 1} more)` : '';
            await this.deps
                .notifyAdmins({
                    trigger: 'workspace_secret_flag',
                    title: opened.length > 1 ? `Secrets: ${opened.length} unusual reads` : 'Secrets: unusual reads',
                    message: `${opened[0]!.explanation}${more} See Settings → Secrets.`,
                    path: '/settings/secrets',
                })
                .catch(() => undefined);
            await this.deps.write('workspace secret flags notified', () =>
                this.deps.lines.notified(
                    opened.map((row) => row.id),
                    now,
                ),
            );
        }
        return opened;
    }
}
