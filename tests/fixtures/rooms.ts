import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AbstractAgent, EventType, type BaseEvent, type Message, type RunAgentInput } from '@ag-ui/client';
import { lastValueFrom, Observable } from 'rxjs';

import { ROOM_DISCLOSURE_VERSION } from '@socio/shared/rooms/rooms';
import { SENDER_METADATA, type User } from '@socio/shared/types';

import { MockAuthProvider } from '../../src/server/auth/mock.js';
import type { PlatformConfig } from '../../src/server/composition/config.js';
import type { LocalAgentRunner } from '../../src/server/turns/local-runner.js';
import { makeTestRuntime } from '../helpers/test-runtime.js';

/**
 * Rooms (CB-208) end to end: a platform with the app's routes, Rooms on
 * from the environment, and the people of the access matrix. A private
 * chat of Olive's; a room Ada made, with Mo a member, Rex removed and
 * Ivy invited but not joined; Alice is a workspace admin in none of it,
 * Nina a member of the workspace in none of it.
 */
export const ROOM_PEOPLE: User[] = [
    { id: 'alice', name: 'Alice', role: 'admin' },
    { id: 'olive', name: 'Olive', role: 'member' },
    { id: 'ada', name: 'Ada', role: 'member' },
    { id: 'mo', name: 'Mo', role: 'member' },
    { id: 'rex', name: 'Rex', role: 'member' },
    { id: 'ivy', name: 'Ivy', role: 'member' },
    { id: 'nina', name: 'Nina', role: 'member' },
];

export type Caller = (path: string, method?: string, body?: unknown) => Promise<Response>;

export async function roomsFixture(
    cleanup: Array<() => unknown>,
    {
        enabled = true,
        now,
        config = {},
    }: {
        enabled?: boolean;
        now?: () => number;
        /** More platform settings (a model's, CB-209). */
        config?: Partial<PlatformConfig>;
    } = {},
) {
    const dir = mkdtempSync(join(tmpdir(), 'rooms-'));
    const { store, workspace, platform, edge, app, dispose } = await makeTestRuntime({
        config: {
            apiKey: '',
            model: '',
            rooms: { enabled },
            data: { userDataDir: dir },
            ...config,
        },
        app: {
            auth: {
                provider: new MockAuthProvider(ROOM_PEOPLE, 'rooms-matrix-secret-0123456789abcdef'),
                secureCookies: false,
            },
        },
    });
    cleanup.push(async () => {
        try {
            await dispose();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
    if (now) {
        (platform.rooms as unknown as { now: () => number }).now = now;
    }
    for (const user of ROOM_PEOPLE) {
        workspace.recordUser(user);
    }
    const cookies = new Map<string, string>();
    const as = (userId: string): Caller => {
        return async (path, method = 'GET', body) => {
            let cookie = cookies.get(userId);
            if (!cookie) {
                const login = await app.request('/api/auth/mock/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ userId }),
                });
                cookie = login.headers.get('set-cookie')!.split(';')[0]!;
                cookies.set(userId, cookie);
            }
            return app.request(`/api${path}`, {
                method,
                headers: {
                    cookie,
                    // State changes are JSON requests (the app's CSRF guard).
                    ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }),
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
        };
    };
    const company = workspace.companyDots()[0]!;
    return { store, workspace, platform, edge, app, as, company, dir };
}

/** The matrix's chats: Olive's private one and Ada's room, as described. */
export async function matrixChats(f: Awaited<ReturnType<typeof roomsFixture>>) {
    f.workspace.bindThread('olive-chat', f.company.id, 'Olive’s plans', 'olive');
    const ada = f.as('ada');
    const made = await ada('/rooms', 'POST', {
        dotId: f.company.id,
        title: 'Launch',
    });
    if (made.status !== 201) {
        throw new Error(`room: ${made.status}`);
    }
    const room = (await made.json()) as { id: string };
    for (const person of ['mo', 'rex', 'ivy']) {
        await ada(`/rooms/${room.id}/invites`, 'POST', { userId: person });
    }
    for (const person of ['mo', 'rex']) {
        await f.as(person)(`/rooms/${room.id}/accept`, 'POST', {
            disclosureVersion: ROOM_DISCLOSURE_VERSION,
        });
    }
    const removed = await ada(`/rooms/${room.id}/members/rex`, 'DELETE');
    if (removed.status !== 200) {
        throw new Error(`remove: ${removed.status}`);
    }
    return { privateId: 'olive-chat', roomId: room.id };
}

/** A tool-calling turn in a chat, run through the runner as `person`'s. */
export class ToolAgent extends AbstractAgent {
    constructor(private call: { id: string; result: string }) {
        super({});
    }
    run(input: RunAgentInput): Observable<BaseEvent> {
        return new Observable<BaseEvent>((subscriber) => {
            const { threadId, runId } = input;
            const next = (event: object) => subscriber.next(event as BaseEvent);
            next({ type: EventType.RUN_STARTED, threadId, runId });
            next({
                type: EventType.TOOL_CALL_START,
                toolCallId: this.call.id,
                toolCallName: 'calendar_read',
                parentMessageId: `m-${runId}`,
            });
            next({
                type: EventType.TOOL_CALL_ARGS,
                toolCallId: this.call.id,
                delta: '{}',
            });
            next({ type: EventType.TOOL_CALL_END, toolCallId: this.call.id });
            next({
                type: EventType.TOOL_CALL_RESULT,
                messageId: `r-${runId}`,
                toolCallId: this.call.id,
                content: this.call.result,
                role: 'tool',
            });
            next({
                type: EventType.TEXT_MESSAGE_START,
                messageId: `t-${runId}`,
                role: 'assistant',
            });
            next({
                type: EventType.TEXT_MESSAGE_CONTENT,
                messageId: `t-${runId}`,
                delta: 'Done.',
            });
            next({ type: EventType.TEXT_MESSAGE_END, messageId: `t-${runId}` });
            next({ type: EventType.RUN_FINISHED, threadId, runId });
            subscriber.complete();
        });
    }
}

/**
 * A turn in `threadId` started by `person`'s message, run through the
 * runner as the web chat runs it: its trigger is that person (CB-185).
 */
export const runAs = async (
    runner: LocalAgentRunner,
    dotId: string,
    threadId: string,
    runId: string,
    person: string,
    agent: AbstractAgent,
) => {
    const messages: Message[] = [
        {
            id: `u-${runId}`,
            role: 'user',
            content: 'What is on today?',
            metadata: { [SENDER_METADATA]: person },
        } as Message,
    ];
    agent.agentId = dotId;
    agent.threadId = threadId;
    agent.setMessages(messages);
    return lastValueFrom(
        runner.run({
            threadId,
            agent,
            input: {
                threadId,
                runId,
                messages,
                state: {},
                tools: [],
                context: [],
                forwardedProps: {},
            },
            signals: { trigger: { kind: 'person', id: person } },
        }),
        { defaultValue: undefined },
    ).catch(() => undefined);
};
