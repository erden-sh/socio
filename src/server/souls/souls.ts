import type { DatabaseSync } from 'node:sqlite';

import { sqliteData, transaction } from '@socio/data/open';
import { reservedUserId } from '@socio/shared/data-types';
import {
    sameSoul,
    soulFields,
    soulProblem,
    type SoulFields,
    type SoulSource,
    type SoulVersion,
} from '@socio/shared/soul';

import { SoulError, type SoulRepository, type SoulsShape } from './contract.js';
import { SqliteSouls } from './infra/sqlite/souls.js';

/**
 * A socio acting as itself (`dot:<id>`, a shared area's `socio:<id>`): it
 * may never change a Soul, its own or another's, through the human edit path
 * (CB-179). CB-330 lets a socio edit its OWN Soul through a separate,
 * in-process path (`saveSelf`/`restoreSelf`), which checks the actor is the
 * socio itself (`dot:<dotId>`) before reusing the same versioning.
 */
export const socioActor = (actor: string) => actor.startsWith('dot:') || reservedUserId(actor);

/**
 * The actor a socio uses to edit its own Soul (CB-330): `dot:<dotId>`. Used
 * only by `saveSelf`/`restoreSelf`, which check it matches the Soul's dot.
 */
export const selfSoulActor = (dotId: string) => `dot:${dotId}`;
/** Whether `actor` is the socio itself, editing its own Soul (CB-330). */
const selfActor = (actor: string, dotId: string) => actor === selfSoulActor(dotId);

function versionOf(row: Record<string, unknown>): SoulVersion {
    return {
        version: Number(row.version),
        instructions: String(row.instructions),
        voice: String(row.voice ?? ''),
        values: String(row.values ?? ''),
        style: String(row.style ?? ''),
        createdAt: Number(row.createdAt),
        createdBy: String(row.createdBy),
        source: row.source as SoulSource,
        restoredFrom: row.restoredFrom === null || row.restoredFrom === undefined ? null : Number(row.restoredFrom),
    };
}

/**
 * Socios' Souls (CB-179, `socio_souls`, workspace migration 17): every
 * version of each, never changed or removed. The newest is the one in
 * use; `dots.instructions` keeps a copy of its standing instructions, so a
 * rollback to a build before the Soul still finds them. On the workspace's
 * connection, beside `dots`: a socio and its first Soul are made in one
 * transaction (`WorkspaceStore.createDot`).
 */
export class SoulStore implements SoulsShape {
    /** Its writes (CB-110); the reads stay here. */
    private repository: SoulRepository;
    constructor(
        private db: DatabaseSync,
        /** Records a Soul change in the socio's own audit (names only). */
        private audit: (dotId: string, actor: string, detail: string, now: number) => void,
    ) {
        this.repository = new SqliteSouls(sqliteData(db));
    }

    /** The Soul in use: the newest version. */
    current(dotId: string): SoulVersion | undefined {
        const row = this.db.prepare('SELECT * FROM socio_souls WHERE dotId=? ORDER BY version DESC LIMIT 1').get(dotId);
        return row ? versionOf(row) : undefined;
    }

    /** Every version, newest first. */
    history(dotId: string): SoulVersion[] {
        return this.db
            .prepare('SELECT * FROM socio_souls WHERE dotId=? ORDER BY version DESC')
            .all(dotId)
            .map(versionOf);
    }

    /** One version, or undefined. */
    version(dotId: string, version: number): SoulVersion | undefined {
        const row = this.db.prepare('SELECT * FROM socio_souls WHERE dotId=? AND version=?').get(dotId, version);
        return row ? versionOf(row) : undefined;
    }

    /**
     * Adds the next version and copies its standing instructions to the
     * socio's row. Runs inside the caller's transaction. Refuses a socio
     * actor, unless `allowSelf` and the actor is the socio itself
     * (`dot:<dotId>`, CB-330); the caller checks the parts (`soulProblem`),
     * as the routes do.
     */
    append(
        dotId: string,
        input: Partial<SoulFields>,
        actor: string,
        source: Exclude<SoulSource, 'migrated'>,
        { restoredFrom = null as number | null, now = Date.now(), allowSelf = false } = {},
    ): SoulVersion {
        if (socioActor(actor) && !(allowSelf && selfActor(actor, dotId))) {
            throw new SoulError({ message: 'A socio can’t change its Soul.', status: 403 });
        }
        const fields = soulFields(input);
        const version = (this.current(dotId)?.version ?? 0) + 1;
        this.repository.appendNow({
            dotId,
            version,
            instructions: fields.instructions,
            voice: fields.voice,
            values: fields.values,
            style: fields.style,
            createdAt: now,
            createdBy: actor,
            source,
            restoredFrom,
        });
        return this.version(dotId, version)!;
    }

    /**
     * An edit: a new version when the parts changed, else the one in use.
     * `baseVersion`, the version the editor started from, must still be the
     * one in use (409 otherwise), so an edit never quietly undoes another.
     * The route checks who may edit (`canEditSoul`). `allowSelf` (CB-330)
     * lets a socio edit its OWN Soul through `saveSelf`; the actor must then
     * be `dot:<dotId>`.
     */
    save(
        dotId: string,
        input: Partial<SoulFields>,
        actor: string,
        baseVersion?: number,
        now = Date.now(),
        { allowSelf = false } = {},
    ): Promise<SoulVersion> {
        return transaction(this.db, 'save soul', () => {
            const current = this.inUse(dotId, baseVersion, actor, allowSelf);
            const fields = soulFields(input);
            const problem = soulProblem(fields);
            if (problem) {
                throw new SoulError({ message: problem, status: 400 });
            }
            if (current && sameSoul(current, fields)) {
                return current;
            }
            const saved = this.append(dotId, fields, actor, 'edited', { now, allowSelf });
            this.audit(dotId, actor, `Soul v${saved.version}`, now);
            return saved;
        });
    }

    /** Puts an earlier version back, as a new version (history is kept). */
    restore(
        dotId: string,
        version: number,
        actor: string,
        baseVersion?: number,
        now = Date.now(),
        { allowSelf = false } = {},
    ): Promise<SoulVersion> {
        return transaction(this.db, 'restore soul', () => {
            const current = this.inUse(dotId, baseVersion, actor, allowSelf);
            const earlier = this.version(dotId, version);
            if (!earlier) {
                throw new SoulError({ message: 'That version doesn’t exist.', status: 404 });
            }
            if (current && sameSoul(current, earlier)) {
                return current;
            }
            const saved = this.append(dotId, earlier, actor, 'restored', {
                restoredFrom: version,
                now,
                allowSelf,
            });
            this.audit(dotId, actor, `Soul v${saved.version} (restored v${version})`, now);
            return saved;
        });
    }

    /**
     * A socio edits its OWN Soul (CB-330): the actor must be `dot:<dotId>`
     * (the socio itself, for this dot). Reuses `save`'s versioning — a new
     * version when the parts changed, a 409 on a stale `baseVersion`, the
     * same validation — and records the socio as the editor. A socio may
     * not edit another socio's Soul through this path: the actor must
     * match `dotId`.
     */
    async saveSelf(dotId: string, input: Partial<SoulFields>, actor: string, baseVersion?: number, now = Date.now()) {
        if (!selfActor(actor, dotId)) {
            throw new SoulError({ message: 'A socio can edit only its own Soul.', status: 403 });
        }
        return this.save(dotId, input, actor, baseVersion, now, { allowSelf: true });
    }

    /**
     * A socio restores an earlier version of its OWN Soul (CB-330): the
     * actor must be `dot:<dotId>`. Reuses `restore`'s versioning — a new
     * version, history kept.
     */
    async restoreSelf(dotId: string, version: number, actor: string, baseVersion?: number, now = Date.now()) {
        if (!selfActor(actor, dotId)) {
            throw new SoulError({ message: 'A socio can restore only its own Soul.', status: 403 });
        }
        return this.restore(dotId, version, actor, baseVersion, now, { allowSelf: true });
    }

    private inUse(dotId: string, baseVersion: number | undefined, actor: string, allowSelf = false) {
        // The human edit path never lets a socio edit a Soul (CB-179). CB-330's
        // self-edit path (`saveSelf`/`restoreSelf`) allows it, but only for the
        // socio itself (`dot:<dotId>`); any other socio actor is still refused.
        if (socioActor(actor) && !(allowSelf && selfActor(actor, dotId))) {
            throw new SoulError({ message: 'A socio can’t change its Soul.', status: 403 });
        }
        if (!this.db.prepare('SELECT 1 FROM dots WHERE id=? AND deletedAt IS NULL').get(dotId)) {
            throw new SoulError({ message: 'Socio not found.', status: 404 });
        }
        const current = this.current(dotId);
        if (baseVersion !== undefined && (current?.version ?? 0) !== baseVersion) {
            throw new SoulError({
                message: 'Someone changed this Soul since you opened it. Reload to see their version.',
                status: 409,
            });
        }
        return current;
    }
}
