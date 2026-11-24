import { createHash, randomUUID } from 'node:crypto';

import { and, asc, desc, eq, isNull, type SQL } from 'drizzle-orm';

import { skillDocument } from '@socio/shared/chat/chat-skills';

import type {
    SkillContent,
    SkillProvenance,
    SkillRevision,
    WorkspaceSkill,
    WorkspaceSkillsRepository,
} from '../../contract.js';
import { provenanceKey, provenanceOf } from '../../domain/repositories.js';

import { SqliteRepository } from './base.js';
import { chatSkillRevisions as r, chatSkills as s } from './schema.js';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** A skill at its current revision. */
const current = {
    id: s.id,
    name: s.name,
    description: r.description,
    instructions: r.instructions,
    mode: r.mode,
    revision: s.revision,
    sha256: r.sha256,
    source: r.source,
    sourceUrl: r.sourceUrl,
    sourcePath: r.sourcePath,
    sourceRef: r.sourceRef,
    sourceCommit: r.sourceCommit,
    sourceMetadata: r.sourceMetadata,
    createdAt: s.createdAt,
    createdBy: s.createdBy,
    updatedAt: s.updatedAt,
    updatedBy: s.updatedBy,
};

/** A revision's content and provenance, without its skill's id. */
const revision = {
    revision: r.revision,
    description: r.description,
    instructions: r.instructions,
    mode: r.mode,
    sha256: r.sha256,
    restoredFrom: r.restoredFrom,
    createdAt: r.createdAt,
    createdBy: r.createdBy,
    source: r.source,
    sourceUrl: r.sourceUrl,
    sourcePath: r.sourcePath,
    sourceRef: r.sourceRef,
    sourceCommit: r.sourceCommit,
    sourceMetadata: r.sourceMetadata,
};

/**
 * The workspace's skills (CB-143): a save, import or rollback reads the
 * skill and adds its revision in one unit of work, so concurrent saves of
 * the same content keep one revision.
 */
export class SqliteSkillsRepository extends SqliteRepository implements WorkspaceSkillsRepository {
    /** Live skills at their current revision, and those `where` says. */
    private live(where?: SQL) {
        return this.db
            .select(current)
            .from(s)
            .innerJoin(r, and(eq(r.skillId, s.id), eq(r.revision, s.revision)))
            .where(and(isNull(s.deletedAt), where));
    }

    async list(): Promise<WorkspaceSkill[]> {
        return this.live().orderBy(asc(s.name));
    }

    async get(name: string): Promise<WorkspaceSkill | undefined> {
        return this.live(eq(s.name, name)).get();
    }

    private async liveId(name: string) {
        return this.db
            .select({ id: s.id, revision: s.revision })
            .from(s)
            .where(and(eq(s.name, name), isNull(s.deletedAt)))
            .get();
    }

    /** A new revision of `content`, made current: inside the caller's unit. */
    private async addRevision(
        content: SkillContent,
        by: string,
        now: number,
        restoredFrom: number | null = null,
        source?: SkillProvenance,
    ) {
        const digest = sha256(skillDocument(content));
        let skill = await this.liveId(content.name);
        if (!skill) {
            skill = { id: randomUUID(), revision: 0 };
            await this.db.insert(s).values({
                id: skill.id,
                name: content.name,
                revision: 1,
                createdAt: now,
                createdBy: by,
                updatedAt: now,
                updatedBy: by,
            });
        }
        const next = skill.revision + 1;
        await this.db.insert(r).values({
            skillId: skill.id,
            revision: next,
            description: content.description,
            instructions: content.instructions,
            mode: content.mode,
            sha256: digest,
            source: source ? 'git' : 'workspace',
            restoredFrom,
            createdAt: now,
            createdBy: by,
            sourceUrl: source?.url ?? null,
            sourcePath: source?.path ?? null,
            sourceRef: source?.ref ?? null,
            sourceCommit: source?.commit ?? null,
            sourceMetadata: source
                ? JSON.stringify({
                      sha256: source.sha256,
                      license: source.license,
                      licenseText: source.licenseText,
                      locallyModified: !!source.locallyModified,
                  })
                : null,
        });
        await this.db.update(s).set({ revision: next, updatedAt: now, updatedBy: by }).where(eq(s.id, skill.id));
    }

    save(skill: SkillContent, by: string, now = Date.now()) {
        // A model may save a skill beside a Board write in the same step. Queue
        // behind that unit, and compare inside ours so repeated concurrent saves
        // of identical content still keep one revision.
        return this.write('save workspace skill', async () => {
            const found = await this.get(skill.name);
            if (found?.sha256 !== sha256(skillDocument(skill))) {
                const source = found && provenanceOf(found);
                await this.addRevision(skill, by, now, null, source ? { ...source, locallyModified: true } : undefined);
            }
            return (await this.get(skill.name))!;
        });
    }

    import(
        skill: SkillContent,
        source: SkillProvenance,
        expected: Pick<WorkspaceSkill, 'id' | 'revision' | 'sha256'> | null,
        by: string,
        now = Date.now(),
    ) {
        return this.write('import workspace skill', async () => {
            const found = await this.get(skill.name);
            if (
                (found?.revision ?? null) !== (expected?.revision ?? null) ||
                found?.id !== expected?.id ||
                found?.sha256 !== expected?.sha256
            ) {
                throw new Error('The workspace skill changed since preview. Preview the import again.');
            }
            const prior = found && provenanceOf(found);
            if (
                !found ||
                found.sha256 !== sha256(skillDocument(skill)) ||
                provenanceKey(prior) !== provenanceKey(source)
            ) {
                await this.addRevision(skill, by, now, null, source);
            }
            return (await this.get(skill.name))!;
        });
    }

    async revisions(name: string): Promise<SkillRevision[]> {
        const skill = await this.liveId(name);
        if (!skill) {
            return [];
        }
        return this.db.select(revision).from(r).where(eq(r.skillId, skill.id)).orderBy(desc(r.revision));
    }

    rollback(name: string, to: number, by: string, now = Date.now()) {
        return this.write('roll back workspace skill', async () => {
            const found = await this.get(name);
            if (!found) {
                return undefined;
            }
            const earlier = await this.db
                .select(revision)
                .from(r)
                .where(and(eq(r.skillId, found.id), eq(r.revision, to)))
                .get();
            if (!earlier) {
                return undefined;
            }
            // Content and immutable source provenance are restored together.
            if (
                earlier.sha256 !== found.sha256 ||
                provenanceKey(provenanceOf(earlier)) !== provenanceKey(provenanceOf(found))
            ) {
                await this.addRevision({ ...earlier, name }, by, now, to, provenanceOf(earlier));
            }
            return (await this.get(name))!;
        });
    }

    remove(name: string, by: string, now = Date.now()) {
        return this.write('remove workspace skill', async () => {
            const { changes } = await this.db
                .update(s)
                .set({ deletedAt: now, deletedBy: by })
                .where(and(eq(s.name, name), isNull(s.deletedAt)));
            return Number(changes) > 0;
        });
    }
}
