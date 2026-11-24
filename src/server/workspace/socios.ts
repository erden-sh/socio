import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { transactionSync } from '@socio/data/open';
import { LIVE, unstamped } from '@socio/data/soft-delete';
import type { ModelChoice } from '@socio/shared/inference';
import { validateLearningSettings } from '@socio/shared/learning';
import { characterOf, isLocalId, type LocalId } from '@socio/shared/mascot';
import type { SoulFields, SoulSource, SoulVersion } from '@socio/shared/soul';
import type { Dot } from '@socio/shared/types';

import type { AccessChanges } from './access-changes.js';
import type { DotAuditEntry, DotPatch, SociosShape, SpacesShape } from './contract.js';
import { choiceOf, choiceText } from './rows.js';

const onOff = (value: unknown) => (value ? 'on' : 'off');
/** The settings an update changed, for the audit: names and on/off only. */
export function dotChanges(before: Dot, after: Dot): string[] {
    const changes: string[] = [];
    const flag = (label: string, a: unknown, b: unknown) => {
        if (!!a !== !!b) {
            changes.push(`${label}: ${onOff(a)} → ${onOff(b)}`);
        }
    };
    if (before.name !== after.name) {
        changes.push('name');
    }
    // A Soul edit says which version, never its text (CB-179).
    if ((before.soul?.version ?? 0) !== (after.soul?.version ?? 0)) {
        changes.push(`Soul v${after.soul?.version ?? 0}`);
    } else if (before.instructions !== after.instructions) {
        changes.push('instructions');
    }
    flag('public-page research', before.researchAllowed, after.researchAllowed);
    flag('saved memories', before.memoryAllowed, after.memoryAllowed);
    flag('Improvements board filing', before.issuesAllowed, after.issuesAllowed);
    flag('published skills', before.skillDeliveryEnabled, after.skillDeliveryEnabled);
    if ((before.learningContainerId ?? null) !== (after.learningContainerId ?? null)) {
        changes.push('Learning container');
    }
    if (before.spaceId !== after.spaceId) {
        changes.push('default Space');
    }
    if (JSON.stringify(before.spaceIds) !== JSON.stringify(after.spaceIds)) {
        changes.push('Space access');
    }
    if (JSON.stringify(before.inference ?? null) !== JSON.stringify(after.inference ?? null)) {
        changes.push('model');
    }
    if (characterOf(before) !== characterOf(after)) {
        changes.push(`character: ${characterOf(before)} → ${characterOf(after)}`);
    }
    return changes;
}

/** A chosen Local must be one of the cast (CB-256). */
function validateCharacter(character: unknown) {
    if (character !== null && character !== undefined && !isLocalId(character)) {
        throw new Error('Choose one of the socio characters.');
    }
}

/**
 * What the Socios slice asks of each socio's Soul (`SoulStore`, souls/souls.ts,
 * which the workspace builds on the same connection): the version in use,
 * and the next one, written inside the caller's transaction.
 */
export interface SocioSouls {
    current(dotId: string): SoulVersion | undefined;
    append(
        dotId: string,
        input: Partial<SoulFields>,
        actor: string,
        source: Exclude<SoulSource, 'migrated'>,
        options?: { now?: number },
    ): SoulVersion;
}

/**
 * The `Socios` slice: the socios, their Space grants
 * (`dot_spaces`) and their own audit (`dot_audit`), on the workspace's
 * connection. Moved from `WorkspaceStore` as it was; a socio's Soul and the
 * live Spaces come in prepared.
 */
export class SqliteSocios implements SociosShape {
    constructor(
        private db: DatabaseSync,
        private deps: {
            /** Each socio's Soul and its versions (CB-179). */
            souls: SocioSouls;
            /** The live Spaces a socio's grants must name. */
            spaces: Pick<SpacesShape, 'spaces'>;
            changes: AccessChanges;
        },
    ) {}
    private dotOf(row: Record<string, unknown>): Dot {
        // The Soul in use is the socio's instructions (CB-179): every reader
        // of `instructions` (prompts, calls, approvals, views) gets it.
        const soul = this.deps.souls.current(String(row.id));
        return {
            ...unstamped(row),
            ...(soul ? { instructions: soul.instructions, soul } : {}),
            spaceIds: this.db
                .prepare('SELECT spaceId FROM dot_spaces WHERE dotId=? ORDER BY spaceId')
                .all(String(row.id))
                .map((grant) => String(grant.spaceId)),
            researchAllowed: !!row.researchAllowed,
            memoryAllowed: !!row.memoryAllowed,
            skillDeliveryEnabled: !!row.skillDeliveryEnabled,
            issuesAllowed: !!row.issuesAllowed,
            ownerId: row.ownerId === null || row.ownerId === undefined ? null : String(row.ownerId),
            archivedAt: row.archivedAt === null || row.archivedAt === undefined ? null : Number(row.archivedAt),
            archivedBy: row.archivedBy === null || row.archivedBy === undefined ? null : String(row.archivedBy),
            inference: choiceOf(row.inference),
            character: characterOf({
                id: String(row.id),
                character: row.character as string | null,
            }),
        } as unknown as Dot;
    }
    /**
     * Every live Dot, archived ones too: an archived Dot still exists (its
     * grants, apps, approvals and names stay). Lists people choose from use
     * `dotsFor` and `companyDots`, which leave archived Dots out.
     */
    dots(): Dot[] {
        return this.db
            .prepare(`SELECT * FROM dots WHERE ${LIVE} ORDER BY createdAt`)
            .all()
            .map((row) => this.dotOf(row));
    }
    /** Every Dot, archived ones too, company Dots first (admins' list). */
    allDots(): Dot[] {
        return this.db
            .prepare(`SELECT * FROM dots WHERE ${LIVE} ORDER BY ownerId IS NOT NULL, createdAt`)
            .all()
            .map((row) => this.dotOf(row));
    }
    /** The company's live Dots: shared by the team, managed by admins. */
    companyDots(): Dot[] {
        return this.db
            .prepare(`SELECT * FROM dots WHERE ownerId IS NULL AND ${LIVE} AND archivedAt IS NULL ORDER BY createdAt`)
            .all()
            .map((row) => this.dotOf(row));
    }
    /**
     * The Dots `userId` may see: the company's, then their own. Archived
     * ones come last (`archived`), so their chats still show who they were.
     */
    dotsFor(userId: string, { archived = false } = {}): Dot[] {
        return this.db
            .prepare(
                `SELECT * FROM dots WHERE (ownerId IS NULL OR ownerId=?) AND ${LIVE}${archived ? '' : ' AND archivedAt IS NULL'} ORDER BY archivedAt IS NOT NULL, ownerId IS NOT NULL, createdAt`,
            )
            .all(userId)
            .map((row) => this.dotOf(row));
    }
    /** Whether `userId` may use the Dot: a company Dot or their own, not archived. */
    canUseDot(userId: string, dotId: string) {
        const dot = this.dot(dotId);
        return !!dot && !dot.archivedAt && (!dot.ownerId || dot.ownerId === userId);
    }
    /** Who made, changed, archived and unarchived a Dot, oldest first. */
    dotAudit(dotId: string): DotAuditEntry[] {
        return this.db
            .prepare('SELECT actor, action, detail, createdAt FROM dot_audit WHERE dotId=? ORDER BY id')
            .all(dotId)
            .map((row) => ({
                actor: String(row.actor),
                action: row.action as DotAuditEntry['action'],
                detail: String(row.detail),
                createdAt: Number(row.createdAt),
            }));
    }
    /**
     * A line of the Dot's own audit. Not part of the slice: the workspace's
     * own writers (a Soul's versions, a Space made for a socio) add theirs.
     */
    auditDot(dotId: string, actor: string, action: DotAuditEntry['action'], detail = '', now = Date.now()) {
        this.db
            .prepare('INSERT INTO dot_audit (dotId, actor, action, detail, createdAt) VALUES (?, ?, ?, ?, ?)')
            .run(dotId, actor, action, detail, now);
    }
    /** Fails loudly while another context's unit of work is open (CB-110). */
    private inTransaction(fn: () => void) {
        transactionSync(this.db, 'socio change', fn);
    }
    /**
     * Archives a Dot: it leaves every list and picker and can't start chats or
     * turns; its chats, filings, goals and audit stay. Never a delete.
     */
    archiveDot(id: string, actor: string, now = Date.now()) {
        const dot = this.dot(id);
        if (!dot) {
            throw new Error('Socio not found.');
        }
        if (dot.archivedAt) {
            return dot;
        }
        this.inTransaction(() => {
            this.db.prepare('UPDATE dots SET archivedAt=?, archivedBy=? WHERE id=?').run(now, actor, id);
            this.auditDot(id, actor, 'archive', '', now);
        });
        this.deps.changes.emit({ socioId: id });
        return this.dot(id)!;
    }
    /** Brings an archived Dot back; its paused schedules stay paused. */
    unarchiveDot(id: string, actor: string, now = Date.now()) {
        const dot = this.dot(id);
        if (!dot) {
            throw new Error('Socio not found.');
        }
        if (!dot.archivedAt) {
            return dot;
        }
        this.inTransaction(() => {
            this.db.prepare('UPDATE dots SET archivedAt=NULL, archivedBy=NULL WHERE id=?').run(id);
            this.auditDot(id, actor, 'unarchive', '', now);
        });
        return this.dot(id)!;
    }
    /** How many Dots of their own `userId` has in use (not archived). */
    personalDotCount(userId: string) {
        return Number(
            (
                this.db
                    .prepare(`SELECT COUNT(*) AS n FROM dots WHERE ownerId=? AND ${LIVE} AND archivedAt IS NULL`)
                    .get(userId) as { n: number }
            ).n,
        );
    }
    /** A live Dot. One query, not every Dot: views ask once per row. */
    dot(id: string) {
        const row = this.db.prepare(`SELECT * FROM dots WHERE id=? AND ${LIVE}`).get(id);
        return row ? this.dotOf(row) : undefined;
    }
    createDot(
        spaceId: string,
        name: string,
        instructions: string,
        researchAllowed: boolean,
        memoryAllowed: boolean,
        spaceIds: string[] = [spaceId],
        learningContainerId: string | null = null,
        skillDeliveryEnabled = false,
        inference: ModelChoice | null = null,
        issuesAllowed = false,
        /** A person's own Dot; null (default): the company's. */
        ownerId: string | null = null,
        /** Who made it, for the Dot's audit: a user id, or `system`. */
        actor = 'system',
        /** Its Local (CB-256); null: the one its id hashes to. */
        character: LocalId | null = null,
    ): Dot {
        const id = randomUUID();
        this.validateSpaceAccess(spaceId, spaceIds);
        validateCharacter(character);
        validateLearningSettings(learningContainerId, skillDeliveryEnabled);
        const dot: Dot = {
            id,
            spaceId,
            spaceIds: [...new Set(spaceIds)].sort(),
            name,
            instructions,
            researchAllowed,
            memoryAllowed,
            learningContainerId,
            skillDeliveryEnabled,
            issuesAllowed,
            ownerId,
            inference,
            character: characterOf({ id, character }),
            createdAt: Date.now(),
        };
        transactionSync(this.db, 'create socio', () => {
            this.db
                .prepare(
                    'INSERT INTO dots (id, spaceId, name, instructions, researchAllowed, memoryAllowed, createdAt, learningContainerId, skillDeliveryEnabled, inference, issuesAllowed, ownerId, character) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                )
                .run(
                    dot.id,
                    spaceId,
                    name,
                    instructions,
                    +researchAllowed,
                    +memoryAllowed,
                    dot.createdAt,
                    learningContainerId,
                    +skillDeliveryEnabled,
                    choiceText(inference),
                    +issuesAllowed,
                    ownerId,
                    dot.character ?? null,
                );
            for (const id of dot.spaceIds) {
                this.db.prepare('INSERT INTO dot_spaces VALUES (?, ?)').run(dot.id, id);
            }
            // Its Soul's first version: the instructions it was made with.
            this.deps.souls.append(dot.id, { instructions }, actor, 'created', {
                now: dot.createdAt,
            });
            this.auditDot(
                dot.id,
                actor,
                'create',
                `${ownerId ? 'personal' : 'company'}${character ? `; character: ${character}` : ''}`,
            );
        });
        const soul = this.deps.souls.current(dot.id)!;
        return { ...dot, instructions: soul.instructions, soul };
    }
    /**
     * Whether a socio has the Space (`dot_spaces`): its grant only. What it
     * may read in a chat is `socioReads`, which also asks its readers.
     */
    canAccessSpace(dotId: string, spaceId: string) {
        return !!this.db.prepare('SELECT 1 FROM dot_spaces WHERE dotId=? AND spaceId=?').get(dotId, spaceId);
    }
    /**
     * A socio's Spaces: its default among them, each a live Space. A grant it
     * has already (`kept`) stays even while its Space is deleted (CB-277), so
     * a restored Space is the socio's again; its default is always live.
     */
    private validateSpaceAccess(defaultSpace: string, spaceIds: string[], kept: readonly string[] = []) {
        const live = new Set(this.deps.spaces.spaces().map((space) => space.id));
        if (
            !spaceIds.includes(defaultSpace) ||
            !live.has(defaultSpace) ||
            spaceIds.some((id) => !live.has(id) && !kept.includes(id))
        ) {
            throw new Error('Space access must include a valid default destination.');
        }
    }
    updateDot(
        id: string,
        patch: DotPatch,
        /** Who changed it, for the Dot's audit: a user id, or `system`. */
        actor = 'system',
    ): Dot {
        const current = this.dot(id);
        if (!current) {
            throw new Error('Socio not found.');
        }
        const defaultSpace = patch.spaceId ?? current.spaceId;
        const spaceIds = patch.spaceIds ?? current.spaceIds;
        this.validateSpaceAccess(defaultSpace, spaceIds, current.spaceIds);
        const learningContainerId =
            patch.learningContainerId === undefined ? (current.learningContainerId ?? null) : patch.learningContainerId;
        const skillDeliveryEnabled = patch.skillDeliveryEnabled ?? current.skillDeliveryEnabled ?? false;
        validateLearningSettings(learningContainerId, skillDeliveryEnabled);
        validateCharacter(patch.character);
        transactionSync(this.db, 'update socio', () => {
            this.db
                .prepare(
                    'UPDATE dots SET name=?, researchAllowed=?, memoryAllowed=?, learningContainerId=?, skillDeliveryEnabled=?, issuesAllowed=? WHERE id=?',
                )
                .run(
                    patch.name,
                    +patch.researchAllowed,
                    +patch.memoryAllowed,
                    learningContainerId,
                    +skillDeliveryEnabled,
                    +(patch.issuesAllowed ?? current.issuesAllowed ?? false),
                    id,
                );
            // A character is stored only once it differs, so an unchanged socio
            // keeps following its id's look (a whole Dot spread back in carries
            // its character).
            const character = patch.character && patch.character !== characterOf(current) ? patch.character : null;
            this.db
                .prepare('UPDATE dots SET spaceId=?, character=COALESCE(?, character) WHERE id=?')
                .run(defaultSpace, character, id);
            if (patch.inference !== undefined) {
                this.db.prepare('UPDATE dots SET inference=? WHERE id=?').run(choiceText(patch.inference), id);
            }
            if (patch.instructions !== undefined && patch.instructions.trim() !== current.instructions.trim()) {
                this.deps.souls.append(id, { ...current.soul, instructions: patch.instructions }, actor, 'edited');
            }
            this.db.prepare('DELETE FROM dot_spaces WHERE dotId=?').run(id);
            for (const space of new Set(spaceIds)) {
                this.db.prepare('INSERT INTO dot_spaces VALUES (?, ?)').run(id, space);
            }
            const changed = dotChanges(current, this.dot(id)!);
            if (changed.length) {
                this.auditDot(id, actor, 'update', changed.join('; '));
            }
        });
        this.deps.changes.emit({ socioId: id });
        return this.dot(id)!;
    }
}
