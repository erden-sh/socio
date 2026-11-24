import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { sqliteData } from '@socio/data/open';

import type {
    ContainerRevision,
    SkillFile,
    SkillRevision,
    SkillsShape,
    SkillsSnapshot as Snapshot,
} from './contract.js';
import type { PublishedSkillRepository } from './domain/repositories.js';
import { SqlitePublishedSkills } from './infra/sqlite/evidence.js';
import { storeZip } from './zip.js';

/**
 * Published skills, per learning container, delivered through CopilotKit's
 * MIT skill-delivery path (`learnedSkills` with a local client; see
 * learning/delivery.ts).
 *
 * - A skill revision is immutable: `SKILL.md` plus optional text files.
 * - Each publish or revoke creates a new container revision: the set of
 *   (skill, revision) pairs delivered together.
 * - A container can be pinned to an earlier container revision; delivery uses
 *   the pin, else the latest.
 * - A revoked skill is one an earlier container revision delivered and the
 *   latest doesn't; `revoked()` lists them. Publishing it again ends that.
 * - `snapshot()` builds the runtime's zip deterministically: `manifest.json`
 *   (schemaVersion 1, skills by name, files by path, size and SHA-256), then
 *   `<skill>/<path>` entries; the etag is the quoted SHA-256 of the bytes.
 */
/** A container's skills as the runtime's zip; `SkillsSnapshot` in the contract. */

export const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const MAX_FILES = 20;
const MAX_FILE_BYTES = 64 * 1024;
const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
const byteOrder = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));

/** A published SKILL.md: the reviewed body under name and description frontmatter. */
export function skillMdFile(name: string, description: string, body: string) {
    return `---\nname: ${name}\ndescription: ${description.replace(/\n/g, ' ')}\n---\n${body}\n`;
}
/** A SKILL.md without its frontmatter, if it has one. */
export function skillMdBody(content: string) {
    return content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '');
}

function validatePath(path: string) {
    const segments = path.split('/');
    if (
        !path ||
        path.length > 200 ||
        path.includes('\\') ||
        [...path].some((ch) => ch.charCodeAt(0) < 0x20 || ch === '\u007f') ||
        /^[A-Za-z]:/.test(path) ||
        segments.some((part) => !part || part === '.' || part === '..')
    ) {
        throw new Error(`Invalid skill file path: ${path}`);
    }
}

export class SkillStore implements SkillsShape {
    /** Its writes (CB-110); the reads stay here. */
    private repository: PublishedSkillRepository;
    constructor(private db: DatabaseSync) {
        this.repository = new SqlitePublishedSkills(sqliteData(db));
    }

    /** Saves a new immutable revision of a skill (not yet published). */
    saveRevision(
        containerId: string,
        name: string,
        description: string,
        files: SkillFile[],
        createdBy: string,
        now = Date.now(),
    ): SkillRevision {
        if (!SKILL_NAME.test(name)) {
            throw new Error('Skill names use lowercase letters, digits and hyphens (up to 63).');
        }
        const text = description.trim();
        if (!text || text.length > 500) {
            throw new Error('Describe the skill in 1 to 500 characters.');
        }
        if (!files.some((file) => file.path === 'SKILL.md')) {
            throw new Error('A skill needs a SKILL.md file.');
        }
        if (files.length > MAX_FILES) {
            throw new Error(`A skill can have at most ${MAX_FILES} files.`);
        }
        const seen = new Set<string>();
        for (const file of files) {
            validatePath(file.path);
            if (seen.has(file.path)) {
                throw new Error(`Duplicate skill file: ${file.path}`);
            }
            seen.add(file.path);
            if (Buffer.byteLength(file.content) > MAX_FILE_BYTES) {
                throw new Error(`Skill file is too large: ${file.path}`);
            }
        }
        const sorted = [...files].sort((a, b) => byteOrder(a.path, b.path));
        const latest = this.db
            .prepare('SELECT MAX(revision) AS n FROM learning_skill_revisions WHERE containerId=? AND name=?')
            .get(containerId, name) as { n: number | null };
        const revision: SkillRevision = {
            id: randomUUID(),
            containerId,
            name,
            revision: (latest.n ?? 0) + 1,
            description: text,
            files: sorted,
            createdAt: now,
            createdBy,
        };
        this.repository.insertRevisionNow(revision);
        return revision;
    }

    skillRevision(id: string): SkillRevision | undefined {
        const row = this.db.prepare('SELECT * FROM learning_skill_revisions WHERE id=?').get(id) as
            | (Omit<SkillRevision, 'files'> & { files: string })
            | undefined;
        return row ? { ...row, files: JSON.parse(row.files) } : undefined;
    }
    /** Every revision of a skill, newest first. */
    history(containerId: string, name: string): SkillRevision[] {
        return (
            this.db
                .prepare(
                    'SELECT id FROM learning_skill_revisions WHERE containerId=? AND name=? ORDER BY revision DESC',
                )
                .all(containerId, name) as Array<{ id: string }>
        ).map((row) => this.skillRevision(row.id)!);
    }

    latest(containerId: string): ContainerRevision | undefined {
        const row = this.db
            .prepare('SELECT * FROM learning_container_revisions WHERE containerId=? ORDER BY revision DESC LIMIT 1')
            .get(containerId) as (Omit<ContainerRevision, 'skills'> & { skills: string }) | undefined;
        return row ? { ...row, skills: JSON.parse(row.skills) } : undefined;
    }
    containerRevision(containerId: string, revision: number): ContainerRevision | undefined {
        const row = this.db
            .prepare('SELECT * FROM learning_container_revisions WHERE containerId=? AND revision=?')
            .get(containerId, revision) as (Omit<ContainerRevision, 'skills'> & { skills: string }) | undefined;
        return row ? { ...row, skills: JSON.parse(row.skills) } : undefined;
    }
    /** The container revision delivered to Dots: the pin, else the latest. */
    current(containerId: string): ContainerRevision | undefined {
        const pin = this.pinned(containerId);
        return pin === undefined ? this.latest(containerId) : this.containerRevision(containerId, pin);
    }
    /** Published skills (latest container revision) with their revisions. */
    published(containerId: string): SkillRevision[] {
        return (this.latest(containerId)?.skills ?? []).map((skill) => this.skillRevision(skill.revisionId)!);
    }
    /**
     * Skills an earlier container revision delivered and the latest doesn't
     * (revoked), with the description of the revision last delivered, most
     * recently revoked first.
     */
    revoked(containerId: string): Array<{ name: string; description: string; revokedAt: number }> {
        const rows = this.db
            .prepare(
                'SELECT revision, skills, createdAt FROM learning_container_revisions WHERE containerId=? ORDER BY revision',
            )
            .all(containerId) as Array<{
            revision: number;
            skills: string;
            createdAt: number;
        }>;
        let previous = new Map<string, string>();
        const gone = new Map<string, { revisionId: string; revokedAt: number; order: number }>();
        for (const row of rows) {
            const current = new Map(
                (JSON.parse(row.skills) as ContainerRevision['skills']).map((skill) => [skill.name, skill.revisionId]),
            );
            for (const [name, revisionId] of previous) {
                if (!current.has(name)) {
                    gone.set(name, {
                        revisionId,
                        revokedAt: row.createdAt,
                        order: row.revision,
                    });
                }
            }
            for (const name of current.keys()) {
                gone.delete(name);
            }
            previous = current;
        }
        return [...gone]
            .sort((a, b) => b[1].order - a[1].order)
            .map(([name, { revisionId, revokedAt }]) => ({
                name,
                description: this.skillRevision(revisionId)?.description ?? '',
                revokedAt,
            }));
    }
    containers(): string[] {
        return (
            this.db.prepare('SELECT DISTINCT containerId FROM learning_container_revisions ORDER BY 1').all() as Array<{
                containerId: string;
            }>
        ).map((row) => row.containerId);
    }

    private commit(
        containerId: string,
        skills: ContainerRevision['skills'],
        createdBy: string,
        now: number,
    ): ContainerRevision {
        const next: ContainerRevision = {
            containerId,
            revision: (this.latest(containerId)?.revision ?? 0) + 1,
            skills: [...skills].sort((a, b) => byteOrder(a.name, b.name)),
            createdAt: now,
            createdBy,
        };
        this.repository.insertContainerRevisionNow(next);
        return next;
    }
    /** Publishes a skill revision, replacing any published revision of that skill. */
    publish(revisionId: string, createdBy: string, now = Date.now()) {
        const revision = this.skillRevision(revisionId);
        if (!revision) {
            throw new Error('Skill revision not found.');
        }
        const skills = (this.latest(revision.containerId)?.skills ?? []).filter(
            (skill) => skill.name !== revision.name,
        );
        return this.commit(revision.containerId, [...skills, { name: revision.name, revisionId }], createdBy, now);
    }
    /** Stops delivering a skill. Its revisions stay in history. */
    revoke(containerId: string, name: string, createdBy: string, now = Date.now()) {
        const skills = this.latest(containerId)?.skills ?? [];
        if (!skills.some((skill) => skill.name === name)) {
            throw new Error('That skill is not published.');
        }
        return this.commit(
            containerId,
            skills.filter((skill) => skill.name !== name),
            createdBy,
            now,
        );
    }
    pinned(containerId: string): number | undefined {
        const row = this.db
            .prepare('SELECT revision FROM learning_container_pins WHERE containerId=?')
            .get(containerId) as { revision: number } | undefined;
        return row?.revision;
    }
    /** Delivers this container revision until unpinned (null). */
    pin(containerId: string, revision: number | null) {
        if (revision === null) {
            this.repository.unpinNow(containerId);
            return;
        }
        if (!this.containerRevision(containerId, revision)) {
            throw new Error('Container revision not found.');
        }
        this.repository.pinNow(containerId, revision);
    }

    /**
     * The runtime snapshot for the container's current revision. A container
     * with nothing published yet gets an empty snapshot (revision 0), which the
     * runtime delivers as no skills rather than an error.
     */
    snapshot(containerId: string): Snapshot {
        const current = this.current(containerId) ?? {
            revision: 0,
            skills: [],
        };
        const revision = `${containerId}@${current.revision}`;
        const skills = current.skills.map((entry) => this.skillRevision(entry.revisionId)!);
        const entries: Array<[string, Uint8Array]> = [];
        const manifest = {
            schemaVersion: 1,
            revision,
            skills: skills.map((skill) => ({
                name: skill.name,
                description: skill.description,
                files: skill.files.map((file) => {
                    const data = Buffer.from(file.content, 'utf8');
                    entries.push([`${skill.name}/${file.path}`, data]);
                    return { path: file.path, size: data.length, sha256: sha256(data) };
                }),
            })),
        };
        const bytes = storeZip([['manifest.json', Buffer.from(JSON.stringify(manifest), 'utf8')], ...entries]);
        return {
            status: 'snapshot',
            bytes: new Uint8Array(bytes),
            revision,
            etag: `"${sha256(bytes)}"`,
            contentType: 'application/zip',
        };
    }
}
