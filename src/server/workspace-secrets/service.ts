import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import { nextTurn } from '@socio/data/events';
import { deletedWith, SYSTEM } from '@socio/data/soft-delete';
import { RESEAL_BATCH, SecretBox, type DataKeyring } from '@socio/foundation/keys/secret-box';
import {
    FLAG_EVALUATE_EVERY_MS,
    SECRET_CACHE_MS,
    SECRET_HISTORY_PAGE_DEFAULT,
    SECRET_HISTORY_PAGE_MAX,
    SECRET_LIMIT,
    SECRET_NAME,
    SECRET_NAME_HINT,
    SECRET_OVERLAP_DEFAULT_MINUTES,
    SECRET_OVERLAP_MAX_MINUTES,
    SECRET_VALUE_MAX_BYTES,
    STALE_IDENTITY_GRACE_MS,
    parseWorkloadKey,
    pluginWorkloadKey,
    workloadKey,
    type AppManifestSecret,
    type AppSecretNeeds,
    type SecretHistory,
    type SecretHistoryEvent,
    type SecretHistoryEventKind,
    type SecretReadFlagView,
    type SecretScope,
    type SecretVersionView,
    type WorkspaceSecretsState,
    type WorkspaceSecretView,
    type WorkloadKind,
} from '@socio/shared/workspace-secrets';

import type { WorkspaceAuditEntry } from '../workspace/contract.js';

import type { ReadOutcome, SecretApp, WorkspaceSecretsAdminShape, WorkspaceSecretsDeps } from './contract.js';
import type { SecretAuditLine, StoredFlag } from './infra/sqlite/audit-lines.js';
import type { StoredSecret, WorkspaceSecretRepository } from './infra/sqlite/repository.js';
import { SecretReadFlags, workloadOfActor } from './read-flags.js';

/** A refusal with its HTTP status; the message never holds a value. */
export class SecretError extends Error {
    constructor(
        message: string,
        readonly status: 400 | 403 | 404 | 409 | 429 = 400,
    ) {
        super(message);
        this.name = 'SecretError';
    }
}

const value = z
    .string()
    .min(1, 'Enter a value.')
    .refine((text) => Buffer.byteLength(text) <= SECRET_VALUE_MAX_BYTES, {
        message: `A value is at most ${SECRET_VALUE_MAX_BYTES / 1024} KiB.`,
    });
const description = z.string().trim().max(300).default('');
export const createSecretInput = z
    .object({
        name: z.string().trim().regex(SECRET_NAME, `Name: ${SECRET_NAME_HINT}.`),
        scope: z.enum(['workspace', 'workload']).default('workspace'),
        /** `workload`: the workspace app that owns it. */
        appId: z.string().min(1).max(200).optional(),
        description,
        value,
    })
    .strict();
export const replaceSecretInput = z
    .object({
        value,
        /** How long the version it replaces stays readable; 0 retires it at once. */
        overlapMinutes: z.number().int().min(0).max(SECRET_OVERLAP_MAX_MINUTES).optional(),
    })
    .strict();
export const describeSecretInput = z.object({ description }).strict();

/** What a sealed value binds: a sealed version can't be moved to another secret or version. */
interface Sealed {
    secretId: string;
    version: number;
    value: string;
}

/**
 * Workloads are named by key (`workloadKey`): an app by its id, a plugin
 * as `plugin:<id>`. As an audit actor an app is `app:<id>`, a plugin
 * `plugin:<id>`; in a detail, `app=<id>` or `plugin=<id>`.
 */
const readerOf = (key: string) => {
    const ref = parseWorkloadKey(key);
    return `${ref.kind}:${ref.id}`;
};
const labelOf = (key: string) => {
    const ref = parseWorkloadKey(key);
    return `${ref.kind}=${ref.id}`;
};
const refOf = (key: string): { kind: WorkloadKind; id: string } => parseWorkloadKey(key);
/** Values a workload read that redaction keeps, per app (most recent first out). */
const SERVED_KEPT = 64;

/**
 * Socio Secrets: secrets for workspace apps, sealed with the data key
 * (`workspace-secrets`), written by workspace admins and read by apps with
 * their data token. Nothing here returns a value except `read`, which is for
 * the workload route alone; every change and every read (or refusal) is a
 * `workspace_audit` line with names, versions and apps, never a value.
 */
export class WorkspaceSecrets implements WorkspaceSecretsAdminShape {
    private box: SecretBox;
    private now: () => number;
    /** Values each app read in this process: redaction learns them. */
    private served = new Map<string, Map<string, true>>();
    /** The read-anomaly rules, and when they last ran here. */
    readonly flags: SecretReadFlags;
    private flagsRanAt = 0;
    /** Platform reads already audited in this process, by secret and version. */
    private platformReads = new Set<string>();
    /** Stale identities' refusals audited, per plugin and version: at most one a minute. */
    private staleAudited = new Map<string, number>();
    constructor(
        readonly repository: WorkspaceSecretRepository,
        keys: DataKeyring,
        private deps: WorkspaceSecretsDeps,
    ) {
        this.box = new SecretBox(keys, 'workspace-secrets');
        this.now = deps.now ?? Date.now;
        this.flags = new SecretReadFlags({
            lines: repository.lines,
            write: (label, fn) => repository.write(label, fn),
            workloadName: (key) => this.appName(key) ?? key,
            secretName: (id) => repository.withDeleted(id)?.name ?? 'a deleted secret',
            ...(deps.notifyAdmins ? { notifyAdmins: (notice) => deps.notifyAdmins!(notice) } : {}),
        });
    }

    // ---- the admin view: never a value ------------------------------------
    private name(userId: string) {
        if (userId === SYSTEM) {
            return 'Socio';
        }
        return this.deps.userName(userId) ?? 'A former member';
    }
    // ---- workloads: workspace apps and service plugins ---------------------
    private workloadOf(key: string): SecretApp | undefined {
        const ref = refOf(key);
        return ref.kind === 'plugin' ? this.deps.plugins?.get(ref.id) : this.deps.apps.get(ref.id);
    }
    private declaredOf(key: string): readonly AppManifestSecret[] {
        const ref = refOf(key);
        return ref.kind === 'plugin' ? (this.deps.plugins?.declared(ref.id) ?? []) : this.deps.apps.declared(ref.id);
    }
    /** Every workload, by key: workspace apps, then plugins. */
    private workloads(): Array<{ key: string; kind: WorkloadKind; workload: SecretApp }> {
        return [
            ...this.deps.apps.list().map((workload) => ({ key: workload.id, kind: 'app' as const, workload })),
            ...(this.deps.plugins?.list() ?? []).map((workload) => ({
                key: workloadKey('plugin', workload.id),
                kind: 'plugin' as const,
                workload,
            })),
        ];
    }
    private appName(key: string | null) {
        if (!key) {
            return null;
        }
        return this.workloadOf(key)?.name ?? (refOf(key).kind === 'plugin' ? 'A removed plugin' : 'A removed app');
    }
    private versionsOf(secretId: string): SecretVersionView[] {
        const now = this.now();
        return this.repository.versions(secretId).map((version) => ({
            version: version.version,
            // A window that passed is retired, whether or not the sweep ran.
            state: version.state === 'previous' && (version.retireAt ?? 0) <= now ? 'retired' : version.state,
            setAt: version.setAt,
            setBy: version.setBy,
            setByName: this.name(version.setBy),
            retireAt: version.retireAt,
            lastReadAt: version.lastReadAt,
        }));
    }
    private view(row: StoredSecret): WorkspaceSecretView {
        return {
            id: row.id,
            name: row.name,
            scope: row.scope,
            appId: row.workloadKind && row.workloadId ? workloadKey(row.workloadKind, row.workloadId) : null,
            appName:
                row.workloadKind && row.workloadId ? this.appName(workloadKey(row.workloadKind, row.workloadId)) : null,
            description: row.description,
            createdAt: row.createdAt,
            createdByName: this.name(row.createdBy),
            updatedAt: row.updatedAt,
            versions: this.versionsOf(row.id),
            grants: this.repository.grants(row.id).map((grant) => ({
                appId: workloadKey(grant.workloadKind, grant.workloadId),
                kind: grant.workloadKind,
                appName: this.appName(workloadKey(grant.workloadKind, grant.workloadId))!,
                grantedAt: grant.grantedAt,
                grantedByName: this.name(grant.grantedBy),
            })),
            lastReadAt: row.lastReadAt,
            lastReadByName: row.lastReadBy?.startsWith('app:')
                ? this.appName(row.lastReadBy.slice(4))
                : row.lastReadBy?.startsWith('plugin:')
                  ? this.appName(row.lastReadBy)
                  : null,
        };
    }
    get(id: string): WorkspaceSecretView {
        const row = this.repository.get(id);
        if (!row) {
            throw new SecretError('Secret not found.', 404);
        }
        return this.view(row);
    }
    /** Every live secret and every workspace app's declared needs. */
    state(): WorkspaceSecretsState {
        return {
            secrets: this.repository.live().map((row) => this.view(row)),
            apps: this.workloads().map((entry) => this.needsOf(entry.key, entry.kind, entry.workload)),
            overlapDefaultMinutes: SECRET_OVERLAP_DEFAULT_MINUTES,
            flags: this.repository.lines.openFlags().map((row) => this.flagView(row)),
        };
    }

    // ---- a secret's history and read flags (never a value) -----------------
    private flagView(row: StoredFlag): SecretReadFlagView {
        const key = workloadKey(row.workloadKind, row.workloadId);
        return {
            id: row.id,
            rule: row.rule,
            workload: key,
            kind: row.workloadKind,
            workloadName: this.appName(key)!,
            secretId: row.secretId,
            secretName: row.secretId ? (this.repository.withDeleted(row.secretId)?.name ?? null) : null,
            explanation: row.explanation,
            firstSeenAt: row.firstSeenAt,
            lastSeenAt: row.lastSeenAt,
            dismissedAt: row.dismissedAt,
            dismissedByName: row.dismissedBy ? this.name(row.dismissedBy) : null,
        };
    }
    private actorName(actor: string) {
        const workload = workloadOfActor(actor);
        return workload ? this.appName(workload)! : this.name(actor);
    }
    private event(line: SecretAuditLine): SecretHistoryEvent {
        const kinds: Record<string, SecretHistoryEventKind> = {
            create: 'created',
            update: 'replaced',
            delete: 'deleted',
            grant: 'granted',
            revoke: 'revoked',
            read: 'first-read',
        };
        // Audit details read `NAME (scope …): what happened`; reads `NAME: …`.
        const what = line.detail.slice(line.detail.indexOf(': ') + 2);
        let kind = kinds[line.action] ?? 'replaced';
        if (kind === 'replaced' && what.startsWith('description changed')) {
            kind = 'described';
        }
        const version = /\bversion (\d+)/.exec(what);
        const named = /\b(app|plugin)=(\S+)/.exec(line.detail);
        const workload =
            kind === 'first-read'
                ? (workloadOfActor(line.actor) ?? null)
                : named
                  ? workloadKey(named[1] as WorkloadKind, named[2]!)
                  : null;
        const workloadName = workload ? this.appName(workload) : null;
        return {
            id: line.id,
            at: line.createdAt,
            kind,
            actorName: this.actorName(line.actor),
            workload,
            workloadName,
            version: version ? Number(version[1]) : null,
            detail:
                kind === 'first-read'
                    ? `first read by ${workloadName ?? 'a workload'}${version ? `, version ${version[1]}` : ''}`
                    : what,
        };
    }
    /**
     * A secret's history, deleted ones too (admins only): its versions,
     * each workload's reads and refusals aggregated (first, last, how
     * many), and a page of events, newest first: changes, grants, revokes,
     * and each workload's first read. From the audit lines; never a value.
     */
    history(id: string, query: { before?: number; limit?: number } = {}): SecretHistory {
        const row = this.repository.withDeleted(id);
        if (!row) {
            throw new SecretError('Secret not found.', 404);
        }
        const limit = Math.min(
            Math.max(1, Math.floor(query.limit ?? SECRET_HISTORY_PAGE_DEFAULT)),
            SECRET_HISTORY_PAGE_MAX,
        );
        const lines = this.repository.lines.events(id, query.before ?? Number.MAX_SAFE_INTEGER, limit + 1);
        const page = lines.slice(0, limit);
        const owner = row.workloadKind && row.workloadId ? workloadKey(row.workloadKind, row.workloadId) : null;
        return {
            secret: {
                id: row.id,
                name: row.name,
                scope: row.scope,
                appName: this.appName(owner),
                deletedAt: row.deletedAt,
            },
            versions: this.versionsOf(id),
            reads: this.repository.lines.readCounts(id).flatMap((counts) => {
                const workload = workloadOfActor(counts.actor);
                if (!workload) {
                    return [];
                }
                const { actor: _, ...rest } = counts;
                return [{ workload, kind: refOf(workload).kind, workloadName: this.appName(workload)!, ...rest }];
            }),
            events: page.map((line) => this.event(line)),
            nextBefore: lines.length > limit ? page.at(-1)!.id : null,
            flags: this.repository.lines.flagsOf(id).map((flag) => this.flagView(flag)),
        };
    }
    /** Runs the read-anomaly rules now (tests, and the tick when due); returns the flags it opened. */
    async evaluateFlags(): Promise<SecretReadFlagView[]> {
        const now = this.now();
        this.flagsRanAt = now;
        return (await this.flags.evaluate(now)).map((row) => this.flagView(row));
    }
    /** The module's tick: the rules every `FLAG_EVALUATE_EVERY_MS`. */
    async evaluateFlagsIfDue() {
        if (this.now() - this.flagsRanAt >= FLAG_EVALUATE_EVERY_MS) {
            await this.evaluateFlags();
        }
    }
    /** An admin dismisses a flag: it stays as the record; only newer evidence raises it again. */
    async dismissFlag(actor: string, id: string): Promise<SecretReadFlagView> {
        const row = this.repository.lines.flag(id);
        if (!row) {
            throw new SecretError('Flag not found.', 404);
        }
        const changed = await this.repository.write('dismiss workspace secret flag', () =>
            this.repository.lines.dismiss(id, actor, this.now()),
        );
        if (changed) {
            this.deps.audit({
                actor,
                action: 'update',
                targetKind: 'workspace_secret',
                targetId: `flag:${id}`,
                detail: `read flag ${row.rule} for ${row.workloadKind}=${row.workloadId} dismissed`,
            });
        }
        return this.flagView(this.repository.lines.flag(id)!);
    }
    /**
     * A plugin's identity that is no longer accepted, used with its proof
     * (app.ts refuses the call): audited as a refused read with a stale
     * identity, at most once a minute per plugin and version.
     */
    refuseStaleIdentity(pluginId: string, version: number, names: string) {
        const now = this.now();
        const throttle = `${pluginId}#${version}`;
        if (now - (this.staleAudited.get(throttle) ?? -Infinity) < 60_000) {
            return;
        }
        this.staleAudited.set(throttle, now);
        const key = pluginWorkloadKey(pluginId);
        const name = names.split(',')[0]?.trim().slice(0, 64) || '*';
        const current = this.deps.plugins?.identity?.(pluginId);
        this.deps.audit({
            actor: readerOf(key),
            action: 'deny',
            targetKind: 'workspace_secret',
            targetId: `name:${name}`,
            detail: `${name}: read refused (identity no longer accepted) ${labelOf(key)} identity v${version} stale (current ${current ? `v${current.version}` : 'none'})`,
        });
    }
    /** For a plugin's read: which identity version it used, marked stale after the drain. */
    private identityNote(key: string, identityVersion: number | undefined) {
        const ref = refOf(key);
        if (identityVersion === undefined || ref.kind !== 'plugin') {
            return '';
        }
        const current = this.deps.plugins?.identity?.(ref.id);
        const stale =
            current && identityVersion < current.version && this.now() - current.issuedAt > STALE_IDENTITY_GRACE_MS;
        return ` identity v${identityVersion}${stale ? ` stale (current v${current.version})` : ''}`;
    }

    // ---- what serves a workload -----------------------------------------
    private declared(key: string, name: string) {
        return this.declaredOf(key).some((secret) => secret.name === name);
    }
    /** The secret that serves `name` to a workload: its own, else a workspace one granted to it. */
    private servingSecret(key: string, name: string) {
        const ref = refOf(key);
        const own = this.repository.byName(name, 'workload', ref);
        if (own) {
            return own;
        }
        const shared = this.repository.byName(name, 'workspace');
        return shared && this.repository.granted(shared.id, ref.kind, ref.id) ? shared : undefined;
    }
    private needsOf(key: string, kind: WorkloadKind, app: SecretApp): AppSecretNeeds {
        const declared = this.declaredOf(key).map((secret) => {
            const serving = this.servingSecret(key, secret.name);
            return {
                name: secret.name,
                required: secret.required,
                description: secret.description ?? '',
                servedBy: serving ? { id: serving.id, scope: serving.scope } : null,
            };
        });
        return {
            appId: key,
            kind,
            name: app.name,
            status: app.status,
            declared,
            needsSetup: declared.filter((entry) => entry.required && !entry.servedBy).map((entry) => entry.name),
        };
    }
    /** Required secrets nothing serves (the workload needs setup); empty for others. Takes a workload key. */
    needsSetup(appId: string): string[] {
        const app = this.workloadOf(appId);
        return app ? this.needsOf(appId, refOf(appId).kind, app).needsSetup : [];
    }
    /** A workload by key, or a refusal; its key comes back with it. */
    private workspaceApp(appId: string | undefined) {
        const app = appId ? this.workloadOf(appId) : undefined;
        if (!app || !appId) {
            throw new SecretError(
                'Only workspace apps (promoted into the workspace app runtime) and installed plugin services can hold secrets.',
                404,
            );
        }
        return { ...app, key: appId, ref: refOf(appId) };
    }

    // ---- changes, by workspace admins -----------------------------------
    private seal(secretId: string, version: number, text: string) {
        return this.box.seal({ secretId, version, value: text } satisfies Sealed);
    }
    private auditChange(actor: string, action: WorkspaceAuditEntry['action'], row: StoredSecret, detail: string) {
        this.deps.audit({
            actor,
            action,
            targetKind: 'workspace_secret',
            targetId: row.id,
            detail: `${row.name} (${row.scope}${row.workloadKind && row.workloadId ? ` ${row.workloadKind}=${row.workloadId}` : ''}): ${detail}`,
        });
    }
    async create(actor: string, input: z.input<typeof createSecretInput>): Promise<WorkspaceSecretView> {
        const data = createSecretInput.parse(input);
        const scope: SecretScope = data.scope;
        let app: ReturnType<WorkspaceSecrets['workspaceApp']> | undefined;
        if (scope === 'workload') {
            app = this.workspaceApp(data.appId);
            if (!this.declared(app.key, data.name)) {
                throw new SecretError(`${app.name} doesn’t declare ${data.name} in its manifest.`, 400);
            }
        } else if (data.appId) {
            throw new SecretError('A workspace secret belongs to no app; grant it to apps instead.', 400);
        }
        const now = this.now();
        const id = randomUUID();
        const row: StoredSecret = {
            id,
            name: data.name,
            scope,
            workloadKind: app ? app.ref.kind : null,
            workloadId: app ? app.ref.id : null,
            description: data.description,
            createdBy: actor,
            createdAt: now,
            updatedAt: now,
            lastReadAt: null,
            lastReadBy: null,
            deletedAt: null,
            deletedBy: null,
            deletedWith: null,
        };
        await this.repository.write('create workspace secret', () => {
            if (this.repository.liveCount() >= SECRET_LIMIT) {
                throw new SecretError(`At most ${SECRET_LIMIT} secrets.`, 409);
            }
            if (this.repository.byName(row.name, scope, app?.ref)) {
                throw new SecretError(
                    app
                        ? `${app.name} already has a secret named ${row.name}.`
                        : `A workspace secret named ${row.name} exists; replace its value instead.`,
                    409,
                );
            }
            this.repository.insertSecret(row);
            this.repository.insertVersion({
                secretId: id,
                version: 1,
                sealed: this.seal(id, 1, data.value),
                state: 'current',
                retireAt: null,
                setBy: actor,
                setAt: now,
            });
        });
        this.auditChange(actor, 'create', row, 'version 1 set');
        return this.get(id);
    }
    /** "Replace": a new current version; the old one stays readable for the overlap window. */
    async replace(actor: string, id: string, input: z.input<typeof replaceSecretInput>): Promise<WorkspaceSecretView> {
        const data = replaceSecretInput.parse(input);
        const overlapMs = (data.overlapMinutes ?? SECRET_OVERLAP_DEFAULT_MINUTES) * 60_000;
        const now = this.now();
        let version = 0;
        const row = await this.repository.write('replace workspace secret', () => {
            const found = this.repository.get(id);
            if (!found) {
                throw new SecretError('Secret not found.', 404);
            }
            version = (this.repository.versions(id)[0]?.version ?? 0) + 1;
            this.repository.demote(id, now, now + overlapMs);
            this.repository.insertVersion({
                secretId: id,
                version,
                sealed: this.seal(id, version, data.value),
                state: 'current',
                retireAt: null,
                setBy: actor,
                setAt: now,
            });
            this.repository.touch(id, now);
            return found;
        });
        this.auditChange(
            actor,
            'update',
            row,
            `version ${version} set; version ${version - 1} ${
                overlapMs ? `readable until ${new Date(now + overlapMs).toISOString()}` : 'retired'
            }`,
        );
        return this.get(id);
    }
    async describe(actor: string, id: string, input: z.input<typeof describeSecretInput>) {
        const data = describeSecretInput.parse(input);
        const row = this.repository.get(id);
        if (!row) {
            throw new SecretError('Secret not found.', 404);
        }
        await this.repository.write('describe workspace secret', () =>
            this.repository.describe(id, data.description, this.now()),
        );
        this.auditChange(actor, 'update', row, 'description changed');
        return this.get(id);
    }
    /** Soft delete (CB-64): hidden and never served; its versions stay sealed. Grants go at once. */
    async remove(actor: string, id: string) {
        const row = this.repository.get(id);
        if (!row) {
            throw new SecretError('Secret not found.', 404);
        }
        const grants = this.repository.grants(id);
        for (const grant of grants) {
            this.auditChange(
                actor,
                'revoke',
                row,
                `grant to ${labelOf(workloadKey(grant.workloadKind, grant.workloadId))} ended with the secret`,
            );
        }
        await this.repository.write('delete workspace secret', () => this.repository.softDelete(id, actor, this.now()));
        this.auditChange(actor, 'delete', row, 'deleted; its versions are kept sealed');
    }
    async grant(actor: string, id: string, appId: string) {
        const row = this.repository.get(id);
        if (!row) {
            throw new SecretError('Secret not found.', 404);
        }
        if (row.scope !== 'workspace') {
            throw new SecretError('A workload secret is its own app’s already.', 400);
        }
        const app = this.workspaceApp(appId);
        if (!this.declared(app.key, row.name)) {
            throw new SecretError(
                `${app.name} doesn’t declare ${row.name} in its manifest, so it can’t be granted.`,
                400,
            );
        }
        if (this.repository.granted(id, app.ref.kind, app.ref.id)) {
            return this.get(id);
        }
        await this.repository.write('grant workspace secret', () =>
            this.repository.insertGrant({
                secretId: id,
                workloadKind: app.ref.kind,
                workloadId: app.ref.id,
                grantedBy: actor,
                grantedAt: this.now(),
            }),
        );
        this.auditChange(actor, 'grant', row, `granted to ${labelOf(app.key)}`);
        return this.get(id);
    }
    async revoke(actor: string, id: string, appId: string) {
        const row = this.repository.get(id);
        if (!row) {
            throw new SecretError('Secret not found.', 404);
        }
        const ref = refOf(appId);
        const removed = await this.repository.write('revoke workspace secret', () =>
            this.repository.deleteGrant(id, ref.kind, ref.id),
        );
        if (removed) {
            this.auditChange(actor, 'revoke', row, `grant to ${labelOf(appId)} revoked`);
        }
        return this.get(id);
    }

    // ---- reads, by workloads --------------------------------------------
    private deny(appId: string, name: string, row: StoredSecret | undefined, why: string, status: 403 | 404 = 403) {
        this.deps.audit({
            actor: readerOf(appId),
            action: 'deny',
            targetKind: 'workspace_secret',
            targetId: row?.id ?? `name:${name}`,
            detail: `${name}: read refused (${why}) ${labelOf(appId)}${this.note}`,
        });
        return {
            ok: false as const,
            status,
            error:
                status === 404
                    ? `Version not available for ${name}.`
                    : `${name} isn’t declared by this ${refOf(appId).kind}, or isn’t set or granted to it.`,
        };
    }
    /**
     * The identity note of the read or check in progress: set and cleared
     * around each one, which never awaits, so calls can't interleave.
     */
    private note = '';
    private noting<T>(appId: string, identityVersion: number | undefined, work: () => T): T {
        this.note = this.identityNote(appId, identityVersion);
        try {
            return work();
        } finally {
            this.note = '';
        }
    }
    /**
     * Whether an app may read `name` now; a refusal is audited like a read's.
     * A plugin passes the identity version it called with.
     */
    check(
        appId: string,
        name: string,
        identityVersion?: number,
    ): { ok: true } | { ok: false; status: 403 | 404; error: string } {
        return this.noting(appId, identityVersion, () => {
            const found = this.resolve(appId, name, undefined, this.now());
            return found.ok ? { ok: true as const } : found;
        });
    }
    private resolve(appId: string, name: string, version: number | undefined, now: number) {
        if (!SECRET_NAME.test(name)) {
            return this.deny(appId, name.slice(0, 64), undefined, 'not a secret name');
        }
        if (!this.workloadOf(appId)) {
            return this.deny(appId, name, undefined, `not a workspace ${refOf(appId).kind}`);
        }
        if (!this.declared(appId, name)) {
            return this.deny(appId, name, undefined, 'undeclared');
        }
        const row = this.servingSecret(appId, name);
        if (!row) {
            return this.deny(appId, name, this.repository.byName(name, 'workspace'), 'not granted or not set');
        }
        const stored =
            version === undefined ? this.repository.current(row.id) : this.repository.version(row.id, version);
        const servable =
            stored && (stored.state === 'current' || (stored.state === 'previous' && (stored.retireAt ?? 0) > now));
        if (!stored || !servable) {
            return this.deny(appId, name, row, `version ${version ?? 'current'} not servable`, 404);
        }
        return { ok: true as const, row, stored };
    }
    /**
     * A workspace app's read of one secret, by its data token's app (the
     * route checks the token): the current version, or a named version
     * still in its overlap window. Audited either way, never the value.
     */
    read(appId: string, name: string, version?: number, identityVersion?: number): ReadOutcome {
        return this.noting(appId, identityVersion, () => this.readNow(appId, name, version));
    }
    private readNow(appId: string, name: string, version?: number): ReadOutcome {
        const now = this.now();
        const found = this.resolve(appId, name, version, now);
        if (!found.ok) {
            return found;
        }
        const { row, stored } = found;
        let opened: Sealed;
        try {
            opened = this.box.open(stored.sealed) as Sealed;
        } catch {
            return this.deny(appId, name, row, 'sealed under a key this server doesn’t have', 404);
        }
        if (opened.secretId !== row.id || opened.version !== stored.version || typeof opened.value !== 'string') {
            return this.deny(appId, name, row, 'sealed value identity mismatch', 404);
        }
        this.remember(appId, opened.value);
        this.repository.stampRead(row.id, stored.version, readerOf(appId), now);
        this.deps.audit({
            actor: readerOf(appId),
            action: 'read',
            targetKind: 'workspace_secret',
            targetId: row.id,
            detail: `${name}: version ${stored.version} read ${labelOf(appId)}${this.note}`,
        });
        const cacheUntil = now + SECRET_CACHE_MS;
        return {
            ok: true,
            secret: {
                value: opened.value,
                version: stored.version,
                expiresAt: stored.state === 'previous' ? Math.min(cacheUntil, stored.retireAt!) : cacheUntil,
            },
        };
    }
    /**
     * A workspace secret Socio itself uses, not a workload (the plugin
     * registry login, `PLUGIN_REGISTRY_AUTH`): the current version's value,
     * or undefined when it isn't set or can't be opened. Workloads never get
     * it this way. The first read of each version in a process is audited,
     * as `reader`; later ones are the same value.
     */
    platformRead(name: string, reader: string): string | undefined {
        const row = this.repository.byName(name, 'workspace');
        const stored = row && this.repository.current(row.id);
        if (!row || !stored) {
            return undefined;
        }
        let opened: Sealed;
        try {
            opened = this.box.open(stored.sealed) as Sealed;
        } catch {
            return undefined;
        }
        if (opened.secretId !== row.id || opened.version !== stored.version || typeof opened.value !== 'string') {
            return undefined;
        }
        const key = `${row.id}:${stored.version}`;
        if (!this.platformReads.has(key)) {
            this.platformReads.add(key);
            this.deps.audit({
                actor: reader,
                action: 'read',
                targetKind: 'workspace_secret',
                targetId: row.id,
                detail: `${name}: version ${stored.version} read by ${reader}`,
            });
        }
        return opened.value;
    }
    private remember(appId: string, text: string) {
        const values = this.served.get(appId) ?? new Map<string, true>();
        values.delete(text);
        values.set(text, true);
        while (values.size > SERVED_KEPT) {
            values.delete(values.keys().next().value!);
        }
        this.served.set(appId, values);
    }
    /**
     * Values to keep out of an app's logs and its socio's computer output
     * (`log-redact.ts`, `secretsFor`): what it read in this process, and
     * what it may read now (its servable versions), so a value is redacted
     * even before the app's first read here.
     */
    redactionValues(appId: string): string[] {
        const found = new Set(this.served.get(appId)?.keys() ?? []);
        if (!this.workloadOf(appId)) {
            return [...found];
        }
        const now = this.now();
        for (const secret of this.declaredOf(appId)) {
            const row = this.servingSecret(appId, secret.name);
            for (const version of row ? this.repository.versions(row.id) : []) {
                if (version.state === 'current' || (version.state === 'previous' && (version.retireAt ?? 0) > now)) {
                    try {
                        const opened = this.box.open(version.sealed) as Sealed;
                        if (typeof opened.value === 'string') {
                            found.add(opened.value);
                        }
                    } catch {
                        // Unreadable here: nothing this process could serve either.
                    }
                }
            }
        }
        return [...found];
    }

    // ---- upkeep ------------------------------------------------------------
    /**
     * Retires previous versions past their window, and removes what belonged
     * to apps that are gone (a workload secret goes with its workload):
     * soft-deletes their workload secrets and ends their grants, audited.
     */
    async sweep() {
        const now = this.now();
        await this.repository.write('retire workspace secret versions', () => this.repository.retireDue(now));
        const live = new Set(this.workloads().map((entry) => entry.key));
        for (const row of this.repository.live()) {
            if (
                row.scope === 'workload' &&
                row.workloadKind &&
                row.workloadId &&
                !live.has(workloadKey(row.workloadKind, row.workloadId))
            ) {
                const kind = row.workloadKind;
                await this.repository.write(`delete a removed ${kind}’s secret`, () =>
                    this.repository.softDelete(row.id, SYSTEM, now, deletedWith(kind, row.workloadId!)),
                );
                this.auditChange(SYSTEM, 'delete', row, `deleted with its ${kind}`);
            }
        }
        for (const grant of this.repository.allGrants()) {
            const key = workloadKey(grant.workloadKind, grant.workloadId);
            if (!live.has(key)) {
                const row = this.repository.get(grant.secretId);
                await this.repository.write(`end a removed ${grant.workloadKind}’s grant`, () =>
                    this.repository.deleteGrant(grant.secretId, grant.workloadKind, grant.workloadId),
                );
                if (row) {
                    this.auditChange(
                        SYSTEM,
                        'revoke',
                        row,
                        `grant to ${labelOf(key)} ended with its ${grant.workloadKind}`,
                    );
                }
            }
        }
        for (const appId of this.served.keys()) {
            if (!live.has(appId)) {
                this.served.delete(appId);
            }
        }
    }

    // ---- the data key (CB-322) ---------------------------------------------
    sealStates() {
        const counts = { current: 0, legacy: 0, previous: 0, unknown: 0 };
        for (const row of this.repository.allSealed()) {
            counts[this.box.state(this.box.valueKey(row.sealed))]++;
        }
        return counts;
    }
    /** Every version, retired and deleted ones too, again under the current key. */
    async reseal() {
        let resealed = 0;
        let unreadable = 0;
        let done = 0;
        for (const row of this.repository.allSealed()) {
            if (++done % RESEAL_BATCH === 0) {
                await nextTurn();
            }
            let next: string | undefined;
            try {
                const opened = this.box.open(row.sealed) as Sealed;
                if (opened.secretId !== row.secretId || opened.version !== row.version) {
                    throw new Error('Secret identity mismatch.');
                }
                next = this.box.reseal(row.sealed);
            } catch {
                unreadable++;
                continue;
            }
            if (
                next &&
                (await this.repository.write('re-seal workspace secret', () =>
                    this.repository.replaceSealed(row.secretId, row.version, row.sealed, next),
                ))
            ) {
                resealed++;
            }
        }
        return { resealed, unreadable };
    }
}
