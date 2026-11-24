import { DatabaseSync } from 'node:sqlite';

import { afterEach, expect, it, vi } from 'vitest';

import { migrate } from '@socio/data/migrate';

import { execPlan, sandboxConfig } from '../deployment/computers/coding-sandbox.mjs';
import {
    codingHarnesses,
    DEFAULT_HARNESS,
    HarnessRegistry,
    parseDisabledHarnesses,
    type CodingHarness,
} from '../src/server/coding/harness.js';
import { opencodeHarness, readOpenCode } from '../src/server/coding/opencode.js';
import { codingConfigFromEnv } from '../src/server/coding/sessions.js';
import { gatewaySchema } from '../src/server/gateway/schema.js';

import { REPO, codingWorld, eventually, openCodeOutput } from './support/coding-fixture.js';

// CB-326: the coding harness port, with OpenCode as its one
// adapter and no change in what a session sends or reads; sessions record
// their harness; CODING_HARNESSES_DISABLED stops a harness's new sessions.

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    vi.restoreAllMocks();
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

const identity = { name: 'Rulo (Socio)', email: 'socio-a1b2c3d4@users.noreply.apps.example.com' };
const sandbox = sandboxConfig({ CODING_SANDBOX_IMAGE: `socio-coding@sha256:${'a'.repeat(64)}` }, 'company-brain');

const fake = (id: string): CodingHarness => ({
    ...opencodeHarness,
    id,
    label: id,
});

// ---------------------------------------------------------------------------
// The registry

it('knows OpenCode (the default), Codex, Claude Code, Gemini CLI and Grok Build as this build’s harnesses, all on the gateway route', () => {
    const registry = codingHarnesses();
    // CB-326 added Codex, Claude Code, Gemini CLI and Grok Build.
    expect(registry.list().map((harness) => harness.id)).toEqual([
        'opencode',
        'codex',
        'claude-code',
        'gemini-cli',
        'grok',
    ]);
    expect(registry.list().every((harness) => harness.modelRoute === 'gateway' && !harness.credential)).toBe(true);
    expect(DEFAULT_HARNESS).toBe('opencode');
    const harness = registry.get('opencode')!;
    expect(harness).toBe(opencodeHarness);
    expect(harness).toMatchObject({
        label: 'OpenCode',
        modelRoute: 'gateway',
        image: { name: 'socio-coding', pin: 'deployment/coding/opencode.pin' },
    });
    expect(harness.credential).toBeUndefined();
    expect(registry.get('aider')).toBeUndefined();
    expect(registry.has('aider')).toBe(false);
    // Only Responses speakers may run on a person's own plan.
    expect(
        registry
            .list()
            .filter((item) => item.personalPlans)
            .map((item) => item.id),
    ).toEqual(['opencode', 'codex']);
});

it('registers harnesses by a plain unique id', () => {
    const registry = new HarnessRegistry([opencodeHarness]);
    registry.register(fake('aider'));
    expect(registry.list().map((harness) => harness.id)).toEqual(['opencode', 'aider']);
    expect(() => registry.register(fake('opencode'))).toThrow(/registered already/);
    for (const bad of ['', 'Codex', 'has space', '-lead', 'a/b', 'x'.repeat(41)]) {
        expect(() => registry.register(fake(bad))).toThrow(/harness id/);
    }
    // Each build makes its own: a test's registration leaks nowhere.
    expect(codingHarnesses().has('aider')).toBe(false);
});

// ---------------------------------------------------------------------------
// The OpenCode adapter: the same command and the same reading as before

it('builds the same prompt exec sessions always sent, and the supervisor runs the same opencode command', () => {
    const run = { session: 'ses_socio_abc', model: 'orion', prompt: 'Fix it', seconds: 1200, identity };
    // What sessions.ts sent before CB-326, literally.
    expect(opencodeHarness.command(run)).toEqual({
        kind: 'prompt',
        params: { session: 'ses_socio_abc', model: 'orion', prompt: 'Fix it', seconds: 1200, identity },
    });
    expect(opencodeHarness.command({ ...run, plan: null })).toEqual(opencodeHarness.command(run));
    // A person's own plan speaks the Responses API.
    expect(opencodeHarness.command({ ...run, model: 'byo-chatgpt', plan: 'byo-chatgpt' })).toEqual({
        kind: 'prompt',
        params: {
            session: 'ses_socio_abc',
            model: 'byo-chatgpt',
            prompt: 'Fix it',
            seconds: 1200,
            identity,
            api: 'responses',
        },
    });
    const plan = execPlan('prompt', opencodeHarness.command(run).params, sandbox);
    expect(plan.ok).toBe(true);
    if (plan.ok) {
        expect(plan.value.argv.slice(plan.value.argv.indexOf('opencode'))).toEqual([
            'opencode',
            'run',
            '--standalone',
            '--format',
            'json',
            '--session',
            'ses_socio_abc',
            '--model',
            'socio/orion',
            '--auto',
        ]);
        expect(plan.value.stdin).toBe('Fix it');
    }
    const responses = execPlan(
        'prompt',
        opencodeHarness.command({ ...run, model: 'byo-chatgpt', plan: 'byo-chatgpt' }).params,
        sandbox,
    );
    expect(responses.ok && responses.value.argv).toContain('socio-responses/byo-chatgpt');
});

it('reads output exactly as readOpenCode does', () => {
    const token = `cbgw_${'Z'.repeat(43)}`;
    const samples = [
        '',
        openCodeOutput('Done: the flaky test now waits for the server.'),
        openCodeOutput(`Leaked ${token}`, [{ type: 'error', error: { message: 'rate limited' } }]),
        'plain line\n{broken json\n{"type":"text","sessionID":"../x","part":{"type":"text","text":"hi"}}',
        'x'.repeat(300_000),
    ];
    for (const stdout of samples) {
        expect(opencodeHarness.read(stdout)).toEqual(readOpenCode(stdout));
    }
    expect(opencodeHarness.read(samples[1]!)).toMatchObject({
        sessionId: 'ses_fake01',
        summary: 'Done: the flaky test now waits for the server.',
        errored: false,
    });
});

// ---------------------------------------------------------------------------
// The kill switch's setting

it('reads CODING_HARNESSES_DISABLED as plain ids, empty by default, and refuses a malformed list at start', () => {
    expect(parseDisabledHarnesses(undefined)).toEqual([]);
    expect(parseDisabledHarnesses('')).toEqual([]);
    expect(parseDisabledHarnesses(' OpenCode , codex,,opencode ')).toEqual(['opencode', 'codex']);
    expect(() => parseDisabledHarnesses('opencode, not an id')).toThrow(/CODING_HARNESSES_DISABLED/);
    const platform = {};
    expect(codingConfigFromEnv({}, platform).disabledHarnesses).toEqual([]);
    expect(codingConfigFromEnv({ CODING_HARNESSES_DISABLED: 'opencode' }, platform).disabledHarnesses).toEqual([
        'opencode',
    ]);
    expect(() => codingConfigFromEnv({ CODING_HARNESSES_DISABLED: 'a;b' }, platform)).toThrow(
        /CODING_HARNESSES_DISABLED/,
    );
});

// ---------------------------------------------------------------------------
// Sessions: the harness recorded, the kill switch applied

async function setup() {
    const world = await codingWorld();
    cleanup.push(() => world.close());
    vi.spyOn(world.turns, 'turnOutcome').mockResolvedValue({ text: 'Noted.' } as never);
    // The fake agent ends each prompt at once.
    world.supervisor.behavior.onPrompt = (exec) => world.supervisor.finish(exec.runId);
    return world;
}

it('records opencode as a new session’s harness, and runs its prompts through it', async () => {
    const world = await setup();
    const { session } = await world.started();
    expect(session!.harness).toBe('opencode');
    await eventually(() => world.service.sessions.get(session!.id)!.state === 'ready');
    const answer = await world.tool('coding_prompt')({ message: 'Fix the test' });
    expect(answer).toMatchObject({ status: 'done', agentSaid: 'Done: the flaky test now waits for the server.' });
    expect(world.service.sessions.get(session!.id)!.opencodeSession).toBe('ses_fake01');
});

it('starts no new session with a disabled harness, says so, and lets running sessions carry on', async () => {
    const world = await setup();
    // Another harness's switch leaves OpenCode alone.
    world.service.configure({ disabledHarnesses: ['codex'] });
    const { session } = await world.started();
    await eventually(() => world.service.sessions.get(session!.id)!.state === 'ready');
    world.service.configure({ disabledHarnesses: ['opencode'] });
    const refused = await world.tool('coding_start')({ repository: REPO, task: 'Another fix' });
    expect(refused).toMatchObject({
        status: 'refused',
        error: expect.stringContaining('OpenCode is turned off for coding sessions on this server'),
    });
    expect((await world.platform.approvals.list('alice')).filter((item) => item.status === 'pending')).toEqual([]);
    // The session that was running still takes prompts.
    expect(await world.tool('coding_prompt')({ message: 'Keep going' })).toMatchObject({ status: 'done' });
});

it('starts nothing when the harness is disabled between the card and the click', async () => {
    const world = await setup();
    const asked = await world.tool('coding_start')({ repository: REPO, task: 'Fix it', push: true });
    expect(asked.status).toBe('pending_approval');
    world.service.configure({ disabledHarnesses: ['opencode'] });
    const approval = (asked.approval as { id: string }).id;
    await world.platform.approvals.decide(approval, 'alice', true).catch(() => undefined);
    expect(world.service.sessions.ofPerson('alice', 5)).toEqual([]);
    expect(world.supervisor.requests.filter((request) => request.method !== 'GET')).toEqual([]);
});

// ---------------------------------------------------------------------------
// Choosing the harness (CB-326)

const THREAD = '0199a213-81c0-7800-8aa1-bbab2a035a53';
const codexStdout = (text: string) =>
    [
        { type: 'thread.started', thread_id: THREAD },
        { type: 'item.completed', item: { id: 'i1', type: 'agent_message', text } },
        { type: 'turn.completed' },
    ]
        .map((event) => JSON.stringify(event))
        .join('\n') + '\n';

it('starts a session with the harness the socio named, says so on the card, and resumes its thread', async () => {
    const world = await setup();
    world.supervisor.behavior.onPrompt = (exec) =>
        world.supervisor.finish(exec.runId, { stdout: codexStdout('Codex fixed it.') });
    const { asked, session } = await world.started({ harness: 'Codex' });
    const view = await world.platform.approvals.get((asked.approval as { id: string }).id, 'alice');
    expect(view.card).toMatchObject({ harness: { id: 'codex', label: 'Codex', route: 'gateway' } });
    expect(view.details).toContain('Coding agent: Codex, on Socio’s model gateway.');
    expect(session!.harness).toBe('codex');
    await eventually(() => world.service.sessions.get(session!.id)!.state === 'ready');
    expect(await world.tool('coding_prompt')({ message: 'Fix the test' })).toMatchObject({
        status: 'done',
        agentSaid: 'Codex fixed it.',
        session: { harness: 'codex' },
    });
    // The first prompt started a thread; the next resumes the one Codex named.
    const [first] = world.supervisor.prompts();
    expect(first!.params).toMatchObject({ harness: 'codex', model: 'orion' });
    expect(first!.params.session).toBeUndefined();
    expect(world.service.sessions.get(session!.id)!.opencodeSession).toBe(THREAD);
    await world.tool('coding_prompt')({ message: 'And the docs' });
    expect(world.supervisor.prompts().at(-1)!.params).toMatchObject({ harness: 'codex', session: THREAD });
    expect((await world.service.cardView(world.service.sessions.get(session!.id)!)).harnessLabel).toBe('Codex');
});

it('refuses an unknown or disabled harness by name, listing what is available', async () => {
    const world = await setup();
    world.service.configure({ disabledHarnesses: ['claude-code'] });
    const unknown = await world.tool('coding_start')({ repository: REPO, task: 'Fix it', harness: 'aider' });
    expect(unknown).toMatchObject({
        status: 'refused',
        error: expect.stringContaining('Available: opencode, codex, gemini-cli, grok.'),
    });
    const off = await world.tool('coding_start')({ repository: REPO, task: 'Fix it', harness: 'claude-code' });
    expect(off).toMatchObject({
        status: 'refused',
        error: expect.stringContaining('Claude Code is turned off for coding sessions on this server'),
    });
    expect((await world.platform.approvals.list('alice')).filter((item) => item.status === 'pending')).toEqual([]);
    // The switch shows in Settings → Coding's list too.
    expect(world.service.harnessViews().map((item) => [item.id, item.disabled, item.default])).toEqual([
        ['opencode', false, true],
        ['codex', false, false],
        ['claude-code', true, false],
        ['gemini-cli', false, false],
        ['grok', false, false],
    ]);
});

it('refuses Gemini CLI and Grok Build on a person’s own plan, naming the agents that can run on one', async () => {
    const world = await setup();
    for (const [harness, label] of [
        ['gemini-cli', 'Gemini CLI'],
        ['grok', 'Grok Build'],
    ]) {
        const refused = await world.tool('coding_start')({
            repository: REPO,
            task: 'Fix it',
            harness,
            model: 'byo:byo-chatgpt',
        });
        expect(refused).toMatchObject({
            status: 'refused',
            error: `${label} can’t run on a person’s own plan; OpenCode or Codex can. Or run ${label} with a listed model.`,
        });
    }
});

it('turns Gemini CLI and Grok Build off with the kill switch, like any harness', async () => {
    const world = await setup();
    world.service.configure({ disabledHarnesses: parseDisabledHarnesses('gemini-cli, GROK') });
    for (const [harness, label] of [
        ['gemini-cli', 'Gemini CLI'],
        ['grok', 'Grok Build'],
    ]) {
        const off = await world.tool('coding_start')({ repository: REPO, task: 'Fix it', harness });
        expect(off).toMatchObject({
            status: 'refused',
            error: expect.stringContaining(`${label} is turned off for coding sessions on this server`),
        });
    }
    expect(world.service.harnessChoices().map((item) => item.id)).toEqual(['opencode', 'codex', 'claude-code']);
});

it('refuses Claude Code on a person’s own plan, which takes the Responses API only', async () => {
    const world = await setup();
    const refused = await world.tool('coding_start')({
        repository: REPO,
        task: 'Fix it',
        harness: 'claude-code',
        model: 'byo:byo-chatgpt',
    });
    expect(refused).toMatchObject({
        status: 'refused',
        error: expect.stringContaining('Claude Code can’t run on a person’s own plan'),
    });
});

it('starts nothing when the card’s harness is disabled between the card and the click', async () => {
    const world = await setup();
    const asked = await world.tool('coding_start')({ repository: REPO, task: 'Fix it', harness: 'claude-code' });
    expect(asked.status).toBe('pending_approval');
    world.service.configure({ disabledHarnesses: ['claude-code'] });
    await world.platform.approvals.decide((asked.approval as { id: string }).id, 'alice', true).catch(() => undefined);
    expect(world.service.sessions.ofPerson('alice', 5)).toEqual([]);
});

it('offers the harness choice on coding_start, validated as a short string', async () => {
    const world = await setup();
    const tool = world.tools(world.turnOf()).find((item) => item.name === 'coding_start')!;
    const schema = (
        tool as unknown as {
            parameters: {
                safeParse(input: unknown): { success: boolean };
                shape: { harness: { description?: string } };
            };
        }
    ).parameters;
    expect(schema.safeParse({ repository: REPO, task: 'x', harness: 'codex' }).success).toBe(true);
    expect(schema.safeParse({ repository: REPO, task: 'x', harness: 'x'.repeat(41) }).success).toBe(false);
    expect(schema.safeParse({ repository: REPO, task: 'x', harness: 7 }).success).toBe(false);
    expect(schema.shape.harness.description).toContain('Available here: opencode (OpenCode), codex (Codex)');
    expect(schema.shape.harness.description).toContain('claude-code (Claude Code, not on a personal plan)');
});
// ---------------------------------------------------------------------------
// The migration: expand only, existing sessions read opencode

it('adds the harness column without touching existing rows: they read opencode', () => {
    const db = new DatabaseSync(':memory:');
    cleanup.push(() => db.close());
    const before = gatewaySchema.migrations!.filter((migration) => migration.version <= 5);
    migrate(db, [{ ...gatewaySchema, migrations: before }]);
    db.prepare(
        `INSERT INTO coding_sessions(id, personId, socioId, threadId, conversationKind, repository, repositoryKey, base, branch, shortId, model, push, volumeKey, opencodeSession, state, createdAt, endsAt, lastPromptAt)
         VALUES ('old', 'bob', 's', 't', 'private', ?, ?, 'main', 'socio/x/abcdef01', 'abcdef01', 'orion', 1, ?, 'ses_old', 'ended', 1, 2, 1)`,
    ).run(REPO, REPO.toLowerCase(), 'c'.repeat(64));
    const harness = gatewaySchema.migrations!.find((migration) => migration.version === 6)!;
    expect(harness).toMatchObject({ phase: 'expand', name: 'coding sessions record their harness' });
    migrate(db, [gatewaySchema]);
    expect(db.prepare("SELECT harness, opencodeSession FROM coding_sessions WHERE id='old'").get()).toEqual({
        harness: 'opencode',
        opencodeSession: 'ses_old',
    });
    const column = (db.prepare('PRAGMA table_info(coding_sessions)').all() as Array<Record<string, unknown>>).find(
        (row) => row.name === 'harness',
    );
    expect(column).toMatchObject({ notnull: 0, dflt_value: "'opencode'" });
});
