/**
 * AI reply reports (CB-382): the workspace's sharing setting, the outbox
 * (`cloud_outbox`) and the sender that takes it to the reports collector
 * (docs/specs/CLOUD-SERVICES-PROTOCOL.md §3.3, §4; the clients' side is
 * docs/specs/REPLY-REPORTS.md).
 *
 * A report is made only while an admin shares reports and the cloud
 * connection grants `reports:write`. Its body is snapshotted, redacted,
 * cut to the collector's caps and sealed when the person confirms it, and
 * queued in the reaction's own unit of work. The leader sends due rows
 * every minute under a lease, so two runtimes never send one row twice.
 * What leaves is exactly the collector's fields (`reportBody`): never a
 * user id, name, email, the conversation's or message's id, or the origin.
 */
import { createHmac, hkdfSync, randomBytes, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { transaction } from '@socio/data/open';
import { redactSocioTokens } from '@socio/foundation/actors/redact';
import { LogRedactor } from '@socio/foundation/apps/log-redact';
import type { SealState, SecretBox } from '@socio/foundation/keys/secret-box';
import {
    REPLY_REPORTS_TEXT_VERSION,
    REPORT_NOTE_MAX,
    type ReplyReportsAdminView,
    type ReplyReportsState,
    type ReportMark,
    type ReportOutcome,
    type ReportReason,
    type ReportRemoval,
} from '@socio/shared/chat/reply-reports';

import type { SecretSetting } from '../settings/contract.js';
import type { WorkspaceAuditEntry } from '../workspace/contract.js';

import {
    CLOUD_REPORTS_KEY_SETTING,
    ReplyReportsUnavailable,
    type CloudShape,
    type PreparedReplyReport,
    type ReplyReportInput,
    type ReplyReportsShape,
} from './contract.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Network errors and other 5xx: 1 min, 5 min, 30 min, 2 h, then every 6 h. */
export const REPORT_BACKOFF = [MINUTE, 5 * MINUTE, 30 * MINUTE, 2 * HOUR, 6 * HOUR] as const;
/** A report still unsent after this long fails. */
export const REPORT_EXPIRY_MS = 7 * DAY;
/** Sent and failed rows are forgotten after this long; the reaction's mark goes with them. */
export const REPORT_RETENTION_MS = 30 * DAY;
/** The most rows one tick sends. */
export const REPORT_BATCH = 20;
/** How long a claimed row is this runtime's: longer than a batch can take (20 × the timeout). */
export const REPORT_LEASE_MS = 15 * MINUTE;
const TIMEOUT_MS = 30_000;
/** The collector's caps (§4), in code points, and its body limit in bytes. */
export const REPLY_TEXT_MAX = 32_000;
export const PROMPT_TEXT_MAX = 16_000;
export const REPORT_BODY_MAX_BYTES = 64 * 1024;
/** `Retry-After` is followed between these. */
const RETRY_AFTER_MIN = 1_000;
const RETRY_AFTER_MAX = 6 * HOUR;
const SETTING_KEY = 'reply-reports';
/** The collector's last `Retry-After`, shared by every runtime. */
const COOLDOWN_KEY = 'reports-collector-cooldown';

/** The body the collector accepts (§4), exactly: it refuses any other field. */
export interface ReportBody {
    id: string;
    reportedAt: number;
    reason: ReportReason;
    note?: string;
    reply: { text: string; truncated: boolean; at?: number };
    prompt?: { text: string; truncated: boolean };
    promptByOther?: boolean;
    model?: string;
    socio?: string;
    surface?: 'web' | 'mobile' | 'telegram';
    appVersion?: string;
    threadHash?: string;
}

/** The sharing setting as stored (`cloud_settings`). */
interface SharingSetting {
    sharing: boolean;
    consent?: string;
    since?: number;
    by?: string;
}

interface OutboxRow {
    id: string;
    payload: string | null;
    attempts: number;
    sentAt: number | null;
    failedAt: number | null;
    leaseUntil: number | null;
    withdrawnAt: number | null;
}

/** How one send ended. */
type Sent =
    | { kind: 'sent' }
    | { kind: 'unauthorized' }
    | { kind: 'failed'; error: string }
    | { kind: 'later'; afterMs: number; error: string }
    | { kind: 'retry'; error: string };

const secretPatterns = new LogRedactor();

/** Socio's tokens and envelopes, then keys with a known shape, bearer and `key=value` secrets, URL credentials. */
export const redactReportText = (text: string) => secretPatterns.redact(redactSocioTokens(text, { envelopes: true }));

/** At most `max` code points of `text`. */
function cut(text: string, max: number): { text: string; truncated: boolean } {
    const points = [...text];
    return points.length > max ? { text: points.slice(0, max).join(''), truncated: true } : { text, truncated: false };
}

/** How many bytes `text` takes inside a JSON string. */
const jsonBytes = (text: string) => Buffer.byteLength(JSON.stringify(text)) - 2;

/** As many whole code points of `text` as fit in `max` bytes of JSON. */
function cutBytes(text: string, max: number, truncated: boolean): { text: string; truncated: boolean } {
    if (jsonBytes(text) <= max) {
        return { text, truncated };
    }
    let used = 0;
    let kept = '';
    for (const point of text) {
        used += jsonBytes(point);
        if (used > max) {
            break;
        }
        kept += point;
    }
    return { text: kept, truncated: true };
}

/** A UUIDv7 (RFC 9562): the time first, so reports sort by when they were made. */
export function uuidv7(now: number): string {
    const bytes = randomBytes(16);
    bytes.writeUIntBE(Math.max(0, Math.floor(now)) % 2 ** 48, 0, 6);
    bytes[6] = (bytes[6]! & 0x0f) | 0x70;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The per-deployment hashes: HMAC-SHA256 under keys derived (HKDF) from the sealed key, one label each. */
export interface ReportHashes {
    thread(threadId: string): string;
    socio(socioId: string): string;
}

export function reportHashes(key: Buffer): ReportHashes {
    const derive = (label: string) => Buffer.from(hkdfSync('sha256', key, Buffer.alloc(0), label, 32));
    const threadKey = derive('socio reply reports: thread hash v1');
    const socioKey = derive('socio reply reports: socio hash v1');
    const hmac = (subkey: Buffer, value: string) => createHmac('sha256', subkey).update(value).digest('base64url');
    return { thread: (id) => hmac(threadKey, id), socio: (id) => hmac(socioKey, id) };
}

/**
 * The collector's body for `input`: both texts redacted, then cut to the
 * caps and, if the whole would pass 64 KiB, cut further (the reply first
 * while it is the longer). Nothing but these fields: the person, the
 * conversation and the message are known only by the per-deployment hash.
 */
export function reportBody(input: ReplyReportInput, hashes: ReportHashes, id: string, now: number): ReportBody {
    let reply = cut(redactReportText(input.reply.text), REPLY_TEXT_MAX);
    let prompt = input.prompt ? cut(redactReportText(input.prompt.text), PROMPT_TEXT_MAX) : undefined;
    const note = input.note?.trim();
    const build = (): ReportBody => ({
        id,
        reportedAt: now,
        reason: input.reason,
        // Redaction may lengthen it ("[redacted]"): cut to the collector's cap again.
        ...(note ? { note: cut(redactReportText(note), REPORT_NOTE_MAX).text } : {}),
        reply: { text: reply.text, truncated: reply.truncated, ...(input.reply.at ? { at: input.reply.at } : {}) },
        ...(prompt && input.prompt
            ? { prompt: { text: prompt.text, truncated: prompt.truncated }, promptByOther: input.prompt.byOther }
            : {}),
        ...(input.model ? { model: input.model.slice(0, 200) } : {}),
        // Q11 (owner, 2026-11-26): a hashed id of the socio, never its name.
        ...(input.socioId ? { socio: hashes.socio(input.socioId) } : {}),
        ...(input.surface ? { surface: input.surface } : {}),
        ...(input.appVersion ? { appVersion: input.appVersion.slice(0, 40) } : {}),
        threadHash: hashes.thread(input.threadId),
    });
    let body = build();
    if (Buffer.byteLength(JSON.stringify(body)) > REPORT_BODY_MAX_BYTES) {
        // What the texts may take of the body, as JSON: the reply two thirds of it, the prompt
        // the rest, and either one more when the other needs less.
        const replyText = reply.text;
        const promptText = prompt?.text ?? '';
        reply = { text: '', truncated: reply.truncated };
        prompt = prompt ? { text: '', truncated: prompt.truncated } : undefined;
        const budget = REPORT_BODY_MAX_BYTES - Buffer.byteLength(JSON.stringify(build())) - 512;
        const replyBytes = jsonBytes(replyText);
        const promptBytes = jsonBytes(promptText);
        let replyBudget = Math.floor((budget * 2) / 3);
        if (promptBytes < budget - replyBudget) {
            replyBudget = budget - promptBytes;
        } else if (replyBytes < replyBudget) {
            replyBudget = replyBytes;
        }
        reply = cutBytes(replyText, replyBudget, reply.truncated);
        if (prompt) {
            prompt = cutBytes(promptText, budget - replyBudget, prompt.truncated);
        }
        body = build();
    }
    return body;
}

/** `Retry-After`: seconds or an HTTP date, kept between a second and 6 hours (a minute when absent). */
function retryAfter(header: string | null, now: number): number {
    let ms = MINUTE;
    if (header && /^\d+$/.test(header.trim())) {
        ms = Number(header.trim()) * 1000;
    } else if (header) {
        const at = Date.parse(header);
        ms = Number.isNaN(at) ? MINUTE : at - now;
    }
    return Math.min(RETRY_AFTER_MAX, Math.max(RETRY_AFTER_MIN, ms));
}

export interface ReplyReportsOptions {
    /** The workspace connection: the reactions' and the outbox's. */
    db: DatabaseSync;
    cloud: Pick<CloudShape, 'status' | 'token'>;
    /** The collector's origin (`reportsOrigin`); none: reports aren't available. */
    reportsOrigin: string | undefined;
    box: Pick<SecretBox, 'seal' | 'open' | 'reseal' | 'state' | 'valueKey'>;
    /** Where the hash key is kept, sealed. */
    secrets: {
        secretSetting(name: string): SecretSetting | undefined;
        replaceSecretSetting(name: string, previous: string, next: string): Promise<boolean>;
        addSecretSetting(name: string, value: string): Promise<boolean>;
    };
    /** The workspace audit: turning sharing on or off. */
    audit(entry: WorkspaceAuditEntry): void;
    /** Operational lines only: never a report's text, a token or an id of a person. */
    log(line: string): void;
    /** The collector's transport (tests: a fake collector). */
    transport?: typeof fetch;
    now?: () => number;
}

export class ReplyReportsService implements ReplyReportsShape {
    private readonly now: () => number;
    private readonly transport: typeof fetch;
    private hashes?: { sealed: string; hashes: ReportHashes };
    private sending?: Promise<void>;
    private draining = false;
    /** The time in the last report id: ids made in one millisecond still sort as made. */
    private lastIdAt = 0;

    constructor(private readonly options: ReplyReportsOptions) {
        this.now = options.now ?? Date.now;
        this.transport = options.transport ?? fetch;
    }

    private get db() {
        return this.options.db;
    }

    // ── The setting ──────────────────────────────────────────────────────

    /** Connected (or paused a while), granted `reports:write`, and a collector to send to. */
    available(): boolean {
        if (!this.options.reportsOrigin) {
            return false;
        }
        const status = this.options.cloud.status();
        return (
            (status.connection === 'connected' || status.connection === 'paused') &&
            status.scopes.includes('reports:write')
        );
    }

    private setting(): SharingSetting {
        const row = this.db.prepare('SELECT value FROM cloud_settings WHERE key=?').get(SETTING_KEY) as
            | { value: string }
            | undefined;
        try {
            const value = row ? (JSON.parse(row.value) as SharingSetting) : undefined;
            return value && typeof value.sharing === 'boolean' ? value : { sharing: false };
        } catch {
            return { sharing: false };
        }
    }

    state(): ReplyReportsState {
        const setting = this.setting();
        return setting.sharing && setting.consent && this.available()
            ? { sharing: true, consent: setting.consent }
            : null;
    }

    admin(): ReplyReportsAdminView {
        const setting = this.setting();
        const counts = this.db
            .prepare(
                `SELECT
                   total(sentAt IS NULL AND failedAt IS NULL AND withdrawnAt IS NULL) AS queued,
                   total(failedAt IS NOT NULL) AS failed
                 FROM cloud_outbox WHERE kind='ai-report'`,
            )
            .get() as { queued: number; failed: number };
        return {
            available: this.available(),
            sharing: setting.sharing,
            ...(setting.sharing && setting.consent ? { consent: setting.consent } : {}),
            ...(setting.sharing && setting.since ? { since: setting.since } : {}),
            ...(setting.sharing && setting.by ? { by: setting.by } : {}),
            queued: counts.queued,
            failed: counts.failed,
        };
    }

    async setSharing(sharing: boolean, actor: string): Promise<ReplyReportsAdminView> {
        // Turning it off is always allowed: it only drops what waits.
        if (sharing && !this.available()) {
            throw new ReplyReportsUnavailable();
        }
        const now = this.now();
        const outcome = await transaction(this.db, 'reply reports sharing', () => {
            const current = this.setting();
            if (current.sharing === sharing) {
                return undefined;
            }
            const next: SharingSetting = sharing
                ? { sharing, consent: randomUUID(), since: now, by: actor }
                : { sharing };
            this.db
                .prepare(
                    `INSERT INTO cloud_settings(key, value, updatedAt) VALUES (?, ?, ?)
                     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updatedAt=excluded.updatedAt`,
                )
                .run(SETTING_KEY, JSON.stringify(next), now);
            const dropped = sharing ? 0 : this.dropUnsent(now);
            return { next, dropped };
        });
        if (outcome) {
            // Who, when (the line's time) and which text they agreed to; never a report.
            this.options.audit({
                actor,
                action: 'update',
                targetKind: 'reply_reports',
                targetId: 'sharing',
                detail: sharing
                    ? `sharing on, consent ${outcome.next.consent}, text ${REPLY_REPORTS_TEXT_VERSION}`
                    : `sharing off, ${outcome.dropped} unsent dropped`,
            });
        }
        return this.admin();
    }

    /**
     * Every queued report goes: deleted, or, while a send holds it,
     * marked withdrawn so the sender drops it unless it already went.
     */
    private dropUnsent(now: number): number {
        const unsent = `kind='ai-report' AND sentAt IS NULL AND failedAt IS NULL AND withdrawnAt IS NULL`;
        const deleted = this.db
            .prepare(`DELETE FROM cloud_outbox WHERE ${unsent} AND (leaseUntil IS NULL OR leaseUntil<=?)`)
            .run(now).changes;
        const held = this.db
            .prepare(`UPDATE cloud_outbox SET withdrawnAt=? WHERE ${unsent} AND leaseUntil>?`)
            .run(now, now).changes;
        return Number(deleted) + Number(held);
    }

    // ── Reports ──────────────────────────────────────────────────────────

    private row(threadId: string, messageId: string, userId: string): OutboxRow | undefined {
        return this.db
            .prepare(
                `SELECT id, payload, attempts, sentAt, failedAt, leaseUntil, withdrawnAt FROM cloud_outbox
                 WHERE threadId=? AND messageId=? AND userId=? AND kind='ai-report'`,
            )
            .get(threadId, messageId, userId) as OutboxRow | undefined;
    }

    private static markOf(row: Pick<OutboxRow, 'sentAt' | 'failedAt' | 'withdrawnAt'>): ReportMark | undefined {
        return row.sentAt !== null
            ? 'shared'
            : row.failedAt !== null
              ? 'failed'
              : row.withdrawnAt === null
                ? 'queued'
                : undefined;
    }

    mark(threadId: string, messageId: string, userId: string): ReportMark | undefined {
        const row = this.row(threadId, messageId, userId);
        return row ? ReplyReportsService.markOf(row) : undefined;
    }

    marks(threadId: string, userId: string): Record<string, ReportMark> {
        const rows = this.db
            .prepare(
                `SELECT messageId, sentAt, failedAt, withdrawnAt FROM cloud_outbox
                 WHERE threadId=? AND userId=? AND kind='ai-report'`,
            )
            .all(threadId, userId) as unknown as Array<
            Pick<OutboxRow, 'sentAt' | 'failedAt' | 'withdrawnAt'> & { messageId: string }
        >;
        const marks: Record<string, ReportMark> = {};
        for (const row of rows) {
            const mark = ReplyReportsService.markOf(row);
            if (mark) {
                marks[row.messageId] = mark;
            }
        }
        return marks;
    }

    async prepare(input: ReplyReportInput): Promise<PreparedReplyReport> {
        const now = this.now();
        this.lastIdAt = Math.max(now, this.lastIdAt + 1);
        const id = uuidv7(this.lastIdAt);
        const body = reportBody(input, await this.reportHashes(), id, now);
        return {
            id,
            threadId: input.threadId,
            messageId: input.messageId,
            userId: input.userId,
            consent: input.consent,
            sealed: this.options.box.seal(body),
            createdAt: now,
        };
    }

    file(report: PreparedReplyReport): ReportOutcome {
        const state = this.state();
        if (!state) {
            return 'not-sharing';
        }
        if (state.consent !== report.consent) {
            return 'consent-changed';
        }
        // A report on this reply by this person that still exists, sent or not (a withdrawn one is gone).
        if (this.row(report.threadId, report.messageId, report.userId)) {
            return 'already';
        }
        this.db
            .prepare(
                `INSERT INTO cloud_outbox(id, kind, threadId, messageId, userId, payload, createdAt, nextAt)
                 VALUES (?, 'ai-report', ?, ?, ?, ?, ?, ?)`,
            )
            .run(
                report.id,
                report.threadId,
                report.messageId,
                report.userId,
                report.sealed,
                report.createdAt,
                report.createdAt,
            );
        return 'queued';
    }

    withdraw(threadId: string, messageId: string, userId: string): ReportRemoval | undefined {
        const row = this.row(threadId, messageId, userId);
        if (!row || row.withdrawnAt !== null) {
            return row ? 'kept' : undefined;
        }
        if (row.sentAt !== null) {
            return 'kept';
        }
        if (row.failedAt !== null) {
            // Never sent and never will be: it stays only for the admins' count.
            return undefined;
        }
        const now = this.now();
        if (row.leaseUntil !== null && row.leaseUntil > now) {
            // A send holds it now: it may already have reached the collector.
            this.db.prepare('UPDATE cloud_outbox SET withdrawnAt=? WHERE id=?').run(now, row.id);
            return 'kept';
        }
        this.db.prepare('DELETE FROM cloud_outbox WHERE id=?').run(row.id);
        return 'withdrawn';
    }

    // ── The hash key ─────────────────────────────────────────────────────

    /**
     * The hashes under the deployment's own key: 32 random bytes made once,
     * sealed in `secret_settings` beside the identity. It never leaves.
     * A key the data key can't open is replaced (only grouping is lost).
     */
    private async reportHashes(): Promise<ReportHashes> {
        for (let attempt = 0; attempt < 3; attempt++) {
            const sealed = this.options.secrets.secretSetting(CLOUD_REPORTS_KEY_SETTING)?.value;
            if (sealed && this.hashes?.sealed === sealed) {
                return this.hashes.hashes;
            }
            if (sealed) {
                const key = this.openKey(sealed);
                if (key) {
                    this.hashes = { sealed, hashes: reportHashes(key) };
                    return this.hashes.hashes;
                }
            }
            const next = this.options.box.seal({ v: 1, key: randomBytes(32).toString('base64url') });
            const saved = sealed
                ? await this.options.secrets.replaceSecretSetting(CLOUD_REPORTS_KEY_SETTING, sealed, next)
                : await this.options.secrets.addSecretSetting(CLOUD_REPORTS_KEY_SETTING, next);
            if (saved) {
                this.options.log('Reply reports: made the deployment’s hash key.');
            }
            // Saved or not (another runtime wrote one first), the next pass reads what is stored.
        }
        throw new Error('could not store the reply reports’ hash key');
    }

    private openKey(sealed: string): Buffer | undefined {
        try {
            const value = this.options.box.open(sealed) as { v?: number; key?: unknown } | undefined;
            const key =
                value?.v === 1 && typeof value.key === 'string' ? Buffer.from(value.key, 'base64url') : undefined;
            return key?.length === 32 ? key : undefined;
        } catch {
            return undefined;
        }
    }

    // ── Sending ──────────────────────────────────────────────────────────

    send(): Promise<void> {
        if (this.draining) {
            return Promise.resolve();
        }
        this.sending ??= this.sendDue()
            .catch(() => this.options.log('Reply reports: sending stopped on an unexpected error.'))
            .finally(() => {
                this.sending = undefined;
            });
        return this.sending;
    }

    async drain(): Promise<void> {
        this.draining = true;
        await this.sending;
    }

    resume(): void {
        this.draining = false;
    }

    /** Fails what waited 7 days, forgets old sent and failed rows, and those withdrawn in a send that has ended. */
    private sweep(now: number) {
        return transaction(this.db, 'reply reports sweep', () => {
            const free = '(leaseUntil IS NULL OR leaseUntil<=?)';
            this.db
                .prepare(
                    `UPDATE cloud_outbox SET failedAt=?, payload=NULL, lastError='unsent for 7 days', leaseId=NULL, leaseUntil=NULL
                     WHERE sentAt IS NULL AND failedAt IS NULL AND withdrawnAt IS NULL AND createdAt<=? AND ${free}`,
                )
                .run(now, now - REPORT_EXPIRY_MS, now);
            this.db
                .prepare(
                    `DELETE FROM cloud_outbox WHERE (sentAt IS NOT NULL AND sentAt<=?) OR (failedAt IS NOT NULL AND failedAt<=?)
                     OR (withdrawnAt IS NOT NULL AND sentAt IS NULL AND ${free})`,
                )
                .run(now - REPORT_RETENTION_MS, now - REPORT_RETENTION_MS, now);
        });
    }

    /** Up to 20 due rows, oldest first, leased to this runtime. */
    private claim(now: number) {
        const leaseId = randomUUID();
        return transaction(this.db, 'reply reports claim', () => {
            const rows = this.db
                .prepare(
                    `SELECT id, payload, attempts FROM cloud_outbox
                     WHERE kind='ai-report' AND sentAt IS NULL AND failedAt IS NULL AND withdrawnAt IS NULL
                       AND payload IS NOT NULL AND nextAt<=? AND (leaseUntil IS NULL OR leaseUntil<=?)
                     ORDER BY createdAt, id LIMIT ?`,
                )
                .all(now, now, REPORT_BATCH) as unknown as Array<{ id: string; payload: string; attempts: number }>;
            const lease = this.db.prepare('UPDATE cloud_outbox SET leaseId=?, leaseUntil=? WHERE id=?');
            for (const row of rows) {
                lease.run(leaseId, now + REPORT_LEASE_MS, row.id);
            }
            return rows.map((row) => ({ ...row, leaseId }));
        });
    }

    /** Lets rows go unsent, as they were: a later tick takes them again. */
    private release(rows: readonly { id: string; leaseId: string }[]) {
        if (!rows.length) {
            return Promise.resolve();
        }
        return transaction(this.db, 'reply reports release', () => {
            const release = this.db.prepare(
                'UPDATE cloud_outbox SET leaseId=NULL, leaseUntil=NULL WHERE id=? AND leaseId=?',
            );
            for (const row of rows) {
                release.run(row.id, row.leaseId);
            }
        });
    }

    /** Until when the collector asked every report to wait (`Retry-After` on a 429 or 503). */
    private cooldownUntil(): number {
        const row = this.db.prepare('SELECT value FROM cloud_settings WHERE key=?').get(COOLDOWN_KEY) as
            | { value: string }
            | undefined;
        try {
            const until = row ? Number((JSON.parse(row.value) as { until?: unknown }).until) : 0;
            return Number.isFinite(until) ? until : 0;
        } catch {
            return 0;
        }
    }

    /**
     * Whether this row may go now: sharing is still on and possible, and
     * the row is still this runtime's lease and not withdrawn. Checked
     * right before each POST, so a report withdrawn or dropped (sharing
     * turned off) while the batch was sending never starts.
     */
    private mayStill(row: { id: string; leaseId: string }): boolean {
        if (!this.state()) {
            return false;
        }
        const current = this.db.prepare('SELECT leaseId, withdrawnAt FROM cloud_outbox WHERE id=?').get(row.id) as
            | { leaseId: string | null; withdrawnAt: number | null }
            | undefined;
        return current?.leaseId === row.leaseId && current.withdrawnAt === null;
    }

    /**
     * `stop`: the collector asked every report to wait (any runtime may
     * have heard it), so this batch stops. `skip`: this row may not go
     * (`mayStill`). `go`: post it now.
     */
    private gate(row: { id: string; leaseId: string }): 'go' | 'skip' | 'stop' {
        if (this.now() < this.cooldownUntil()) {
            return 'stop';
        }
        return this.mayStill(row) ? 'go' : 'skip';
    }

    /** Rows that may not go: withdrawn ones are deleted, the rest released as they were. */
    private async putBack(rows: readonly { id: string; leaseId: string }[]) {
        if (!rows.length) {
            return;
        }
        await transaction(this.db, 'reply reports put back', () => {
            const drop = this.db.prepare(
                'DELETE FROM cloud_outbox WHERE id=? AND leaseId=? AND withdrawnAt IS NOT NULL AND sentAt IS NULL',
            );
            for (const row of rows) {
                drop.run(row.id, row.leaseId);
            }
        });
        await this.release(rows);
    }

    private async sendDue() {
        await this.sweep(this.now());
        const origin = this.options.reportsOrigin;
        if (!origin || !this.available() || this.now() < this.cooldownUntil()) {
            return;
        }
        const rows = await this.claim(this.now());
        if (!rows.length) {
            return;
        }
        let token = await this.options.cloud.token(origin);
        let renewed = false;
        for (let index = 0; index < rows.length; index++) {
            const row = rows[index]!;
            if (this.draining || !token) {
                // No token (the issuer is out of reach, holds tokens back or refused the key): they wait.
                await this.putBack(rows.slice(index));
                return;
            }
            // Checked right before each POST, a retry's too: anything awaited meanwhile may have changed it.
            const gate = this.gate(row);
            if (gate === 'stop') {
                await this.putBack(rows.slice(index));
                return;
            }
            if (gate === 'skip') {
                await this.putBack([row]);
                continue;
            }
            let sent = await this.post(origin, row.payload, token);
            if (sent.kind === 'unauthorized' && !renewed) {
                // §3.3: a new token, once. `invalid_client` on renewal stops the queue (the connection is revoked).
                renewed = true;
                token = await this.options.cloud.token(origin, { renew: true });
                if (!token) {
                    await this.putBack(rows.slice(index));
                    return;
                }
                const again = this.gate(row);
                if (again === 'stop') {
                    await this.putBack(rows.slice(index));
                    return;
                }
                if (again === 'skip') {
                    await this.putBack([row]);
                    continue;
                }
                sent = await this.post(origin, row.payload, token);
            }
            await this.settle(row, sent.kind === 'unauthorized' ? { kind: 'retry', error: 'http 401' } : sent);
            if (sent.kind === 'later') {
                // The collector asked to wait: every report waits, these and any queued meanwhile.
                const until = this.now() + sent.afterMs;
                await transaction(this.db, 'reply reports cooldown', () => {
                    this.db
                        .prepare(
                            // The later deadline wins: a shorter answer never cuts a longer wait short.
                            `INSERT INTO cloud_settings(key, value, updatedAt) VALUES (?, ?, ?)
                             ON CONFLICT(key) DO UPDATE SET value=excluded.value, updatedAt=excluded.updatedAt
                             WHERE ifnull(json_extract(cloud_settings.value, '$.until'), 0) < json_extract(excluded.value, '$.until')`,
                        )
                        .run(COOLDOWN_KEY, JSON.stringify({ until }), this.now());
                });
                await this.putBack(rows.slice(index + 1));
                return;
            }
        }
    }

    /** One POST to the collector, classified (§4's answers). */
    private async post(origin: string, sealed: string, token: string): Promise<Sent> {
        let body: string;
        try {
            body = JSON.stringify(this.options.box.open(sealed));
        } catch {
            return { kind: 'failed', error: 'unreadable' };
        }
        let response: Response;
        try {
            response = await this.transport(`${origin}/v1/reports`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
                body,
                redirect: 'error',
                signal: AbortSignal.timeout(TIMEOUT_MS),
            });
            // The answer's body is never read beyond this: it isn't needed.
            await response.body?.cancel().catch(() => undefined);
        } catch {
            return { kind: 'retry', error: 'network' };
        }
        const status = response.status;
        if (status === 200 || status === 201) {
            return { kind: 'sent' };
        }
        if (status === 401) {
            return { kind: 'unauthorized' };
        }
        if (status === 400 || status === 403 || status === 413) {
            return { kind: 'failed', error: `http ${status}` };
        }
        if (status === 429 || status === 503) {
            return {
                kind: 'later',
                afterMs: retryAfter(response.headers.get('retry-after'), this.now()),
                error: `http ${status}`,
            };
        }
        return { kind: 'retry', error: `http ${status}` };
    }

    /** Writes how a send ended, only while this runtime still holds the row's lease. */
    private settle(
        row: { id: string; leaseId: string; attempts: number },
        sent: Exclude<Sent, { kind: 'unauthorized' }>,
    ) {
        const now = this.now();
        return transaction(this.db, 'reply reports settle', () => {
            const held = 'WHERE id=? AND leaseId=?';
            if (sent.kind === 'sent') {
                this.db
                    .prepare(
                        `UPDATE cloud_outbox SET sentAt=?, payload=NULL, attempts=attempts+1, lastError=NULL, leaseId=NULL, leaseUntil=NULL ${held}`,
                    )
                    .run(now, row.id, row.leaseId);
                return;
            }
            // Not sent, for good or for now: one withdrawn meanwhile goes now.
            if (
                this.db.prepare(`DELETE FROM cloud_outbox ${held} AND withdrawnAt IS NOT NULL`).run(row.id, row.leaseId)
                    .changes
            ) {
                return;
            }
            if (sent.kind === 'failed') {
                this.db
                    .prepare(
                        `UPDATE cloud_outbox SET failedAt=?, payload=NULL, attempts=attempts+1, lastError=?, leaseId=NULL, leaseUntil=NULL ${held}`,
                    )
                    .run(now, sent.error, row.id, row.leaseId);
                return;
            }
            const wait =
                sent.kind === 'later'
                    ? sent.afterMs
                    : REPORT_BACKOFF[Math.min(row.attempts, REPORT_BACKOFF.length - 1)]!;
            this.db
                .prepare(
                    `UPDATE cloud_outbox SET nextAt=?, attempts=attempts+1, lastError=?, leaseId=NULL, leaseUntil=NULL ${held}`,
                )
                .run(now + wait, sent.error, row.id, row.leaseId);
        });
    }

    // ── The data key ─────────────────────────────────────────────────────

    sealStates(): Record<SealState, number> {
        const counts = { current: 0, previous: 0, legacy: 0, unknown: 0 };
        const box = this.options.box;
        const key = this.options.secrets.secretSetting(CLOUD_REPORTS_KEY_SETTING)?.value;
        for (const sealed of [
            ...(key ? [key] : []),
            ...(
                this.db.prepare('SELECT payload FROM cloud_outbox WHERE payload IS NOT NULL').all() as unknown as {
                    payload: string;
                }[]
            ).map((row) => row.payload),
        ]) {
            counts[box.state(box.valueKey(sealed))]++;
        }
        return counts;
    }

    async reseal() {
        const result = { resealed: 0, unreadable: 0 };
        const box = this.options.box;
        const again = (sealed: string) => {
            try {
                return box.reseal(sealed);
            } catch {
                result.unreadable++;
                return undefined;
            }
        };
        const key = this.options.secrets.secretSetting(CLOUD_REPORTS_KEY_SETTING)?.value;
        const nextKey = key ? again(key) : undefined;
        if (
            key &&
            nextKey &&
            (await this.options.secrets.replaceSecretSetting(CLOUD_REPORTS_KEY_SETTING, key, nextKey))
        ) {
            result.resealed++;
        }
        const rows = this.db
            .prepare('SELECT id, payload FROM cloud_outbox WHERE payload IS NOT NULL')
            .all() as unknown as { id: string; payload: string }[];
        const changed = rows.flatMap((row) => {
            const next = again(row.payload);
            return next ? [{ ...row, next }] : [];
        });
        if (changed.length) {
            result.resealed += await transaction(this.db, 'reply reports reseal', () => {
                const update = this.db.prepare('UPDATE cloud_outbox SET payload=? WHERE id=? AND payload=?');
                return changed.reduce((n, row) => n + Number(update.run(row.next, row.id, row.payload).changes), 0);
            });
        }
        return result;
    }
}
