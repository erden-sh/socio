import { EventType, type BaseEvent, type RunAgentInput } from '@ag-ui/client';
import { Observable } from 'rxjs';
import { afterEach, expect, it } from 'vitest';

import { voiceReceiptMessagePrefix } from '@socio/shared/voice/voice-receipt';

import { runThreadTurn } from '../src/server/turns/headless.js';

import { ScriptAgent } from './fixtures/script-agent.js';
import { LocalAgentRunner } from './helpers/runners.js';
import { testDatabase } from './helpers/test-database.js';

const runners: LocalAgentRunner[] = [];
afterEach(() => runners.splice(0).forEach((runner) => runner.close()));
function runner() {
    const instance = new LocalAgentRunner(testDatabase(), { flushIntervalMs: 5 });
    runners.push(instance);
    return instance;
}

class FailingAgent extends ScriptAgent {
    run(input: RunAgentInput): Observable<BaseEvent> {
        return new Observable<BaseEvent>((subscriber) => {
            subscriber.next({
                type: EventType.RUN_STARTED,
                threadId: input.threadId,
                runId: input.runId,
            } as BaseEvent);
            subscriber.next({
                type: EventType.RUN_ERROR,
                message: 'Model provider returned HTTP 503.',
            } as BaseEvent);
            subscriber.complete();
        });
    }
}

it('runs a server turn in process and stores it with the thread history', async () => {
    const target = runner();
    expect(
        await runThreadTurn(
            target,
            new ScriptAgent('First answer'),
            'thread',
            'First question',
            new AbortController().signal,
        ),
    ).toBe('First answer');
    expect(
        await runThreadTurn(
            target,
            new ScriptAgent('Second answer'),
            'thread',
            'Follow-up',
            new AbortController().signal,
        ),
    ).toBe('Second answer');
    expect((await target.messages('thread')).map((m) => [m.role, m.content])).toEqual([
        ['user', 'First question'],
        ['assistant', 'First answer'],
        ['user', 'Follow-up'],
        ['assistant', 'Second answer'],
    ]);
});

it('marks voice receipt prompts so the transcript can hide them', async () => {
    const target = runner();
    await runThreadTurn(target, new ScriptAgent('Noted'), 'thread', 'Call summary', new AbortController().signal, {
        socioSource: 'voice_receipt',
    });
    const [prompt] = await target.messages('thread');
    expect(prompt.id.startsWith(voiceReceiptMessagePrefix)).toBe(true);
});

it('surfaces a run error instead of returning an earlier answer', async () => {
    const target = runner();
    await runThreadTurn(target, new ScriptAgent('Old answer'), 'thread', 'First', new AbortController().signal);
    await expect(
        runThreadTurn(target, new FailingAgent('unused'), 'thread', 'Second', new AbortController().signal),
    ).rejects.toThrow('Model provider returned HTTP 503.');
});

it('stops the run when the caller aborts', async () => {
    const target = runner();
    const agent = new ScriptAgent('never finishes', true);
    const controller = new AbortController();
    const turn = runThreadTurn(target, agent, 'thread', 'Long task', controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort(new Error('Run stopped.'));
    await expect(turn).rejects.toThrow('Run stopped.');
    expect(agent.aborted).toBe(true);
    expect(await target.isRunning({ threadId: 'thread' })).toBe(false);
});

it('refuses a server turn while the thread is already running', async () => {
    const target = runner();
    const busy = new ScriptAgent('busy', true);
    const first = runThreadTurn(target, busy, 'thread', 'First', new AbortController().signal);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(
        runThreadTurn(target, new ScriptAgent('second'), 'thread', 'Second', new AbortController().signal),
    ).rejects.toThrow('Thread already running');
    busy.abortRun();
    await first.catch(() => undefined);
});
