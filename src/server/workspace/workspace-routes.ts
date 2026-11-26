import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';

import { withPrivateResultsWithheld, withToolActors } from '@socio/foundation/context/room-context';
import type { AppEnv } from '@socio/foundation/http/app-env';
import { conditionalJsonAsync } from '@socio/foundation/http/conditional';
import { requireAdmin } from '@socio/foundation/http/guards';
import { roomDenialStatus } from '@socio/foundation/rooms/denial-status';
import { turnProblems } from '@socio/foundation/rooms/turn-problems';
import { SpaceAccessError } from '@socio/foundation/spaces/access-error';
import { messageText } from '@socio/foundation/turns/media-parts';
import { UPGRADE_ENV, type UpgradeEnv, type VoiceShape } from '@socio/foundation/voice/voice-shape';
import type { ModelChoice } from '@socio/shared/inference';
import { modelChoiceInput } from '@socio/shared/inference/model-choice-input';
import { learningContainerIdSchema, validateLearningSettings } from '@socio/shared/learning';
import { LOCALS } from '@socio/shared/mascot';
import { displayContent } from '@socio/shared/media/refs';
import { NOTIFICATION_CONTENT } from '@socio/shared/notifications';
import { onboardingPreferencesSchema } from '@socio/shared/onboarding';
import { isAdmin } from '@socio/shared/roles';
import { handoffLine, handoffOf, type TranscriptHandoff } from '@socio/shared/rooms/room-handoffs';
import type { TranscriptMention } from '@socio/shared/rooms/room-notices';
import { withSocioFields } from '@socio/shared/runs/socio-fields';
import { TraceTimes } from '@socio/shared/runs/trace-times';
import { canEditSoul } from '@socio/shared/soul';
import {
    SPACE_NAME_ERROR,
    spaceCreateInput,
    spaceRenameInput,
    type SpaceCreateRequest,
} from '@socio/shared/spaces/create-input';
import {
    MAX_CHAT_TITLE,
    SENDER_METADATA,
    SOCIO_METADATA,
    type AgentRunSource,
    type Conversation,
    type ConversationDeletion,
    type Dot,
    type DotRun,
    type MessageAuthor,
    type SetupStatus,
    type Space,
    type User,
} from '@socio/shared/types';
import {
    DICTATION_AUDIO_TYPES,
    DICTATION_LIMITS,
    DICTATION_METHODS,
    baseAudioType,
} from '@socio/shared/voice/dictation';
import { isDictationLanguage, type DictationLanguage } from '@socio/shared/voice/dictation-languages';
import { VOICE_BACKENDS } from '@socio/shared/voice/voice-call';

import type { InferenceShape } from '../inference/contract.js';
import { RoomAccessError, RoomError, type NoticesShape, type RoomsShape } from '../rooms/contract.js';
import type { RunnerShape } from '../turns/contract.js';

import type { ConversationsShape, PeopleShape, SociosShape, SpacesShape, WorkspaceViewsShape } from './contract.js';

const dotSchema = z
    .object({
        name: z.string().trim().min(1).max(40),
        instructions: z.string().trim().min(3).max(2000),
        researchAllowed: z.boolean(),
        memoryAllowed: z.boolean(),
        learningContainerId: learningContainerIdSchema.optional(),
        skillDeliveryEnabled: z.boolean().optional(),
        issuesAllowed: z.boolean().optional(),
        spaceIds: z.array(z.string().min(1)).min(1).max(100).optional(),
        spaceId: z.string().min(1).optional(),
        inference: modelChoiceInput.nullable().optional(),
        /** Its Local (CB-256); omitted: its id's on create, unchanged on edit. */
        character: z.enum(LOCALS).optional(),
        /** Private by default; admins explicitly opt into workspace sharing. */
        personal: z.boolean().optional(),
    })
    .strict();
/** The Dots of their own one person may have. */
export const PERSONAL_DOTS_PER_USER = 10;
/**
 * What the workspace's own routes read: the workspace's slices, the
 * Space creation rule, the model choices, the runner's turns, the rooms
 * and their notices, and the app's conversation steps. The HTTP composition
 * builds it (`composition/http/workspace.ts`); members are read when a
 * request runs (`draining`).
 */
export interface WorkspaceRoutesDeps {
    readonly workspace: Pick<
        SociosShape,
        'dot' | 'createDot' | 'updateDot' | 'companyDots' | 'unarchiveDot' | 'personalDotCount' | 'canUseDot'
    > &
        Pick<PeopleShape, 'users' | 'preferences' | 'setPreferences'> &
        Pick<SpacesShape, 'readsSpace' | 'renameSpace' | 'deleteSpace' | 'deletedSpaces' | 'restoreSpace'> &
        Pick<
            ConversationsShape,
            | 'requireOwnedThread'
            | 'requireOwnedCall'
            | 'conversations'
            | 'archivedConversations'
            | 'thread'
            | 'allows'
            | 'requireAccess'
            | 'setThreadInference'
            | 'readableThread'
            | 'renameThread'
            | 'setArchived'
            | 'convertedFrom'
            | 'access'
            | 'capture'
            | 'call'
            | 'anchorCall'
        >;
    /**
     * Who may make which Space (CB-181): `createSpaceAs`, as spaces'
     * `Creation.createAs` (`SpaceCreationShape`), named here because spaces
     * sits above the workspace in the folder order.
     */
    readonly spaceCreation: {
        createAs(person: Pick<User, 'id' | 'role'>, input: SpaceCreateRequest & { grantTo?: string }): Promise<Space>;
    };
    readonly inference: Pick<InferenceShape, 'choiceProblem'>;
    readonly runner: Pick<
        RunnerShape,
        'runsOfThreads' | 'historyRows' | 'messages' | 'toolActors' | 'events' | 'runningPersonMessageIds' | 'runActor'
    >;
    readonly rooms: Pick<RoomsShape, 'rename' | 'archive' | 'unarchive'>;
    readonly roomNotices: Pick<NoticesShape, 'mentions'>;
    /** Whether the server is draining, read when a request runs. */
    readonly draining: boolean;
    archiveDot(id: string, actor: string): Promise<Dot>;
    runSource(threadId: string, recorded?: AgentRunSource | null): Promise<AgentRunSource>;
    setup(userId?: string): Promise<SetupStatus>;
    createConversation(
        dotId: string,
        title: string,
        userId: string,
        inference?: ModelChoice | null,
    ): Promise<Conversation>;
    deletion(id: string, userId: string): Promise<ConversationDeletion>;
    deleteConversation(id: string, userId: string, now?: number): Promise<void>;
    handle(request: Request, userId: string): Promise<Response>;
}

/**
 * The errors of the workspace's routes, and of the routes mounted beside
 * them under `/api` (`composition/http/workspace.ts`): a known message as
 * it is, anything else as a generic one; always a 503.
 */
export const workspaceRouteError = (error: Error, c: Context<AppEnv>) => {
    const text = error.message;
    const known =
        /^(Setup|Voice setup|Socio |Space |Specialist |Conversation |Call |This call|End the current|Voice provider|An audio|Conversation request)/.test(
            text,
        );
    return c.json(
        {
            error: known ? text : 'The service request failed. Check the server configuration and try again.',
        },
        503,
    );
};

export function workspaceRoutes(platform: WorkspaceRoutesDeps, voice: VoiceShape, views: WorkspaceViewsShape) {
    const app = new Hono<AppEnv>();
    // Another user's thread or call is reported as missing, not forbidden.
    const missing = (c: Context<AppEnv>, what = 'Conversation') => c.json({ error: `${what} not found.` }, 404);
    const ownsThread = (c: Context<AppEnv>, id: string) => {
        try {
            platform.workspace.requireOwnedThread(c.get('user').id, id);
            return true;
        } catch {
            return false;
        }
    };
    const ownsCall = (c: Context<AppEnv>, id: string) => {
        try {
            platform.workspace.requireOwnedCall(c.get('user').id, id);
            return true;
        } catch {
            return false;
        }
    };
    // A model choice must exist; with `userId`, that user must be able to use it.
    const choiceRefused = async (c: Context<AppEnv>, choice: ModelChoice | null | undefined, userId?: string) => {
        const problem = choice && (await platform.inference.choiceProblem(choice, userId));
        return problem ? c.json({ error: problem }, 400) : undefined;
    };
    // Polled by every tab: 304 when nothing changed (conditional.ts).
    app.get('/workspace', (c) =>
        conditionalJsonAsync(
            c,
            () => views.workspaceView(c.get('user')),
            () => views.workspaceVersion(c.get('user')),
        ),
    );
    // Company Dots are shared by the team; only admins manage them. Anyone
    // may make Dots of their own, private to them; settings that reach
    // beyond the person (board filing, Learning) stay with admins. A Space
    // open to the whole workspace is an admin's to make; anyone the "create
    // Spaces" permission lets in (members, unless an admin chose admins
    // only) may make a private one, for themselves and the people they
    // choose (CB-181).
    app.post('/spaces', async (c) => {
        const user = c.get('user');
        const data = spaceCreateInput.safeParse(await c.req.json());
        if (!data.success) {
            return c.json({ error: SPACE_NAME_ERROR }, 400);
        }
        try {
            return c.json(await platform.spaceCreation.createAs(user, data.data), 201);
        } catch (error) {
            if (error instanceof SpaceAccessError) {
                return c.json({ error: error.message }, error.status);
            }
            throw error;
        }
    });
    // Deleting a Space (CB-277), soft: a private one by its editors, one for
    // the whole workspace by admins; everything in it is kept, gone for
    // everyone at once, until an admin restores it (Settings → Deleted
    // Spaces). Someone who can't read it gets the 404 of one not there.
    const spaceRefused = (c: Context<AppEnv>, error: unknown) => {
        if (error instanceof SpaceAccessError) {
            return c.json({ error: error.message }, error.status);
        }
        throw error;
    };
    // Renaming a Space (CB-366): its editors (workspace admins edit every
    // Space), by the create rule's name; its id, and so every link, stays.
    app.patch('/spaces/:spaceId', async (c) => {
        const data = spaceRenameInput.safeParse(await c.req.json().catch(() => null));
        if (!data.success) {
            return c.json({ error: SPACE_NAME_ERROR }, 400);
        }
        try {
            return c.json(
                await platform.workspace.renameSpace(c.req.param('spaceId'), c.get('user').id, data.data.name),
            );
        } catch (error) {
            return spaceRefused(c, error);
        }
    });
    app.delete('/spaces/:spaceId', async (c) => {
        try {
            await platform.workspace.deleteSpace(c.req.param('spaceId'), c.get('user').id);
            return c.json({ ok: true });
        } catch (error) {
            return spaceRefused(c, error);
        }
    });
    app.get('/admin/spaces/deleted', requireAdmin, (c) => c.json({ spaces: platform.workspace.deletedSpaces() }));
    app.post('/admin/spaces/:spaceId/restore', requireAdmin, async (c) => {
        try {
            return c.json(await platform.workspace.restoreSpace(c.req.param('spaceId'), c.get('user').id));
        } catch (error) {
            return spaceRefused(c, error);
        }
    });
    app.post('/dots', async (c) => {
        const user = c.get('user');
        const data = dotSchema.extend({ spaceId: z.string() }).safeParse(await c.req.json());
        if (!data.success) {
            return c.json(
                {
                    error: 'Provide a name, role instructions, and explicit tool permissions.',
                },
                400,
            );
        }
        const admin = isAdmin(user);
        const personal = !admin || data.data.personal !== false;
        if (personal && platform.workspace.personalDotCount(user.id) >= PERSONAL_DOTS_PER_USER) {
            return c.json(
                {
                    error: `You have ${PERSONAL_DOTS_PER_USER} socios of your own, the limit.`,
                },
                400,
            );
        }
        if (!admin) {
            data.data.issuesAllowed = false;
            data.data.learningContainerId = null;
            data.data.skillDeliveryEnabled = false;
        }
        try {
            validateLearningSettings(data.data.learningContainerId ?? null, data.data.skillDeliveryEnabled ?? false);
        } catch (error) {
            return c.json(
                {
                    error: error instanceof Error ? error.message : 'Invalid Learning settings.',
                },
                400,
            );
        }
        const refused = await choiceRefused(c, data.data.inference);
        if (refused) {
            return refused;
        }
        // Only Spaces the person may read (CB-181): one they may not is as
        // one that isn't there.
        if (
            [data.data.spaceId, ...(data.data.spaceIds ?? [])].some((id) => !platform.workspace.readsSpace(user.id, id))
        ) {
            return c.json({ error: 'Space access must include a valid default destination.' }, 400);
        }
        return c.json(
            platform.workspace.createDot(
                data.data.spaceId,
                data.data.name,
                data.data.instructions,
                data.data.researchAllowed,
                data.data.memoryAllowed,
                data.data.spaceIds,
                data.data.learningContainerId,
                data.data.skillDeliveryEnabled,
                data.data.inference ?? null,
                data.data.issuesAllowed ?? false,
                personal ? user.id : null,
                user.id,
                data.data.character ?? null,
            ),
            201,
        );
    });
    app.put('/dots/:id', async (c) => {
        const user = c.get('user');
        // Instructions are the Soul's (CB-179): omitted, they stay as they are.
        const data = dotSchema
            .extend({ instructions: dotSchema.shape.instructions.optional() })
            .safeParse(await c.req.json());
        if (!data.success) {
            return c.json({ error: 'Invalid specialist settings.' }, 400);
        }
        const current = platform.workspace.dot(c.req.param('id'));
        // Another person's own Dot is missing, not forbidden.
        if (!current || (!isAdmin(user) && current.ownerId && current.ownerId !== user.id)) {
            return c.json({ error: 'Socio not found.' }, 404);
        }
        if (!isAdmin(user)) {
            if (!current.ownerId) {
                return c.json({ error: 'Only an admin can change this.' }, 403);
            }
            // Settings that reach beyond the person stay as an admin set them.
            data.data.issuesAllowed = current.issuesAllowed ?? false;
            data.data.learningContainerId = current.learningContainerId ?? null;
            data.data.skillDeliveryEnabled = current.skillDeliveryEnabled ?? false;
        }
        delete data.data.personal;
        // Changed instructions are a new Soul version: its editors' alone.
        if (
            data.data.instructions !== undefined &&
            data.data.instructions.trim() !== current.instructions.trim() &&
            !canEditSoul(user, current)
        ) {
            return c.json(
                {
                    error: current.ownerId
                        ? 'Only its owner can change a personal socio’s Soul.'
                        : 'Only an admin can change a company socio’s Soul.',
                },
                403,
            );
        }
        try {
            validateLearningSettings(
                data.data.learningContainerId === undefined
                    ? (current.learningContainerId ?? null)
                    : data.data.learningContainerId,
                data.data.skillDeliveryEnabled ?? current.skillDeliveryEnabled ?? false,
            );
        } catch (error) {
            return c.json(
                {
                    error: error instanceof Error ? error.message : 'Invalid Learning settings.',
                },
                400,
            );
        }
        // Unchanged defaults pass even when gone (a backend removed since).
        if (JSON.stringify(data.data.inference ?? null) !== JSON.stringify(current.inference ?? null)) {
            const refused = await choiceRefused(c, data.data.inference);
            if (refused) {
                return refused;
            }
        }
        // Spaces the person may not read (CB-181): granting one is refused as
        // for one that isn't there, and the ones it has stay, unseen.
        const reads = (id: string) => platform.workspace.readsSpace(user.id, id);
        if (data.data.spaceIds) {
            if (
                data.data.spaceIds.some((id) => !reads(id) && !current.spaceIds.includes(id)) ||
                (data.data.spaceId !== undefined && data.data.spaceId !== current.spaceId && !reads(data.data.spaceId))
            ) {
                return c.json({ error: 'Space access must include a valid default destination.' }, 400);
            }
            data.data.spaceIds = [...new Set([...data.data.spaceIds, ...current.spaceIds.filter((id) => !reads(id))])];
        }
        return c.json(views.dotForViewer(user.id, platform.workspace.updateDot(c.req.param('id'), data.data, user.id)));
    });
    // Archive, never delete: a person's own Dot by them or an admin, a
    // company Dot by an admin. Its schedules and goals pause.
    const archiving = (archive: boolean) => async (c: Context<AppEnv>) => {
        const user = c.get('user');
        const dot = platform.workspace.dot(c.req.param('id') ?? '');
        if (!dot || (!isAdmin(user) && dot.ownerId && dot.ownerId !== user.id)) {
            return c.json({ error: 'Socio not found.' }, 404);
        }
        if (!isAdmin(user) && !dot.ownerId) {
            return c.json({ error: 'Only an admin can change this.' }, 403);
        }
        // The team always keeps a company Dot to talk to.
        if (archive && !dot.ownerId && !dot.archivedAt && platform.workspace.companyDots().length <= 1) {
            return c.json({ error: 'This is the last company socio; make another one first.' }, 409);
        }
        // An archive an admin made is an admin's to undo.
        const archivedBy = dot.archivedBy ? platform.workspace.users().find((u) => u.id === dot.archivedBy) : undefined;
        if (!archive && !isAdmin(user) && archivedBy && isAdmin(archivedBy)) {
            return c.json(
                {
                    error: 'An admin archived this socio; ask an admin to bring it back.',
                },
                403,
            );
        }
        return c.json(
            archive ? await platform.archiveDot(dot.id, user.id) : platform.workspace.unarchiveDot(dot.id, user.id),
        );
    };
    app.post('/dots/:id/archive', archiving(true));
    app.post('/dots/:id/unarchive', archiving(false));
    // A Dot's home page (CB-89): the latest turns of the person's own chats
    // with it, archived ones too; never anyone else's. Another person's own
    // Dot is missing.
    app.get('/dots/:id/runs', async (c) => {
        const user = c.get('user');
        const dot = platform.workspace.dot(c.req.param('id'));
        if (!dot || (dot.ownerId && dot.ownerId !== user.id)) {
            return c.json({ error: 'Socio not found.' }, 404);
        }
        const titles = new Map(
            [
                ...(await platform.workspace.conversations(user.id)),
                ...(await platform.workspace.archivedConversations(user.id)),
            ]
                .filter((item) => item.dotId === dot.id && item.ownerId === user.id)
                .map((item) => [item.id, item.title]),
        );
        const runs = platform.runner.runsOfThreads([...titles.keys()], {
            limit: 10,
        });
        return c.json<DotRun[]>(
            await Promise.all(
                runs.map(async (run) => ({
                    runId: run.runId,
                    threadId: run.threadId,
                    title: titles.get(run.threadId) ?? '',
                    status: run.status as DotRun['status'],
                    source: await platform.runSource(run.threadId, run.source as DotRun['source'] | null),
                    startedAt: run.startedAt,
                    finishedAt: run.finishedAt,
                })),
            ),
        );
    });

    app.post('/conversations', async (c) => {
        const data = z
            .object({
                dotId: z.string(),
                title: z.string().trim().min(1).max(120).default('A new thought'),
                inference: modelChoiceInput.nullable().optional(),
            })
            .strict()
            .safeParse(await c.req.json());
        if (!data.success) {
            return c.json({ error: 'Select a socio and a conversation title.' }, 400);
        }
        // Another person's own Dot is missing, not forbidden.
        if (!platform.workspace.canUseDot(c.get('user').id, data.data.dotId)) {
            return c.json({ error: 'Socio not found.' }, 404);
        }
        const refused = await choiceRefused(c, data.data.inference, c.get('user').id);
        if (refused) {
            return refused;
        }
        const { missing } = await platform.setup();
        if (missing.length) {
            return c.json({ error: `Setup required: ${missing.join(', ')}.` }, 503);
        }
        return c.json(
            await platform.createConversation(
                data.data.dotId,
                data.data.title,
                c.get('user').id,
                data.data.inference ?? null,
            ),
            201,
        );
    });
    // The owner changes a conversation's model (null: its Dot's default),
    // renames it (CB-66: 1 to 80 characters, trimmed), or archives or
    // unarchives it, or several at once. In a room (CB-208) its admins do, by
    // the room rule (`manage`, `archive`, `unarchive`), each change audited;
    // members are refused, and anyone else finds nothing.
    app.patch('/conversations/:id', async (c) => {
        const id = c.req.param('id');
        const userId = c.get('user').id;
        const room = platform.workspace.thread(id)?.kind === 'room';
        if (room ? !platform.workspace.allows(userId, id, 'read') : !ownsThread(c, id)) {
            return missing(c);
        }
        const body: unknown = await c.req.json().catch(() => null);
        const data = z
            .object({
                inference: modelChoiceInput.nullable().optional(),
                title: z.string().trim().min(1).max(MAX_CHAT_TITLE).optional(),
                archived: z.boolean().optional(),
            })
            .strict()
            .refine((patch) => patch.inference !== undefined || !!patch.title || patch.archived !== undefined)
            .safeParse(body);
        if (!data.success) {
            // A bad model says so; anything else wrong with a title is the title.
            const field = (name: string) => data.error.issues.some((issue) => issue.path[0] === name);
            const titled = !!body && typeof body === 'object' && 'title' in body;
            return c.json(
                {
                    error: field('archived')
                        ? 'Say whether the chat is archived (true or false).'
                        : field('title') || (titled && !field('inference'))
                          ? `Enter a title of 1 to ${MAX_CHAT_TITLE} characters.`
                          : 'Pick a model.',
                },
                400,
            );
        }
        const { inference, title, archived } = data.data;
        if (room) {
            try {
                if (inference !== undefined) {
                    platform.workspace.requireAccess(userId, id, 'manage');
                    const refused = await choiceRefused(c, inference, userId);
                    if (refused) {
                        return refused;
                    }
                    platform.workspace.setThreadInference(id, inference);
                }
                if (title) {
                    await platform.rooms.rename(id, userId, title);
                }
                if (archived === true) {
                    await platform.rooms.archive(id, userId);
                }
                if (archived === false) {
                    await platform.rooms.unarchive(id, userId);
                }
            } catch (error) {
                if (error instanceof RoomError) {
                    return c.json({ error: error.message, code: error.reason }, error.status as 403);
                }
                if (error instanceof RoomAccessError) {
                    return c.json({ error: error.message, code: error.reason }, roomDenialStatus(error.reason) as 403);
                }
                throw error;
            }
            return c.json(await platform.workspace.readableThread(userId, id));
        }
        if (inference !== undefined) {
            const refused = await choiceRefused(c, inference, c.get('user').id);
            if (refused) {
                return refused;
            }
            platform.workspace.setThreadInference(id, inference);
        }
        if (title) {
            platform.workspace.renameThread(id, title);
        }
        if (archived !== undefined) {
            platform.workspace.setArchived(id, archived, c.get('user').id);
        }
        return c.json(platform.workspace.thread(id));
    });
    // What deleting it would take with it, and what stops it now (CB-66).
    app.get('/conversations/:id/deletion', async (c) =>
        ownsThread(c, c.req.param('id'))
            ? c.json(await platform.deletion(c.req.param('id'), c.get('user').id))
            : missing(c),
    );
    // Read-only history, including team conversations the user belongs to.
    app.get('/conversations/:id/transcript', async (c) => {
        const thread = await platform.workspace.readableThread(c.get('user').id, c.req.param('id'));
        if (!thread) {
            return missing(c);
        }
        const room = thread.kind === 'room';
        // A room's live stream (`/stream`, CB-212) goes on from the newest run
        // stored before its messages are read: one stored meanwhile comes
        // again, and the reader shows each message once.
        const cursor = room ? (platform.runner.historyRows(thread.id, { limit: 1 })[0]?.seq ?? 0) : undefined;
        const stored = await platform.runner.messages(thread.id);
        // In a room, an approval's note from someone else's turn quotes what
        // was asked and returned for them: the reader gets it withheld, as in
        // the history and the stream (CB-210, CB-212). Only people's messages
        // and the socio's answers are listed: never a turn's reasoning.
        const messages = room
            ? withPrivateResultsWithheld(
                  withToolActors(stored, platform.runner.toolActors(thread.id)),
                  c.get('user').id,
              )
            : stored;
        // When each message was written (CB-72), for its action row.
        const events = platform.runner.events(thread.id);
        const times = new TraceTimes(events);
        // In a team conversation or a room (CB-208), who said each message
        // (CB-66): a name and whether it is the reader; in a room also their
        // id, which its members see in its people anyway (CB-212), never in a
        // team topic. Messages stored before CB-66 have no sender: someone on
        // the team, never the reader, so only the reader's own messages show
        // on the right. In a room made from a private chat they are its
        // owner's: it had one person.
        const userId = c.get('user').id;
        const shared = !!thread.team || room;
        const names = new Map(shared ? platform.workspace.users().map((user) => [user.id, user.name]) : []);
        const converted = room ? platform.workspace.convertedFrom(thread.id) : undefined;
        const person = (id: string): MessageAuthor => ({
            name: names.get(id) ?? 'Team member',
            you: id === userId,
            ...(room ? { id } : {}),
        });
        const author = (id: string, metadata: unknown): MessageAuthor | undefined => {
            if (!shared) {
                return undefined;
            }
            const fields = metadata && typeof metadata === 'object' ? (metadata as Record<string, unknown>) : {};
            const sender = fields[SENDER_METADATA];
            if (typeof sender === 'string') {
                return person(sender);
            }
            // A note the server wrote (an approval's) is nobody's; one written
            // after the conversion would have its sender.
            const at = times.messages.get(id);
            return converted && fields.socioSource === undefined && (at === undefined || at <= converted.at)
                ? person(converted.userId)
                : { name: 'Team member', you: false };
        };
        const socioOf = (metadata: unknown) => {
            const id =
                metadata && typeof metadata === 'object'
                    ? (metadata as Record<string, unknown>)[SOCIO_METADATA]
                    : undefined;
            return typeof id === 'string' && id ? id : undefined;
        };
        // Whom each room message mentions (CB-216), as checked once it was
        // delivered: names, and whether it is the reader.
        const mentioned = thread.kind === 'room' ? await platform.roomNotices.mentions(thread.id) : undefined;
        const mentionsOf = (id: string): TranscriptMention[] | undefined =>
            mentioned?.get(id)?.map((mention) => ({
                name: names.get(mention.userId) ?? mention.label,
                you: mention.userId === userId,
            }));
        // Each handoff between a room's socios (CB-206) is a line between the
        // replies: who handed on to whom, and why; its note is the next
        // socio's, never anyone's message.
        const socioName = (id: string) => platform.workspace.dot(id)?.name ?? 'A socio';
        const handoff = (message: { role: string; metadata?: unknown }): TranscriptHandoff | undefined => {
            const meta = room ? handoffOf(message) : undefined;
            if (!meta) {
                return undefined;
            }
            const by = meta.by && names.get(meta.by);
            return {
                kind: meta.kind,
                from: { id: meta.from, name: socioName(meta.from) },
                to: { id: meta.to, name: socioName(meta.to) },
                reason: meta.reason,
                ...(by ? { byName: by } : {}),
            };
        };
        // A room's transcript (CB-283) shows a socio's per-round thinking
        // traces and tool calls, with the same privacy the live stream and
        // history keep (CB-210): reasoning a turn did for someone
        // else reaches every other member emptied (the socio thought, never
        // what), and a tool's result as a withheld note. The reader's own turn
        // keeps its reasoning and results. A private chat's transcript is as
        // before: only the person's and the socio's messages.
        const withTraces = room;
        const shown = messages
            .filter((message) =>
                withTraces
                    ? message.role === 'user' ||
                      message.role === 'assistant' ||
                      message.role === 'reasoning' ||
                      message.role === 'tool'
                    : message.role === 'user' || message.role === 'assistant',
            )
            .map((message) => {
                const { id, role, content, metadata } = message;
                const handedOff = handoff({ role, metadata });
                const text = handedOff ? handoffLine(handedOff) : messageText(content);
                return {
                    id,
                    role,
                    text,
                    content,
                    author: role === 'user' && !handedOff ? author(id, metadata) : undefined,
                    socioId: role === 'assistant' ? socioOf(metadata) : undefined,
                    handoff: handedOff,
                    // A tool message's call id, and an assistant's tool calls, so the
                    // client rebuilds the turn's steps (CB-72, CB-128).
                    toolCallId: role === 'tool' ? message.toolCallId : undefined,
                    toolCalls: role === 'assistant' ? message.toolCalls : undefined,
                };
            })
            // A handoff's note, an answer, a tool result (withheld or not) all
            // have text; a reasoning message another member gets may be emptied
            // (CB-210), and is kept so the trace shows the socio thought.
            .filter((message) => message.text.trim() || message.role === 'reasoning')
            .map(({ id, role, text, content, author, socioId, handoff, toolCallId, toolCalls }) =>
                // Its author and time in `metadata`, which AG-UI 1.0 keeps, and
                // for now at the top level too (`withSocioFields`).
                withSocioFields(
                    {
                        id,
                        role,
                        // A handoff's note is for the next socio: the room reads its line.
                        content: handoff ? text : displayContent(content, text),
                        // Which socio wrote it (CB-212); none for replies stored before.
                        ...(socioId ? { socioId } : {}),
                        ...(handoff ? { handoff } : {}),
                        ...(role === 'user' && mentionsOf(id) ? { mentions: mentionsOf(id) } : {}),
                        // The trace's parts (CB-283): a tool result's call id, and the
                        // calls an assistant message made.
                        ...(role === 'tool' && toolCallId ? { toolCallId } : {}),
                        ...(role === 'assistant' && toolCalls?.length ? { toolCalls } : {}),
                    },
                    { author, at: times.messages.get(id) },
                ),
            );
        return c.json({
            conversation: thread,
            messages: shown,
            ...(room
                ? {
                      cursor,
                      // The running turn's person messages: a reader's queued
                      // message it took, not one an admin canceled (CB-215).
                      inTurn: platform.runner.runningPersonMessageIds(thread.id),
                      problems: turnProblems(events, new Set(shown.map((m) => m.id)), {
                          author: (runId) => {
                              const actor = platform.runner.runActor(runId);
                              return actor ? person(actor) : undefined;
                          },
                      }),
                      // When each step happened (CB-72, CB-128), so a room's transcript
                      // shows "Thought for 12s" and each tool's time (CB-283).
                      times: times.snapshot(),
                  }
                : {}),
        });
    });
    // Owners delete their own web conversations, with the tasks bound to them.
    // Rooms are archived, never deleted: a member is told so.
    app.delete('/conversations/:id', async (c) => {
        const { thread, decision } = platform.workspace.access(c.get('user').id, c.req.param('id'), 'delete');
        if (thread?.kind === 'room' && !decision.allowed && decision.reason !== 'not_found') {
            return c.json({ error: 'Rooms are archived, not deleted.', code: decision.reason }, 409);
        }
        if (!ownsThread(c, c.req.param('id'))) {
            return missing(c);
        }
        try {
            await platform.deleteConversation(c.req.param('id'), c.get('user').id);
        } catch (error) {
            return c.json(
                {
                    error: error instanceof Error ? error.message : 'The conversation could not be deleted.',
                },
                409,
            );
        }
        return c.json({ ok: true });
    });
    app.get('/conversations/:id/capture', (c) =>
        ownsThread(c, c.req.param('id')) ? c.json(platform.workspace.capture(c.req.param('id'))) : missing(c),
    );
    // One person's own preferences (CB-101): theirs to set, nobody else's.
    app.get('/preferences', (c) => c.json(platform.workspace.preferences(c.get('user').id)));
    app.patch('/preferences', async (c) => {
        const data = z
            .object({
                dictation: z.enum(DICTATION_METHODS).nullable().optional(),
                // The transcription server's language hint (CB-221): an offered
                // code, or null for Auto.
                dictationLanguage: z.custom<DictationLanguage>(isDictationLanguage).nullable().optional(),
                onboarding: onboardingPreferencesSchema.optional(),
                // Each notification channel on or off, and what it shows (CB-114).
                notifications: z
                    .record(
                        z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
                        z
                            .object({
                                enabled: z.boolean(),
                                content: z.enum(NOTIFICATION_CONTENT),
                            })
                            .strict(),
                    )
                    .refine((channels) => Object.keys(channels).length <= 20)
                    .optional(),
                // Whether rooms show when they are looking (CB-216).
                roomPresence: z.enum(['shown', 'hidden']).optional(),
            })
            .strict()
            .safeParse(await c.req.json().catch(() => null));
        if (!data.success) {
            return c.json(
                {
                    error: 'Use supported dictation, notification and versioned guide preferences.',
                },
                400,
            );
        }
        return c.json(platform.workspace.setPreferences(c.get('user').id, data.data));
    });
    // Dictation on the server (CB-101): a recording's bytes in, its text out.
    app.post(
        '/voice/transcriptions',
        bodyLimit({
            maxSize: DICTATION_LIMITS.maxBytes,
            onError: (c) =>
                c.json(
                    {
                        error: `Recordings can be at most ${DICTATION_LIMITS.maxBytes / 1024 / 1024} MB.`,
                    },
                    413,
                ),
        }),
        async (c) => {
            const type = c.req.header('x-file-type') ?? '';
            if (!DICTATION_AUDIO_TYPES[baseAudioType(type)]) {
                return c.json({ error: 'Send the recording as audio (X-File-Type).' }, 415);
            }
            const audio = new Uint8Array(await c.req.arrayBuffer());
            if (!audio.length) {
                return c.json({ error: 'The recording is empty.' }, 400);
            }
            return c.json({
                text: await voice.transcribe(audio, type, c.req.raw.signal, c.get('user').id),
            });
        },
    );
    // Live text while dictating (CB-222): the composer's socket, signed in
    // and checked like the recording above, then relayed (dictation-stream.ts).
    app.get('/voice/realtime', (c) => {
        const upgrade = (c.env as UpgradeEnv | undefined)?.[UPGRADE_ENV];
        if (!upgrade || c.req.header('upgrade')?.toLowerCase() !== 'websocket') {
            return c.json({ error: 'Open this as a WebSocket.' }, 426);
        }
        // People dictate: never a service key or a data token.
        if (c.get('serviceKey') || c.get('dataToken')) {
            return c.json({ error: 'Only people dictate.' }, 403);
        }
        // A server about to restart takes no new sessions: the composer records.
        if (platform.draining) {
            return c.json({ error: 'Socio is restarting: no live text now.' }, 409);
        }
        let provider;
        try {
            provider = voice.dictationProvider();
        } catch (error) {
            return c.json({ error: (error as Error).message }, 503);
        }
        const userId = c.get('user').id;
        const refusal = voice.streams.admit(provider, userId);
        if (refusal) {
            return c.json({ error: refusal.error }, refusal.status);
        }
        // Their own dictation language (CB-221), from what they saved.
        const language = voice.dictationLanguage(userId);
        upgrade((socket) => voice.streams.start(socket, userId, provider, language));
        return c.body(null, 204);
    });
    // A call (CB-265): the backend in force unless the person picks one
    // (cloud, when a self-hosted call couldn't connect). Cloud takes the
    // browser's WebRTC offer; self-hosted, the socket below.
    app.post('/voice/calls', async (c) => {
        const data = z
            .object({
                threadId: z.string(),
                sdp: z.string().max(100000).optional(),
                backend: z.enum(VOICE_BACKENDS).optional(),
            })
            .strict()
            .safeParse(await c.req.json().catch(() => null));
        if (!data.success) {
            return c.json({ error: 'A conversation and audio SDP offer are required.' }, 400);
        }
        if (!ownsThread(c, data.data.threadId)) {
            return missing(c);
        }
        const backend = data.data.backend ?? voice.backend();
        if (backend === 'self-hosted') {
            return c.json(await voice.beginSelfHosted(data.data.threadId), 201);
        }
        if (!data.data.sdp) {
            return c.json({ error: 'A conversation and audio SDP offer are required.' }, 400);
        }
        return c.json(
            {
                ...(await voice.begin(data.data.threadId, data.data.sdp, c.req.raw.signal)),
                backend: 'cloud' as const,
            },
            201,
        );
    });
    // A self-hosted call's socket (CB-265), signed in and checked like the
    // rest; only the call's owner opens it (`?id=`), then it is relayed
    // (voice-call.ts).
    app.get('/voice/call', (c) => {
        const upgrade = (c.env as UpgradeEnv | undefined)?.[UPGRADE_ENV];
        if (!upgrade || c.req.header('upgrade')?.toLowerCase() !== 'websocket') {
            return c.json({ error: 'Open this as a WebSocket.' }, 426);
        }
        if (c.get('serviceKey') || c.get('dataToken')) {
            return c.json({ error: 'Only people make calls.' }, 403);
        }
        const id = c.req.query('id') ?? '';
        if (!id || !ownsCall(c, id)) {
            return missing(c, 'Call');
        }
        upgrade((socket) => voice.attach(id, socket));
        return c.body(null, 204);
    });
    app.use('/voice/calls/:id/*', async (c, next) => (ownsCall(c, c.req.param('id')) ? next() : missing(c, 'Call')));
    app.get('/voice/calls/:id', (c) =>
        ownsCall(c, c.req.param('id')) ? c.json(platform.workspace.call(c.req.param('id'))) : missing(c, 'Call'),
    );
    app.post('/voice/calls/:id/active', (c) => c.json(voice.activate(c.req.param('id'))));
    app.post('/voice/calls/:id/compute', async (c) => {
        const data = z
            .object({
                toolCallId: z.string().min(1).max(200),
                request: z.string().trim().min(1).max(4000),
                transcript: z.string().max(12000).default(''),
            })
            .strict()
            .safeParse(await c.req.json());
        if (!data.success) {
            return c.json({ error: 'A bounded compute request and tool call ID are required.' }, 400);
        }
        return c.json({
            text: await voice.compute(
                c.req.param('id'),
                data.data.toolCallId,
                `${data.data.request}\n\nUntrusted current-call transcript for context:\n${data.data.transcript}`,
            ),
        });
    });
    app.post('/voice/calls/:id/end', async (c) => {
        const data = z
            .object({
                transcript: z.string().max(20000),
                anchorMessageId: z.string().max(200).optional(),
            })
            .strict()
            .safeParse(await c.req.json());
        if (!data.success) {
            return c.json({ error: 'Transcript exceeds the 20,000 character limit.' }, 400);
        }
        platform.workspace.anchorCall(c.req.param('id'), data.data.anchorMessageId);
        return c.json(await voice.end(c.req.param('id'), data.data.transcript));
    });
    app.all('/copilotkit/*', (c) => platform.handle(c.req.raw, c.get('user').id));
    app.onError(workspaceRouteError);
    return app;
}
