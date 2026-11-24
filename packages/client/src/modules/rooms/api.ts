import type { RoomPinOrigin, RoomPinOutcome, RoomPinVersion, RoomPinsState } from '@socio/shared/rooms/room-pins';
import type { RoomTopicCode, RoomTopicView } from '@socio/shared/rooms/room-telegram';
import type {
    RoomHandoffLimitView,
    RoomInvite,
    RoomLimits,
    RoomLimitsView,
    RoomPerson,
    RoomRole,
    RoomSocioRequest,
    RoomUsageView,
    RoomView,
} from '@socio/shared/rooms/rooms';
import type { Conversation } from '@socio/shared/types';

import { api, ApiError } from '../../lib/api';

/**
 * The rooms API (CB-208) for the room screens (CB-212): one function per
 * route, typed with the shared contract. Refusals throw `ApiError` with
 * the server's sentence and its `code` (`RoomRefusal`).
 */
const room = (id: string) => `/rooms/${encodeURIComponent(id)}`;

export const roomsApi = {
    /**
     * A new room (CB-212, CB-278): `dotId` is the lead socio; `dotIds` asks
     * for further company socios, `userIds` invites people as members, and
     * `description` is the room's optional purpose. The creator's own
     * membership is implicit (admin).
     */
    create: (
        dotId: string,
        title: string,
        options: {
            dotIds?: readonly string[];
            userIds?: readonly string[];
            description?: string;
        } = {},
    ) =>
        api<Conversation>('/rooms', 'POST', {
            dotId,
            title,
            ...(options.dotIds?.length ? { dotIds: [...options.dotIds] } : {}),
            ...(options.userIds?.length ? { userIds: [...options.userIds] } : {}),
            ...(options.description?.trim() ? { description: options.description.trim() } : {}),
        }),
    convert: (id: string) => api<Conversation>(`${room(id)}/convert`, 'POST', { confirmHistory: true }),
    view: (id: string, signal?: AbortSignal) => api<RoomView>(room(id), 'GET', undefined, signal),
    rename: (id: string, title: string) => api<RoomView>(room(id), 'PATCH', { title }),
    archive: (id: string) => api<RoomView>(`${room(id)}/archive`, 'POST'),
    unarchive: (id: string) => api<RoomView>(`${room(id)}/unarchive`, 'POST'),
    invites: (signal?: AbortSignal) => api<RoomInvite[]>('/rooms/invites', 'GET', undefined, signal),
    /** People the maker may invite as they create a room (CB-278). */
    inviteCandidates: (signal?: AbortSignal) => api<RoomPerson[]>('/rooms/people', 'GET', undefined, signal),
    invitable: (id: string, signal?: AbortSignal) =>
        api<RoomPerson[]>(`${room(id)}/invitable`, 'GET', undefined, signal),
    invite: (id: string, userId: string, role: RoomRole = 'member') =>
        api<unknown>(`${room(id)}/invites`, 'POST', { userId, role }),
    accept: (id: string, disclosureVersion: number) =>
        api<RoomView>(`${room(id)}/accept`, 'POST', { disclosureVersion }),
    decline: (id: string) => api<{ ok: true }>(`${room(id)}/decline`, 'POST'),
    leave: (id: string) => api<{ ok: true }>(`${room(id)}/leave`, 'POST'),
    setRole: (id: string, userId: string, role: RoomRole) =>
        api<RoomView>(`${room(id)}/members/${encodeURIComponent(userId)}`, 'PATCH', { role }),
    remove: (id: string, userId: string) =>
        api<RoomView>(`${room(id)}/members/${encodeURIComponent(userId)}`, 'DELETE'),
    requestSocio: (id: string, dotId: string) => api<unknown>(`${room(id)}/socios`, 'POST', { dotId }),
    removeSocio: (id: string, dotId: string) =>
        api<RoomView>(`${room(id)}/socios/${encodeURIComponent(dotId)}`, 'DELETE'),
    setLead: (id: string, dotId: string) => api<RoomView>(`${room(id)}/lead`, 'PUT', { dotId }),
    // Its use and limits (CB-218): admins', and members' when shown.
    usage: (id: string, signal?: AbortSignal) => api<RoomUsageView>(`${room(id)}/usage`, 'GET', undefined, signal),
    // Workspace admins: the socios rooms asked for, and letting them in.
    socioRequests: (signal?: AbortSignal) => api<RoomSocioRequest[]>('/rooms/socio-requests', 'GET', undefined, signal),
    authorizeSocio: (id: string, dotId: string) =>
        api<unknown>(`${room(id)}/socios/${encodeURIComponent(dotId)}/authorize`, 'POST'),
    // The room's limits (its admins, and members when Settings → Rooms
    // shows them its use; room admins only lower them, CB-206).
    limits: (id: string, signal?: AbortSignal) => api<RoomLimitsView>(`${room(id)}/limits`, 'GET', undefined, signal),
    setLimits: (id: string, limits: Partial<RoomLimits>) => api<RoomLimitsView>(`${room(id)}/limits`, 'PUT', limits),
    // Its handoff limit, for every member (not budget data).
    handoffLimit: (id: string, signal?: AbortSignal) =>
        api<RoomHandoffLimitView>(`${room(id)}/limits/handoffs`, 'GET', undefined, signal),
    withdrawSocio: (id: string, dotId: string) =>
        api<{ ok: true }>(`${room(id)}/socios/${encodeURIComponent(dotId)}/withdraw`, 'POST'),
    // A room's Telegram topic (CB-214).
    topic: (id: string, signal?: AbortSignal) => api<RoomTopicView>(`${room(id)}/telegram`, 'GET', undefined, signal),
    topicCode: (id: string) =>
        api<RoomTopicCode>(`${room(id)}/telegram/code`, 'POST', {
            confirmAudience: true,
        }),
    unbindTopic: (id: string) => api<{ unbound: boolean }>(`${room(id)}/telegram`, 'DELETE'),
    /** A legacy team topic, made a room by one of its readers. */
    convertTopicCode: (threadId: string) =>
        api<RoomTopicCode>(`/rooms/telegram/topics/${encodeURIComponent(threadId)}/code`, 'POST', {
            confirmAudience: true,
        }),
};

/**
 * A room's pinned facts and notes (CB-217): one function per route. Each
 * change answers what it did and the room's pins as they are now.
 */
export const pinsApi = {
    state: (id: string, signal?: AbortSignal) => api<RoomPinsState>(`${room(id)}/pins`, 'GET', undefined, signal),
    pin: (id: string, text: string, origin: RoomPinOrigin = 'person') =>
        api<RoomPinOutcome>(`${room(id)}/pins`, 'POST', { text, origin }),
    edit: (id: string, pinId: string, text: string, baseVersion: number) =>
        api<RoomPinOutcome>(`${room(id)}/pins/${encodeURIComponent(pinId)}`, 'PUT', { text, baseVersion }),
    unpin: (id: string, pinId: string, baseVersion: number) =>
        api<RoomPinOutcome>(`${room(id)}/pins/${encodeURIComponent(pinId)}?baseVersion=${baseVersion}`, 'DELETE'),
    history: (id: string, pinId: string, signal?: AbortSignal) =>
        api<RoomPinVersion[]>(`${room(id)}/pins/${encodeURIComponent(pinId)}/history`, 'GET', undefined, signal),
    decide: (id: string, proposalId: string, action: 'approve' | 'reject' | 'withdraw') =>
        api<RoomPinOutcome>(`${room(id)}/pin-proposals/${encodeURIComponent(proposalId)}/${action}`, 'POST'),
};

/** What a failed request says, for a toast or an alert. */
export const failure = (error: unknown, fallback: string) =>
    error instanceof Error && error.message ? error.message : fallback;

/** The refusal's code (`RoomRefusal`), when the server gave one. */
export const refusal = (error: unknown) => (error instanceof ApiError ? error.code : undefined);
