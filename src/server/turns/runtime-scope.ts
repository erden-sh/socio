import type { RoomAction } from '@socio/shared/rooms/rooms';

import type { RuntimeScope, RuntimeScopeWorkspace } from './contract.js';

/**
 * Admits a runtime request (AG-UI `run`, `connect`, `stop`) only on a
 * conversation its person may act in, by the one rule (CB-208): a private
 * chat's owner, as before; in a room an active member sends (`run`), may
 * stop (the caller then checks the cycle's initiator, `mayStop`) and
 * connects (`read`, also archived or with Rooms off). A room's connect is
 * served by the caller as that member's own stream (CB-212,
 * `conversationStream`): other people's private results withheld, and
 * closed when their membership ends.
 */
export function validateRuntimeScope(
    request: Request,
    workspace: RuntimeScopeWorkspace,
    body: unknown,
    userId: string,
): RuntimeScope {
    const url = new URL(request.url);
    const prefix = '/api/copilotkit/';
    const deny = () => {
        throw new Error('This runtime route is not enabled in Socio.');
    };
    if (!url.pathname.startsWith(prefix)) {
        return deny();
    }
    const path = url.pathname.slice(prefix.length);
    const data = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    const id = (value: string) => {
        const decoded = decodeURIComponent(value);
        if (!decoded || /[/\\\s]/.test(decoded)) {
            return deny();
        }
        return decoded;
    };
    let agentId: string | undefined;
    let threadId: string | undefined;
    let methods: string[];
    let action: RoomAction | undefined;
    let match: RegExpMatchArray | null;
    // Match the whole path. The SDK accepts suffix matches, so accepting arbitrary
    // prefixes here would validate a different thread than the SDK dispatches.
    // Thread list/messages/state routes are Intelligence-only; the app serves
    // its own conversation list, so only agent execution is exposed here.
    // Not suggestions either (CB-225): the app asks for none, and one would
    // run the socio, tools and all, on whatever conversation a request sent.
    if (path === 'info') {
        methods = ['GET'];
    } else if ((match = path.match(/^agent\/([^/]+)\/(run|connect)$/))) {
        agentId = id(match[1]);
        threadId = typeof data.threadId === 'string' ? data.threadId : undefined;
        if (!threadId) {
            return deny();
        }
        methods = ['POST'];
        action = match[2] === 'run' ? 'send' : 'read';
    } else if ((match = path.match(/^agent\/([^/]+)\/stop\/([^/]+)$/))) {
        agentId = id(match[1]);
        threadId = id(match[2]);
        methods = ['POST'];
        action = 'stop';
    } else {
        return deny();
    }
    if (!methods.includes(request.method)) {
        return deny();
    }
    const bodyAgent = typeof data.agentId === 'string' ? data.agentId : undefined;
    const queryAgent = url.searchParams.get('agentId') ?? undefined;
    for (const candidate of [agentId, bodyAgent, queryAgent]) {
        if (candidate && (!workspace.dot(candidate) || (agentId && candidate !== agentId))) {
            return deny();
        }
    }
    agentId ??= bodyAgent ?? queryAgent;
    for (const candidate of [
        threadId,
        typeof data.threadId === 'string' ? data.threadId : undefined,
        url.searchParams.get('threadId') ?? undefined,
    ]) {
        if (candidate) {
            if (threadId && candidate !== threadId) {
                return deny();
            }
            if (workspace.thread(candidate)?.kind !== 'room') {
                workspace.requireOwnedThread(userId, candidate, agentId);
            } else if (!action) {
                return deny();
            } else {
                workspace.requireAccess(
                    userId,
                    candidate,
                    // Stopping is checked against the running cycle by the caller.
                    action === 'stop' ? 'read' : action,
                    agentId,
                );
            }
        }
    }
    const candidate =
        threadId ??
        (typeof data.threadId === 'string' ? data.threadId : undefined) ??
        url.searchParams.get('threadId') ??
        undefined;
    return {
        ...(candidate ? { threadId: candidate } : {}),
        ...(action ? { action } : {}),
        ...(candidate && workspace.thread(candidate)?.kind === 'room' ? { room: true } : {}),
    };
}
