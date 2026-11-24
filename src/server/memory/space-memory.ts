import {
    SPACE_MEMORY_ENTRIES_MAX,
    SPACE_PROPOSALS_WAITING_MAX,
    type SpaceAccessLevel,
    type SpaceMemoryState,
    type SpaceMemoryVersion,
    type SpaceMemoryView,
} from '@socio/shared/space-memory';
import { rankByWords } from '@socio/shared/text/rank-words';

import type { AccessShape as RoomAccessShape } from '../rooms/contract.js';
import type {
    AuditShape,
    ConversationsShape,
    PeopleShape,
    SociosShape,
    SpacesShape,
    WorkspaceAuditEntry,
} from '../workspace/contract.js';

import {
    SpaceMemoryError,
    type SpaceMemoryHit,
    type SpaceMemoryProposal,
    type SpaceMemoryRefusal,
    type SpaceMemoryRepository,
    type SpaceMemoryResult,
    type SpaceMemoryShape,
    type SpaceMemoryTurn,
} from './contract.js';
import type { TelegramThreads } from './turn.js';

/**
 * Space memory (CB-181, docs/MEMORY.md "Space memory"): a Space's shared
 * knowledge, governed. People who can read the Space, and socios for the
 * person they act for, propose entries; the Space's editors approve,
 * reject, edit and retire them; nothing a socio proposes is ever used
 * before an editor approves it. Every read asks the Space's access
 * afresh (`SpaceAccess`), so a person removed from a Space, or a Space
 * closed to its people, stops reaching them at once. Every change is a
 * line in the workspace audit: ids, never the entry's words.
 */

const REFUSALS: Record<SpaceMemoryRefusal, [string, 400 | 404 | 409]> = {
    not_found: ['Entry not found.', 404],
    not_waiting: ['That proposal is no longer waiting.', 409],
    changed: ['The entry changed since this was proposed, or was retired: read it again.', 409],
    duplicate: ['This Space already has that entry, in use or waiting.', 409],
    in_use: ['Retire the entry before deleting it.', 409],
};

const refused = (reason: SpaceMemoryRefusal) => new SpaceMemoryError(...REFUSALS[reason]);

/**
 * A Space's access as Space memory checks it: `spaces/`'s
 * `SpaceAccessShape`, by the slice it calls (spaces is above memory in the
 * folder order, so this slice is stated here).
 */
export interface SpaceMemoryAccess {
    /** `reads` for a person: the one read check. */
    canRead(spaceId: string, userId: string): boolean;
    /** Of `spaceIds`, the Spaces every one of `userIds` can read now; none for no one. */
    readableByAll(spaceIds: readonly string[], userIds: readonly string[]): string[];
    /** The level, or a refusal that never says a hidden Space is there. */
    require(spaceId: string, userId: string, needs?: SpaceAccessLevel): SpaceAccessLevel;
}

export interface SpaceMemoryDeps {
    repository: SpaceMemoryRepository;
    workspace: Pick<PeopleShape, 'users'> &
        Pick<SociosShape, 'dot'> &
        Pick<ConversationsShape, 'thread' | 'allows'> &
        Pick<AuditShape, 'audit'> & { readonly spaceAccess: SpaceMemoryAccess };
    /** How long what is out of use is kept (Settings → General → Memory). */
    retentionDays: () => number;
}

export class SpaceMemoryService implements SpaceMemoryShape {
    constructor(private deps: SpaceMemoryDeps) {}

    get access(): SpaceMemoryAccess {
        return this.deps.workspace.spaceAccess;
    }

    private audit(actor: string, action: WorkspaceAuditEntry['action'], version: SpaceMemoryVersion, extra = '') {
        this.deps.workspace.audit({
            actor,
            action,
            targetKind: 'space_memory',
            targetId: version.id,
            detail: `space:${version.spaceId} entry:${version.entryId}${
                version.version ? ` v${version.version}` : ''
            }${version.dotId && action === 'propose' ? ` socio:${version.dotId}` : ''}${extra}`,
        });
    }

    /** The version, or the refusal as an error. */
    private settled(result: SpaceMemoryResult) {
        if (!result.ok) {
            throw refused(result.reason);
        }
        return result.version;
    }

    /** Names for a version's ids; a chat's title only when the viewer can open it. */
    private views(versions: readonly SpaceMemoryVersion[], viewer: string): SpaceMemoryView[] {
        const users = this.deps.workspace.users();
        const name = (id: string | null) =>
            id === null ? null : (users.find((user) => user.id === id)?.name ?? 'Former member');
        return versions.map((version) => {
            const chat =
                version.threadId &&
                this.deps.workspace.allows(viewer, version.threadId, 'read', {
                    audit: false,
                })
                    ? this.deps.workspace.thread(version.threadId)?.title
                    : undefined;
            return {
                ...version,
                proposedByName: name(version.proposedBy)!,
                dotName: version.dotId ? (this.deps.workspace.dot(version.dotId)?.name ?? 'A socio') : null,
                chatTitle: chat ?? null,
                decidedByName: name(version.decidedBy),
                endedByName: name(version.endedBy),
            };
        });
    }

    /** `GET /api/spaces/:id/memory`. */
    async view(spaceId: string, viewer: string): Promise<SpaceMemoryState> {
        const access = this.access.require(spaceId, viewer);
        const editor = access === 'editor';
        const [entries, proposals, retired] = await Promise.all([
            this.deps.repository.list(spaceId, ['active']),
            this.deps.repository.list(spaceId, ['proposed']),
            editor ? this.deps.repository.list(spaceId, ['retired'], 200) : Promise.resolve([]),
        ]);
        return {
            spaceId,
            access,
            entries: this.views(entries, viewer),
            // A reader sees only their own: the rest is for the editors to judge.
            proposals: this.views(
                editor ? proposals : proposals.filter((proposal) => proposal.proposedBy === viewer),
                viewer,
            ),
            retired: this.views(retired, viewer),
            retentionDays: this.deps.retentionDays(),
        };
    }

    /**
     * An entry's versions, newest first: every one for an editor, the
     * approved ones (and the reader's own proposals) for a reader.
     */
    async history(spaceId: string, entryId: string, viewer: string) {
        const editor = this.access.require(spaceId, viewer) === 'editor';
        const versions = (await this.deps.repository.history(spaceId, entryId)).filter(
            (version) => editor || version.version !== null || version.proposedBy === viewer,
        );
        if (!versions.length) {
            throw refused('not_found');
        }
        return this.views(versions, viewer);
    }

    /**
     * Proposes an entry or a change for `by`, who must be able to read the
     * Space. A socio's proposal (`dotId`) always waits for an editor, the
     * person's role whatever it is; an editor's own, from the Memory tab,
     * is in use at once: they are its approver.
     */
    async propose(
        spaceId: string,
        by: string,
        proposal: SpaceMemoryProposal,
    ): Promise<{ version: SpaceMemoryVersion; waiting: boolean }> {
        const level = this.access.require(spaceId, by);
        const text = proposal.text.trim();
        let supersedes: string | null = null;
        if (proposal.entryId) {
            const versions = await this.deps.repository.history(spaceId, proposal.entryId);
            const inUse = versions.find((version) => version.status === 'active');
            if (!inUse) {
                throw refused(versions.length ? 'changed' : 'not_found');
            }
            supersedes = inUse.id;
        }
        const memory = {
            spaceId,
            text,
            proposedBy: by,
            dotId: proposal.dotId ?? null,
            threadId: proposal.threadId ?? null,
            entryId: proposal.entryId,
            supersedes,
        };
        if (level === 'editor' && !proposal.dotId) {
            if (
                !proposal.entryId &&
                (await this.deps.repository.count(spaceId, 'active')) >= SPACE_MEMORY_ENTRIES_MAX
            ) {
                throw new SpaceMemoryError(
                    `This Space has ${SPACE_MEMORY_ENTRIES_MAX} entries in use: retire some first.`,
                    409,
                );
            }
            const version = this.settled(await this.deps.repository.add(memory, by));
            this.audit(by, proposal.entryId ? 'update' : 'create', version);
            return { version, waiting: false };
        }
        if ((await this.deps.repository.count(spaceId, 'proposed')) >= SPACE_PROPOSALS_WAITING_MAX) {
            throw new SpaceMemoryError(
                `${SPACE_PROPOSALS_WAITING_MAX} proposals already wait in this Space: its editors review those first.`,
                409,
            );
        }
        const version = this.settled(await this.deps.repository.propose(memory));
        this.audit(by, 'propose', version);
        return { version, waiting: true };
    }

    /** An editor approves a proposal, with their own words if they changed them. */
    async approve(spaceId: string, id: string, by: string, options: { text?: string } = {}) {
        this.access.require(spaceId, by, 'editor');
        const version = this.settled(
            await this.deps.repository.approve(spaceId, id, by, {
                text: options.text?.trim() || undefined,
            }),
        );
        this.audit(by, 'approve', version);
        return version;
    }

    /** An editor turns a proposal down. */
    async reject(spaceId: string, id: string, by: string) {
        this.access.require(spaceId, by, 'editor');
        const version = this.settled(await this.deps.repository.close(spaceId, id, by, 'rejected'));
        this.audit(by, 'reject', version);
        return version;
    }

    /** The person who proposed it (or a socio did for) takes it back. */
    async withdraw(spaceId: string, id: string, by: string) {
        this.access.require(spaceId, by);
        const proposal = await this.deps.repository.get(spaceId, id);
        if (!proposal || proposal.proposedBy !== by) {
            throw refused('not_found');
        }
        const version = this.settled(await this.deps.repository.close(spaceId, id, by, 'withdrawn'));
        this.audit(by, 'withdraw', version);
        return version;
    }

    /** An editor takes an entry out of use; it is kept until retention. */
    async retire(spaceId: string, entryId: string, by: string) {
        this.access.require(spaceId, by, 'editor');
        const version = this.settled(await this.deps.repository.retire(spaceId, entryId, by));
        this.audit(by, 'retire', version);
        return version;
    }

    /** An editor deletes a retired entry for real: every version of it. */
    async remove(spaceId: string, entryId: string, by: string) {
        this.access.require(spaceId, by, 'editor');
        const result = await this.deps.repository.remove(spaceId, entryId);
        if (!result.ok) {
            throw refused(result.reason);
        }
        this.deps.workspace.audit({
            actor: by,
            action: 'delete',
            targetKind: 'space_memory',
            targetId: entryId,
            detail: `space:${spaceId} entry:${entryId} ${result.deleted} versions`,
        });
        return result.deleted;
    }
}

/** The service on the platform's store and workspace. */
export const spaceMemoryService = (
    store: { readonly spaceMemories: SpaceMemoryRepository },
    workspace: SpaceMemoryDeps['workspace'],
    retentionDays: () => number,
) =>
    new SpaceMemoryService({
        repository: store.spaceMemories,
        workspace,
        retentionDays,
    });

/** What `chatReaders` reads of the workspace. */
type ChatReadersWorkspace = Pick<ConversationsShape, 'thread'> & {
    readonly telegram: TelegramThreads;
    readonly roomAccess: Pick<RoomAccessShape, 'people'>;
};

/**
 * Who reads what a turn in this chat says (CB-181), for its Space memory:
 * the acting person in a chat of their own (a Telegram DM too); every
 * person in a room, active or invited with an invite that still works.
 * Null where those people are not known for sure, so no Space memory goes
 * there at all: a Telegram group or legacy team topic (whose readers
 * include people Socio can't name), anyone else's chat, an unknown one,
 * or a room the person is not in.
 */
export async function chatReaders(
    workspace: ChatReadersWorkspace,
    threadId: string,
    userId: string,
): Promise<string[] | null> {
    const thread = workspace.thread(threadId);
    if (!thread) {
        return null;
    }
    if (thread.kind === 'room') {
        const people = workspace.roomAccess.people(threadId);
        return people.includes(userId) ? people : null;
    }
    if (thread.ownerId !== userId) {
        return null;
    }
    const telegram = await workspace.telegram.threadInfo(threadId);
    if (telegram && telegram.kind !== 'dm') {
        return null;
    }
    return [userId];
}

/**
 * The Space memory a turn may recall (CB-181): entries in use in the
 * Spaces the socio has that every reader of the chat (`chatReaders`) can
 * read now, those that share words with the message, best first. Asked
 * afresh each turn: a person removed from a Space, or a Space closed to
 * its people, is out of the next turn.
 */
export async function spaceMemoryForTurn(
    store: { readonly spaceMemories: SpaceMemoryRepository },
    workspace: ChatReadersWorkspace &
        Pick<SpacesShape, 'spaces'> &
        Pick<SociosShape, 'canAccessSpace'> & { readonly spaceAccess: Pick<SpaceMemoryAccess, 'readableByAll'> },
    turn: SpaceMemoryTurn,
): Promise<SpaceMemoryHit[]> {
    if (!turn.query.trim()) {
        return [];
    }
    const readers = await chatReaders(workspace, turn.threadId, turn.userId);
    if (!readers) {
        return [];
    }
    const spaces = workspace.spaces().filter((space) => workspace.canAccessSpace(turn.dotId, space.id));
    const readable = workspace.spaceAccess.readableByAll(
        spaces.map((space) => space.id),
        readers,
    );
    if (!readable.length) {
        return [];
    }
    const active = await store.spaceMemories.active(readable);
    // On a tie `rankByWords` puts the later index first: the newer.
    const ordered = [...active].reverse();
    return rankByWords(
        turn.query,
        ordered.map((version) => version.text),
    ).map((index) => {
        const version = ordered[index];
        return {
            entryId: version.entryId,
            spaceId: version.spaceId,
            spaceName: spaces.find((space) => space.id === version.spaceId)?.name ?? 'Space',
            text: version.text,
            approvedAt: version.decidedAt ?? version.createdAt,
        };
    });
}

/** How often the leader deletes Space memory past its retention. */
const EXPIRE_BATCH = 1_000;
const EXPIRE_BATCHES = 20;

/**
 * Retention (CB-181): deletes what has been out of use (superseded,
 * rejected, withdrawn, retired) for longer than `days`, and proposals
 * that waited that long, in batches. Entries in use are kept until an
 * editor retires them. The memories module's tick runs it on the leader.
 */
export async function expireSpaceMemory(
    store: { readonly spaceMemories: SpaceMemoryRepository },
    days: number,
    now = Date.now(),
) {
    const before = now - days * 24 * 60 * 60_000;
    let deleted = 0;
    for (let batch = 0; batch < EXPIRE_BATCHES; batch++) {
        const removed = await store.spaceMemories.expire(before, EXPIRE_BATCH);
        deleted += removed;
        if (removed < EXPIRE_BATCH) {
            break;
        }
    }
    return deleted;
}
