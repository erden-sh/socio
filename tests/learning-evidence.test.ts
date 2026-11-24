import type { RunAgentInput } from '@ag-ui/core';
import { lastValueFrom, toArray } from 'rxjs';
import { afterEach, expect, it } from 'vitest';

import { ScriptAgent } from './fixtures/script-agent.js';
import { LocalAgentRunner } from './helpers/runners.js';
import { WorkspaceStore } from './helpers/stores.js';
import { testDatabase } from './helpers/test-database.js';
import { makeTestRuntime } from './helpers/test-runtime.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

/** `workspace`: the runtime's; a workspace of its own by default. */
function fixture(workspace?: WorkspaceStore) {
    if (!workspace) {
        const own = new WorkspaceStore(testDatabase());
        cleanup.push(() => own.close());
        workspace = own;
    }
    const dot = workspace.dots()[0];
    workspace.updateDot(dot.id, { ...dot, learningContainerId: 'research' });
    const bind = (id: string, owner = 'alice') => workspace.bindThread(id, dot.id, id, owner);
    return { workspace, evidence: workspace.evidence, dot, bind };
}

it('counts threads whose latest run finished, once each', () => {
    const { evidence, bind } = fixture();
    bind('t1');
    bind('t2', 'bob');
    evidence.record('t1', 'finished', 10);
    evidence.record('t1', 'finished', 20);
    evidence.record('t1', 'finished', 30);
    evidence.record('t2', 'finished', 15);
    expect(evidence.count('research')).toBe(2);
    expect(evidence.pending('research')).toEqual([
        {
            threadId: 't2',
            dotId: expect.any(String),
            ownerId: 'bob',
            finishedAt: 15,
        },
        {
            threadId: 't1',
            dotId: expect.any(String),
            ownerId: 'alice',
            finishedAt: 30,
        },
    ]);
});

it('excludes threads whose latest run failed or stopped', () => {
    const { evidence, bind } = fixture();
    bind('failed');
    bind('stopped');
    bind('interrupted');
    bind('recovered');
    evidence.record('failed', 'finished', 1);
    evidence.record('failed', 'failed', 2);
    evidence.record('stopped', 'stopped', 3);
    evidence.record('interrupted', 'interrupted', 4);
    evidence.record('recovered', 'failed', 5);
    evidence.record('recovered', 'finished', 6);
    expect(evidence.pending('research').map((t) => t.threadId)).toEqual(['recovered']);
});

it('ignores threads without a container and counts only evidence since the last analysis', () => {
    const { workspace, evidence, dot, bind } = fixture();
    workspace.updateDot(dot.id, { ...dot, learningContainerId: null });
    bind('outside');
    evidence.record('outside', 'finished', 1);
    evidence.record('unknown-thread', 'finished', 1);
    expect(evidence.containers()).toEqual([]);
    workspace.updateDot(dot.id, { ...dot, learningContainerId: 'research' });
    bind('a');
    bind('b');
    evidence.record('a', 'finished', 10);
    evidence.record('b', 'finished', 20);
    evidence.markAnalyzed('research', 20);
    expect(evidence.count('research')).toBe(0);
    // A thread analyzed before counts again once it has a newer finished run.
    evidence.record('a', 'finished', 30);
    expect(evidence.pending('research').map((t) => t.threadId)).toEqual(['a']);
    // The cursor never moves backwards.
    evidence.markAnalyzed('research', 5);
    expect(evidence.analyzedThrough('research')).toBe(20);
});

it('records evidence when the platform runner finishes a run', async () => {
    const runner = new LocalAgentRunner(testDatabase());
    const runtime = await makeTestRuntime({
        config: { baseUrl: '', apiKey: '', model: '', runtimeUrl: '' },
        runner,
    });
    cleanup.push(runtime.dispose);
    const { workspace, bind } = fixture(runtime.workspace);
    bind('live');
    const agent = new ScriptAgent('done');
    agent.threadId = 'live';
    const input: RunAgentInput = {
        threadId: 'live',
        runId: 'r1',
        messages: [{ id: 'u1', role: 'user', content: 'hello' }],
        state: {},
        tools: [],
        context: [],
        forwardedProps: {},
    };
    agent.setMessages(input.messages);
    await lastValueFrom(runner.run({ threadId: 'live', agent, input }).pipe(toArray()));
    expect(workspace.evidence.pending('research').map((t) => t.threadId)).toEqual(['live']);
});
