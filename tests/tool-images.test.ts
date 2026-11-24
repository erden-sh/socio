import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { RunAgentInput } from '@ag-ui/core';
import type { AnyTextAdapter, ModelMessage, TextOptions } from '@tanstack/ai';
import { lastValueFrom, toArray } from 'rxjs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { contextBudget } from '@socio/foundation/context/budget';
import { withSpeakers } from '@socio/foundation/context/speakers';
import type { ToolImageSource } from '@socio/foundation/turns/tool-images';
import type { DotTurn } from '@socio/foundation/turns/turn';
import type { InferenceCapabilities } from '@socio/shared/inference';
import { toolImageOf, withoutInlineImages } from '@socio/shared/tool-images';

import type { PlatformConfig } from '../src/server/composition/config.js';
import { screenshotResult } from '../src/server/computers/computer-tools.js';
import { SCREENSHOT_URL_CHARS } from '../src/server/computers/contract.js';
import { alternating } from '../src/server/context/alternate.js';
import { resetCalibration, fixedTokens, messagesTokens } from '../src/server/context/budget.js';
import { compactNow, fitContext } from '../src/server/context/fit.js';
import { TOOL_IMAGES, inlineImageNote } from '../src/server/context/images.js';
import { SUMMARY_PROMPT, ContextNotes } from '../src/server/context/notes.js';
import { recallTool } from '../src/server/context/recall.js';
import { MediaError } from '../src/server/media/contract.js';
import { attachmentTools } from '../src/server/media/tools.js';
import { busyModel } from '../src/server/turns/model-busy.js';
import { traceEntry } from '../src/server/turns/turn-trace.js';

import { PNG } from './fixtures/media.js';
import { completion } from './fixtures/model-stream.js';
import { DotAgent } from './helpers/dot-agent.js';
import { LocalAgentRunner } from './helpers/runners.js';
import { testDatabase } from './helpers/test-database.js';
import { makeTestRuntime } from './helpers/test-runtime.js';

const cleanup: Array<() => unknown> = [];
beforeEach(() => resetCalibration());
afterEach(async () => {
    vi.restoreAllMocks();
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

/** A JPEG-sniffed image: the signature, then filler. */
const jpegOf = (fill: number, size = 2_000) =>
    Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(size - 4, fill)]);
const idOf = (n: number) => `cbatt_${String(n).padStart(22, 'x')}`;
const VISION: InferenceCapabilities = {
    acceptsImages: true,
    maxImages: 2,
    contextWindow: 64_000,
};
const TEXT_ONLY: InferenceCapabilities = {
    acceptsImages: false,
    contextWindow: 64_000,
};

/** A fake conversation's images: id to bytes, and what was loaded. */
function images(count: number) {
    const bytes = new Map(Array.from({ length: count }, (_, n) => [idOf(n + 1), jpegOf(n + 1)]));
    const loads: string[] = [];
    const source: ToolImageSource = {
        maxBytes: 10 * 1048576,
        size: async (id) => bytes.get(id)?.length,
        load: async (id) => {
            loads.push(id);
            const data = bytes.get(id);
            return data ? { data, mediaType: 'image/jpeg' } : undefined;
        },
    };
    return { bytes, loads, source };
}

/** A screenshot's result as history keeps it. */
const shot = (n: number) =>
    JSON.stringify({
        url: `https://game.example.test/move/${n}`,
        width: 1280,
        height: 800,
        image: {
            id: idOf(n),
            mediaType: 'image/jpeg',
            size: 2_000,
            width: 1280,
            height: 800,
        },
    });

/** A turn: the person's message, a screenshot per round, and an answer. */
function turn(index: number, shots: number[], answer = `Moved ${index}.`) {
    const messages: ModelMessage[] = [{ role: 'user', content: `Make move ${index}.` }];
    for (const n of shots) {
        messages.push(
            {
                role: 'assistant',
                content: null,
                toolCalls: [
                    {
                        id: `call_${n}`,
                        type: 'function',
                        function: { name: 'computer_screenshot', arguments: '{}' },
                    },
                ],
            },
            { role: 'tool', toolCallId: `call_${n}`, content: shot(n) },
        );
    }
    if (answer) {
        messages.push({ role: 'assistant', content: answer });
    }
    return messages;
}

/** A model that records each request and answers. */
function recording() {
    const requests: TextOptions[] = [];
    const adapter = {
        name: 'fake',
        chatStream: async function* (request: TextOptions) {
            requests.push(request);
            yield { type: 'RUN_STARTED', runId: 'r', threadId: 't' };
            yield { type: 'RUN_FINISHED', runId: 'r', threadId: 't' };
        },
    } as unknown as AnyTextAdapter;
    return { adapter, requests };
}

const SYSTEM = ['You are Ada, a specialist socio in Socio.'];

async function send(messages: ModelMessage[], capabilities: InferenceCapabilities, source?: ToolImageSource) {
    const db = testDatabase();
    cleanup.push(() => db.close());
    const model = recording();
    const fitted = fitContext(model.adapter, {
        capabilities,
        key: 'test:images',
        threadId: 't1',
        notes: new ContextNotes(db),
        emit: () => {},
        log: () => {},
        images: source,
    });
    for await (const chunk of fitted.chatStream({
        model: 'fake',
        messages,
        systemPrompts: [...SYSTEM],
        tools: [],
    } as unknown as TextOptions)) {
        void chunk;
    }
    // The round's own request: after any request for the notes.
    return model.requests.at(-1)!;
}

type Part = { type: string; content?: string; source?: { value: string } };
const partsOf = (message: ModelMessage) => (Array.isArray(message.content) ? message.content : []) as Part[];
const imagesIn = (messages: readonly ModelMessage[]) =>
    messages.flatMap((message) => partsOf(message).filter((part) => part.type === 'image'));
const base64 = (bytes: Buffer) => bytes.toString('base64');

it('shows a screenshot to a model that sees images, in a message from Socio right after its result', async () => {
    const { bytes, source } = images(1);
    const messages = [...turn(1, [1], '')];
    const sent = await send(messages, VISION, source);
    const roles = sent.messages.map((message) => message.role);
    expect(roles).toEqual(['user', 'assistant', 'tool', 'user']);
    // The result stays as it was stored: the reference, no bytes.
    expect(sent.messages[2].content).toBe(shot(1));
    const [label, image] = partsOf(sent.messages[3]);
    expect(label).toEqual({
        type: 'text',
        content: `[From Socio: the image computer_screenshot returned (${idOf(1)}, image/jpeg, 1280×800, 2 KB).]`,
    });
    expect(image).toEqual({
        type: 'image',
        source: {
            type: 'data',
            value: base64(bytes.get(idOf(1))!),
            mimeType: 'image/jpeg',
        },
    });
    // The system prompt is passed on byte for byte.
    expect(sent.systemPrompts).toEqual(SYSTEM);
});

it('gives a model without vision a note with the reference and what to use instead', async () => {
    const { loads, source } = images(1);
    const sent = await send(turn(1, [1], ''), TEXT_ONLY, source);
    expect(imagesIn(sent.messages)).toEqual([]);
    expect(sent.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'tool']);
    const result = sent.messages[2].content as string;
    // The reference and size stay in the result; the note says why and what to use.
    expect(result.startsWith(shot(1))).toBe(true);
    expect(result).toContain(idOf(1));
    expect(result).toContain('"size":2000');
    expect(result).toContain(
        "[Not shown: this model can't see images. computer_snapshot and computer_read give the page as text.]",
    );
    expect(loads).toEqual([]);
});

it('shows the newest images up to the model’s limit, the person’s attachments counted, the rest as notes', async () => {
    const { bytes, loads, source } = images(3);
    const photo = {
        type: 'image',
        source: {
            type: 'data',
            value: PNG.toString('base64'),
            mimeType: 'image/png',
        },
    };
    const messages: ModelMessage[] = [
        {
            role: 'user',
            content: [{ type: 'text', content: 'Here is the board.' }, photo],
        } as never,
        { role: 'assistant', content: 'Nice board.' },
        ...turn(1, [1, 2]),
        ...turn(2, [3], ''),
    ];
    const sent = await send(messages, VISION, source);
    // maxImages 2: screenshots 3 and 2; 1 and the person's photo are notes.
    expect(imagesIn(sent.messages).map((part) => part.source!.value)).toEqual([
        base64(bytes.get(idOf(2))!),
        base64(bytes.get(idOf(3))!),
    ]);
    expect(loads.sort()).toEqual([idOf(2), idOf(3)]);
    const result = (n: number) =>
        sent.messages.find((message) => message.role === 'tool' && message.toolCallId === `call_${n}`)!
            .content as string;
    expect(result(1)).toContain(
        `[Not shown: an older image; only the most recent ones are shown. attachments_view with id ${idOf(1)} shows it again.]`,
    );
    expect(result(2)).toBe(shot(2));
    expect(partsOf(sent.messages[0])).toEqual([
        { type: 'text', content: 'Here is the board.' },
        {
            type: 'text',
            content: '[The user attached an image earlier; only the most recent images are shown to the model.]',
        },
    ]);
    // The roles still take turns: no two user or assistant messages in a row.
    const roles = sent.messages.map((message) => message.role);
    roles.forEach((role, at) => {
        if (role !== 'tool') {
            expect(roles[at + 1]).not.toBe(role);
        }
    });
});

it('keeps images within the byte limit, and notes one that is gone', async () => {
    const { source } = images(1);
    const small = { ...source, maxBytes: 1_000 };
    const tooLarge = await send(turn(1, [1], ''), VISION, small);
    expect(imagesIn(tooLarge.messages)).toEqual([]);
    expect(tooLarge.messages[2].content).toContain('[Not shown: too large to show this model.]');
    const gone = await send(turn(5, [5], ''), VISION, source);
    expect(imagesIn(gone.messages)).toEqual([]);
    expect(gone.messages[2].content).toContain('[Not shown: the image is no longer available.]');
});

it('never shows an image named by a tool that does not return images', async () => {
    const { loads, source } = images(1);
    const messages = turn(1, [1], '');
    (messages[1] as { toolCalls: Array<{ function: { name: string } }> }).toolCalls[0].function.name = 'http_json';
    const sent = await send(messages, VISION, source);
    expect(imagesIn(sent.messages)).toEqual([]);
    expect(sent.messages[2].content).toBe(shot(1));
    expect(loads).toEqual([]);
});

it('turns an older version’s base64 screenshot into a short note, in the prompt only', async () => {
    const png = Buffer.concat([PNG, Buffer.alloc(60_000, 7)]).toString('base64');
    const stored = JSON.stringify({
        base64: png,
        width: 1280,
        height: 800,
        capturedAt: '2026-10-22T08:00:00.000Z',
        url: 'https://reversi.example.test/',
    });
    const messages: ModelMessage[] = [
        { role: 'user', content: 'Play.' },
        {
            role: 'assistant',
            content: null,
            toolCalls: [
                {
                    id: 'old',
                    type: 'function',
                    function: { name: 'computer_screenshot', arguments: '{}' },
                },
            ],
        },
        { role: 'tool', toolCallId: 'old', content: stored },
        { role: 'assistant', content: 'I see the board.' },
        { role: 'user', content: 'Your move.' },
    ];
    const before = JSON.stringify(messages);
    const sent = await send(messages, VISION, images(0).source);
    // Stored history is not changed.
    expect(JSON.stringify(messages)).toBe(before);
    const result = sent.messages[2].content as string;
    expect(result).not.toContain('iVBORw0KGgo');
    expect(result.length).toBeLessThan(400);
    expect(JSON.parse(result)).toEqual({
        base64: inlineImageNote('image/png', PNG.length + 60_000),
        width: 1280,
        height: 800,
        capturedAt: '2026-10-22T08:00:00.000Z',
        url: 'https://reversi.example.test/',
    });
    expect(result).toContain('take a new screenshot to look again');
    // A short token is never taken for an image.
    expect(withoutInlineImages('/9j/abc', () => 'x')).toBe('/9j/abc');
});

it('lets recall read an older base64 screenshot as the note, not the bytes', async () => {
    const png = Buffer.concat([PNG, Buffer.alloc(30_000, 3)]).toString('base64');
    const recall = recallTool({ threadId: 't', check: () => {} }, async () => [
        {
            id: 'a',
            role: 'assistant',
            content: '',
            toolCalls: [
                {
                    id: 'old',
                    type: 'function',
                    function: { name: 'computer_screenshot', arguments: '{}' },
                },
            ],
        },
        {
            id: 'r',
            role: 'tool',
            toolCallId: 'old',
            content: JSON.stringify({ base64: png }),
        },
    ]);
    const read = (await recall.execute!({ ref: 'old' })) as { text: string };
    expect(read.text).not.toContain('iVBORw0KGgo');
    expect(read.text).toContain('stored as text by an older version');
});

it('keeps the prompt’s start the same from turn to turn: an image turns into a note once, and stays it', async () => {
    const { source } = images(4);
    const first = [...turn(1, [1]), ...turn(2, [2]), { role: 'user', content: 'Next?' } as ModelMessage];
    const second = [
        ...turn(1, [1]),
        ...turn(2, [2]),
        ...turn(3, [3]),
        { role: 'user', content: 'Next?' } as ModelMessage,
    ];
    const third = [
        ...turn(1, [1]),
        ...turn(2, [2]),
        ...turn(3, [3]),
        ...turn(4, [4]),
        { role: 'user', content: 'Next?' } as ModelMessage,
    ];
    const a = await send(first, VISION, source);
    const again = await send(first, VISION, source);
    // The same conversation, the same prompt, byte for byte.
    expect(JSON.stringify(again.messages)).toBe(JSON.stringify(a.messages));
    const b = await send(second, VISION, source);
    const c = await send(third, VISION, source);
    const upTo = (messages: readonly ModelMessage[], call: string) =>
        JSON.stringify(
            messages.slice(
                0,
                messages.findIndex((message) => message.toolCallId === call),
            ),
        );
    // Turn 3's screenshot pushed out 1: the prompt before it is unchanged.
    expect(upTo(b.messages, 'call_1')).toBe(upTo(a.messages, 'call_1'));
    // Turn 4's pushed out 2; 1's note is the same as it was: all before 2 is.
    expect(upTo(c.messages, 'call_2')).toBe(upTo(b.messages, 'call_2'));
    expect(imagesIn(c.messages)).toHaveLength(2);
    expect(c.systemPrompts).toEqual(SYSTEM);
});

it('applies the shared model’s image limits after a switch to it (CB-140)', async () => {
    const { source } = images(1);
    const db = testDatabase();
    cleanup.push(() => db.close());
    const busy = {
        chatStream: async function* () {
            yield { type: 'RUN_STARTED', runId: 'r', threadId: 't' };
            yield { type: 'RUN_ERROR', code: '429', message: 'busy' };
        },
    } as unknown as AnyTextAdapter;
    for (const capabilities of [VISION, TEXT_ONLY]) {
        const shared = recording();
        const adapter = busyModel(busy, {
            label: 'ChatGPT',
            fallback: async () => ({
                adapter: fitContext(shared.adapter, {
                    capabilities,
                    key: `test:shared:${capabilities.acceptsImages}`,
                    threadId: 't1',
                    notes: new ContextNotes(db),
                    emit: () => {},
                    log: () => {},
                    images: source,
                }),
                label: 'Homelab',
                model: 'orion',
                modelOptions: {},
                maxImages: capabilities.acceptsImages ? 2 : 0,
            }),
        });
        for await (const chunk of adapter.chatStream({
            messages: turn(1, [1], ''),
            systemPrompts: [...SYSTEM],
            tools: [],
        } as never)) {
            void chunk;
        }
        expect(imagesIn(shared.requests[0].messages)).toHaveLength(capabilities.acceptsImages ? 1 : 0);
    }
});

/** A socio's turn on a computer, with the model and the computer faked. */
async function computerTurn(acceptsImages: boolean) {
    const dir = mkdtempSync(join(tmpdir(), 'cb-tool-images-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const runner = new LocalAgentRunner(testDatabase());
    cleanup.push(() => runner.close());
    const config: PlatformConfig = {
        apiKey: 'fixture',
        model: 'custom-model',
        baseUrl: 'https://model.invalid/v1',
        runtimeUrl: '',
        voiceName: 'marin',
        acceptsImages,
        data: { userDataDir: dir },
        computerSupervisorUrl: 'http://supervisor.invalid:4312',
        computerSupervisorToken: 'supervisor-secret',
        computerToken: 'master-secret',
    };
    // Before the platform: its computer service keeps the fetch it is made
    // with. The Dot's id is read once the platform is built, before any turn.
    let dotId = '';
    const screenshot = jpegOf(9, 4_000);
    const models: string[] = [];
    const computerCalls: string[] = [];
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const url = String(input);
        if (url.startsWith('https://model.invalid/')) {
            models.push(String(init?.body ?? ''));
            return models.length === 1
                ? completion(
                      {
                          role: 'assistant',
                          tool_calls: [
                              {
                                  index: 0,
                                  id: 'shot',
                                  type: 'function',
                                  function: { name: 'computer_screenshot', arguments: '{}' },
                              },
                          ],
                      },
                      'tool_calls',
                  )
                : completion({ role: 'assistant', content: 'Black to move.' });
        }
        computerCalls.push(url);
        if (url.endsWith('/computers')) {
            return Response.json({
                computers: [
                    {
                        botId: dotId,
                        container: `company-brain-computer-${dotId}`,
                        status: 'running',
                        url: `http://company-brain-computer-${dotId}:4100`,
                    },
                ],
            });
        }
        if (url.endsWith('/ensure')) {
            return Response.json({
                botId: dotId,
                container: `company-brain-computer-${dotId}`,
                status: 'running',
                url: `http://company-brain-computer-${dotId}:4100`,
            });
        }
        if (new URL(url).pathname === '/screenshot') {
            return Response.json({
                base64: screenshot.toString('base64'),
                width: 1280,
                height: 800,
                capturedAt: '2026-10-22T08:00:00.000Z',
                url: 'https://reversi.example.test/',
            });
        }
        return Response.json({ ok: true });
    });
    const { store, workspace, platform, dispose } = await makeTestRuntime({ config });
    cleanup.push(dispose);
    const dot = workspace.dots()[0];
    dotId = dot.id;
    await workspace.computers.patch(dot.id, {
        enabled: true,
        browser: true,
        files: true,
        shell: true,
    });
    const thread = workspace.bindThread('thread', dot.id, 'Reversi', 'alice');
    const agent = new DotAgent(store, workspace, config, dot.id, false, undefined, {
        extensions: platform.dotExtensions,
    });
    const input: RunAgentInput = {
        threadId: thread.id,
        runId: 'run-1',
        state: {},
        context: [],
        messages: [{ id: 'u1', role: 'user', content: 'Look at the board.' }],
        tools: [],
        forwardedProps: {},
    };
    agent.threadId = thread.id;
    agent.setMessages(input.messages);
    const events = await lastValueFrom(runner.run({ threadId: thread.id, agent, input }).pipe(toArray()));
    return {
        platform,
        thread,
        dot,
        runner,
        events,
        models,
        computerCalls,
        screenshot,
    };
}

it('stores a screenshot as an attachment of the chat and keeps only its reference in history', async () => {
    const turn = await computerTurn(true);
    expect(turn.events.map((event) => event.type)).not.toContain('RUN_ERROR');
    // The computer was asked for a JPEG.
    const asked = turn.computerCalls.find((url) => new URL(url).pathname === '/screenshot')!;
    expect(new URL(asked).search).toBe('?type=jpeg&quality=80');
    const stored = await turn.runner.messages(turn.thread.id);
    const result = stored.find((message) => message.role === 'tool')!;
    const content = result.content as string;
    expect(content).not.toContain(turn.screenshot.toString('base64'));
    const image = toolImageOf(content)!;
    expect(image).toMatchObject({
        mediaType: 'image/jpeg',
        size: 4_000,
        width: 1280,
        height: 800,
    });
    expect(JSON.parse(content)).toMatchObject({
        url: 'https://reversi.example.test/',
        capturedAt: '2026-10-22T08:00:00.000Z',
    });
    // An attachment of the conversation, bound to it, the owner's file.
    const row = (await turn.platform.media.attachment(image.id))!;
    expect(row).toMatchObject({
        ownerUserId: 'alice',
        threadId: turn.thread.id,
        dotId: turn.dot.id,
        source: 'tool',
        kind: 'image',
    });
    expect(row.boundAt).not.toBeNull();
    expect(turn.platform.media.file(row)!.path).toMatch(/^attachments\/\d{4}-\d{2}-\d{2}\/screenshot-\d{6}\.jpg$/);
    expect((await turn.platform.media.content(row)).data).toEqual(turn.screenshot);
    // The next round's request had it as an image, after the result.
    const next = JSON.parse(turn.models[1]) as {
        messages: Array<{ role: string; content: unknown }>;
    };
    const roles = next.messages.map((message) => message.role);
    expect(roles.slice(-3)).toEqual(['assistant', 'tool', 'user']);
    expect(JSON.stringify(next.messages.at(-1))).toContain(
        `data:image/jpeg;base64,${turn.screenshot.toString('base64')}`,
    );
    // The trace names the image, for the run view.
    expect(turn.runner.runTrace('run-1')!.trace!.tools).toEqual([
        expect.objectContaining({ name: 'computer_screenshot', image: image.id }),
    ]);
});

it('gives a model without vision the note in the turn, and stores the reference all the same', async () => {
    const turn = await computerTurn(false);
    const next = turn.models[1];
    expect(next).not.toContain(turn.screenshot.toString('base64'));
    expect(next).not.toContain('image_url');
    expect(next).toContain("this model can't see images");
    const stored = await turn.runner.messages(turn.thread.id);
    expect(toolImageOf(stored.find((message) => message.role === 'tool')!.content)).toBeDefined();
});

it('never keeps a screenshot’s bytes in its result, even when it can’t be stored', async () => {
    const shot = {
        base64: jpegOf(1).toString('base64'),
        width: 1280,
        height: 800,
        url: 'https://reversi.example.test/',
        capturedAt: '2026-10-22T08:00:00.000Z',
    };
    const page = {
        url: 'https://reversi.example.test/',
        width: 1280,
        height: 800,
        capturedAt: '2026-10-22T08:00:00.000Z',
    };
    const full = {
        save: async () => {
            throw new MediaError('Your files are full.', 413);
        },
    };
    expect(await screenshotResult(shot, full)).toEqual({
        ...page,
        error: 'The screenshot could not be saved, so it can’t be shown. Your files are full.',
    });
    expect(await screenshotResult(shot, undefined)).toEqual({
        ...page,
        error: 'Screenshots can’t be kept in this conversation, so none is shown.',
    });
    expect(await screenshotResult({ base64: 'not an image' }, full)).toEqual({
        error: 'The computer sent no image.',
    });
    // An older computer image's PNG is kept as a PNG.
    const saved: string[] = [];
    const result = await screenshotResult(
        { ...shot, base64: PNG.toString('base64') },
        {
            save: async ({ name }) => {
                saved.push(name);
                return { id: idOf(1), mediaType: 'image/png', size: PNG.length };
            },
        },
        new Date('2026-10-22T08:30:15Z'),
    );
    expect(saved).toEqual(['screenshot-083015.png']);
    expect(result).toEqual({
        ...page,
        image: { id: idOf(1), mediaType: 'image/png', size: PNG.length },
    });
});

/** A conversation with one call of `tool` and its result. */
const called = (tool: string, result: string, id = 'c1'): ModelMessage[] => [
    { role: 'user', content: 'Go.' },
    {
        role: 'assistant',
        content: null,
        toolCalls: [{ id, type: 'function', function: { name: tool, arguments: '{}' } }],
    },
    { role: 'tool', toolCallId: id, content: result },
];

it('leaves base64 another tool printed as it is, in the prompt and in recall', async () => {
    const png = Buffer.concat([PNG, Buffer.alloc(30_000, 5)]).toString('base64');
    const stdout = JSON.stringify({ exitCode: 0, stdout: png, stderr: '' });
    const sent = await send(called('computer_exec', stdout), VISION, images(0).source);
    // Cut to fit like any long result, never turned into an image note.
    expect(JSON.stringify(sent.messages)).not.toContain('stored as text by an older version');
    const recall = recallTool({ threadId: 't', check: () => {} }, async () =>
        called('computer_exec', stdout).map((message, at) => ({ id: `m${at}`, ...message }) as never),
    );
    const read = (await recall.execute!({ ref: 'c1' })) as { text: string };
    expect(read.text).toBe(stdout.slice(0, read.text.length));
    expect(read.text).toContain('iVBORw0KGgo');
});

it('finds base64 images only where base64 starts, in linear time', () => {
    const note = () => '[image]';
    // Inside a longer blob, a signature is not an image's start.
    const blob = `xyz${'iVBORw0KGgo'}${'A'.repeat(2_000)}`;
    expect(withoutInlineImages(blob, note)).toBe(blob);
    expect(withoutInlineImages(`"${'iVBORw0KGgo'}${'A'.repeat(2_000)}"`, note)).toBe('"[image]"');
    // Warm up the expression, then crafted 4 MB inputs, each under 100 ms.
    withoutInlineImages(`"/9j/${'A'.repeat(2_000)}"`, note);
    const size = 4 * 1048576;
    for (const unit of [
        `${'iVBORw0KGgo'.repeat(90)}"`,
        `iVBORw0KGgo${'A'.repeat(980)}"`,
        `"data:image/png;base64,iVBORw0KGgo${'A'.repeat(900)}`,
        '/9j/',
    ]) {
        const text = unit.repeat(Math.ceil(size / unit.length));
        // The best of three, so a busy machine's pause isn't counted; the
        // quadratic search this replaced took seconds. 200 ms is still
        // linear (a quadratic search on 4 MB takes seconds); the threshold
        // is generous for CI runners with CPU contention from parallel
        // test workers.
        const times = [0, 1, 2].map(() => {
            const started = performance.now();
            withoutInlineImages(text, note);
            return performance.now() - started;
        });
        expect(Math.min(...times)).toBeLessThan(200);
    }
});

it('measures an image by what is stored, never by the size its result names', async () => {
    const { source } = images(1);
    const messages = called(
        'computer_screenshot',
        JSON.stringify({
            image: { id: idOf(1), mediaType: 'image/jpeg', size: 10 },
        }),
    );
    // The stored image is 2,000 bytes; the result says 10.
    const sent = await send(messages, VISION, { ...source, maxBytes: 1_000 });
    expect(imagesIn(sent.messages)).toEqual([]);
    expect(sent.messages[2].content).toContain('[Not shown: too large to show this model.]');
});

it('keeps room for the images it will show when it fits the prompt', async () => {
    const capabilities = { ...VISION, maxImages: 4, contextWindow: 8_000 };
    const { source } = images(4);
    const messages: ModelMessage[] = [];
    for (let index = 1; index <= 4; index++) {
        messages.push(
            {
                role: 'user',
                content: `Turn ${index}: ${'plan the opening. '.repeat(130)}`,
            },
            { role: 'assistant', content: `Noted ${index}.` },
        );
    }
    messages.push(...turn(5, [1, 2, 3, 4], ''));
    const sent = await send(messages, capabilities, source);
    expect(imagesIn(sent.messages)).toHaveLength(4);
    expect(messagesTokens(sent.messages) + fixedTokens(sent.systemPrompts ?? [], [])).toBeLessThanOrEqual(
        contextBudget(capabilities).target,
    );
});

it('writes the notes from an older base64 screenshot’s note, not its bytes (/compact)', async () => {
    const db = testDatabase();
    cleanup.push(() => db.close());
    const png = Buffer.concat([PNG, Buffer.alloc(30_000, 3)]).toString('base64');
    const summaries: string[] = [];
    const adapter = {
        name: 'fake',
        chatStream: async function* (request: TextOptions) {
            if (request.systemPrompts?.[0] === SUMMARY_PROMPT) {
                summaries.push(JSON.stringify(request.messages));
            }
            yield { type: 'RUN_STARTED', runId: 'r', threadId: 't' };
            yield {
                type: 'TEXT_MESSAGE_CONTENT',
                messageId: 'm',
                delta: 'PINNED:\n- Playing Reversi\nSUMMARY:\nA game.',
            };
            yield { type: 'RUN_FINISHED', runId: 'r', threadId: 't' };
        },
    } as unknown as AnyTextAdapter;
    const messages: ModelMessage[] = [
        ...called('computer_screenshot', JSON.stringify({ base64: png }), 'old'),
        { role: 'assistant', content: 'I see the board.' },
    ];
    for (let index = 2; index <= 5; index++) {
        messages.push({ role: 'user', content: `Move ${index}.` }, { role: 'assistant', content: `Moved ${index}.` });
    }
    const done = await compactNow(
        adapter,
        {
            capabilities: VISION,
            key: 'test:compact-images',
            threadId: 't-compact',
            notes: new ContextNotes(db),
            emit: () => {},
            log: () => {},
        },
        { model: 'fake', messages, systemPrompts: [...SYSTEM], tools: [] } as never,
    );
    expect(done.folded).toBeGreaterThan(0);
    expect(summaries.join('')).toContain('stored as text by an older version');
});

it('keeps a traced image only when it is an attachment id', () => {
    const tool = {
        kind: 'tool',
        round: 1,
        name: 'computer_screenshot',
        startedAt: 1,
        endedAt: 2,
        outcome: 'ok',
    };
    expect(traceEntry({ ...tool, image: idOf(1) })).toMatchObject({
        image: idOf(1),
    });
    for (const image of ['../../etc/passwd', 'cbatt_short', 42, null]) {
        expect(traceEntry({ ...tool, image })).not.toHaveProperty('image');
    }
});

it('never labels Socio’s images as anyone’s when they merge into a person’s message', () => {
    const alice = { id: 'alice', name: 'Alice' };
    const messages = withSpeakers(
        [...called('computer_screenshot', shot(1)), { role: 'user', content: 'Your move.' }],
        [alice, alice],
    );
    // The round's images, as fitting adds them, right before the next message.
    messages.splice(3, 0, {
        role: 'user',
        content: [
            { type: 'text', content: '[From Socio: the image]' },
            {
                type: 'image',
                source: { type: 'data', value: 'AAAA', mimeType: 'image/jpeg' },
            },
        ],
        metadata: TOOL_IMAGES,
    });
    const merged = alternating(messages).at(-1)!;
    expect(merged.role).toBe('user');
    const texts = partsOf(merged).flatMap((part) => (part.type === 'text' ? [part.content] : []));
    // In a chat with speakers (CB-210), the person's own words keep their
    // label; Socio's images get none.
    expect(texts).toEqual(['[From Socio: the image]', '⟦Alice wrote:⟧', 'Your move.']);
    // A one-person chat has no speakers: no label at all.
    const alone = alternating(
        messages.map((message) => ({
            ...message,
            metadata: Object.fromEntries(
                Object.entries(message.metadata ?? {}).filter(([key]) => key !== 'socioSpeaker'),
            ),
        })),
    ).at(-1)!;
    expect(JSON.stringify(alone)).not.toContain('wrote:');
});

it('keeps a long page address short enough for the result to name its image', async () => {
    const url = `https://game.example.test/?state=${'x'.repeat(5_000)}`;
    const result = await screenshotResult(
        { base64: jpegOf(1).toString('base64'), url, width: 1280, height: 800 },
        {
            save: async () => ({ id: idOf(1), mediaType: 'image/jpeg', size: 2_000 }),
        },
    );
    expect((result as { url: string }).url).toHaveLength(SCREENSHOT_URL_CHARS);
    expect(toolImageOf(JSON.stringify(result))).toMatchObject({ id: idOf(1) });
});

/** A person's chats and images, for attachments_view. */
async function viewFixture() {
    const dir = mkdtempSync(join(tmpdir(), 'cb-tool-images-view-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const { workspace, platform, dispose } = await makeTestRuntime({
        config: { data: { userDataDir: dir } },
    });
    cleanup.push(dispose);
    const dot = workspace.dots()[0];
    const chat = async (owner: string) => {
        const thread = await platform.createConversation(dot.id, 'Game', owner);
        const image = await platform.media.saveToolImage(
            { userId: owner, dotId: dot.id, threadId: thread.id },
            { name: 'screenshot-083015.png', bytes: PNG },
        );
        return { thread, image };
    };
    const view = async (threadId: string, userId: string, id: string) => {
        const tool = attachmentTools(platform.media, {
            dot,
            userId,
            threadId,
            check: () => {},
        } as unknown as DotTurn).find((each) => each.name === 'attachments_view')!;
        return tool.execute!({ id } as never);
    };
    return { platform, dot, chat, view };
}

it('shows a socio only its own chat’s images with attachments_view', async () => {
    const f = await viewFixture();
    const here = await f.chat('alice');
    const otherChat = await f.chat('alice');
    const othersChat = await f.chat('bob');
    expect(await f.view(here.thread.id, 'alice', here.image.id)).toEqual({
        name: 'screenshot-083015.png',
        image: here.image,
    });
    const refused = {
        error: 'No image with that id in this conversation (it may have been deleted).',
    };
    // The person's own image in another chat, and someone else's.
    expect(await f.view(here.thread.id, 'alice', otherChat.image.id)).toEqual(refused);
    expect(await f.view(here.thread.id, 'alice', othersChat.image.id)).toEqual(refused);
    // Deleted from the person's files: gone from the chat too.
    const row = (await f.platform.media.attachment(here.image.id))!;
    await f.platform.data.deleteFile('alice', f.platform.media.file(row)!.path);
    expect(await f.view(here.thread.id, 'alice', here.image.id)).toEqual(refused);
});

it('stores nothing when what a tool returned is not an image', async () => {
    const f = await viewFixture();
    const thread = await f.platform.createConversation(f.dot.id, 'Game', 'alice');
    await expect(
        f.platform.media.saveToolImage(
            { userId: 'alice', dotId: f.dot.id, threadId: thread.id },
            { name: 'screenshot.png', bytes: Buffer.from('not an image at all') },
        ),
    ).rejects.toMatchObject({ status: 415 });
    expect(f.platform.data.fileRecords('alice')).toEqual([]);
    expect(await f.platform.media.forThread(thread.id)).toEqual([]);
});
