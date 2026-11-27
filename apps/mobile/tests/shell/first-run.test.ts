import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createLiveQueryCollection } from '@tanstack/db';
import { afterEach, describe, expect, it } from 'vitest';

import { NO_INFERENCE_MESSAGES } from '@socio/shared/inference';
import type { Dot } from '@socio/shared/types';

import { modelPickerView } from '../../src/chat/model-picker';
import {
    defaultSocioId,
    fillStarter,
    firstRun,
    NEW_CHAT,
    newChatView,
    newChatWithLabel,
    noInferenceMessage,
    PRIVACY_LINE,
    STARTER_HINT,
    STARTERS,
} from '../../src/shell/first-run';
import { NO_INSTRUCTIONS } from '../../src/shell/home';
import { chatsQuery, shellQuery, shellRows, sociosQuery } from '../../src/shell/queries';
import { DraftError, newChatDraft } from '../../src/sync/chat-drafts';
import { cleanupScopeCollections, createScopeCollections, type ScopeCollections } from '../../src/sync/collections';
import type { ShellWorkspace } from '../../src/sync/shell';
import { conversation, syncSetup, type WorkspaceData } from '../sync/helpers';

// The first run on a scope's collections, seeded through the
// snapshot sources from a fake server, as Home reads them (useFirstRun): the
// same live queries, then the view model.

type Setup = Awaited<ReturnType<typeof syncSetup>>;
const open: Setup[] = [];
const made: ScopeCollections[] = [];
afterEach(async () => {
    for (const c of made.splice(0)) {
        await cleanupScopeCollections(c).catch(() => {});
    }
    for (const s of open.splice(0)) {
        await s.close().catch(() => {});
    }
});

const dot = (id: string, name: string, extra: Partial<Dot> = {}) => ({
    id,
    name,
    spaceId: 'everyday',
    spaceIds: ['everyday'],
    instructions: '',
    researchAllowed: true,
    memoryAllowed: true,
    createdAt: 1,
    ...extra,
});

const FRESH_DOTS = [
    dot('sebas', 'Sebas', { createdAt: 1, character: 'sebas', instructions: 'Keeps the team on track.' }),
    dot('mine', 'Pip', { createdAt: 2, ownerId: 'u-ada' }),
    dot('old', 'Old', { createdAt: 0, archivedAt: 9 }),
];

/** A workspace pulled into a scope's collections: a fresh account (no chats) unless told otherwise. */
async function seeded(change: (data: WorkspaceData) => void = () => {}, { pull = true } = {}) {
    const s = await syncSetup();
    open.push(s);
    s.server.change('workspace', (data) => {
        data.conversations = [];
        data.archived = [];
        data.dots = FRESH_DOTS;
        change(data);
    });
    s.server.change('state', (data) => {
        data.settings = { name: 'Acme', paused: false, rooms: { enabled: true } };
    });
    if (pull) {
        await s.state.pull('', null);
        await s.workspace.pull('', null);
    }
    const c = createScopeCollections(`ws.${open.length}`, s.cache, []);
    made.push(c);
    const rowsOf = async <T>(live: { toArrayWhenReady(): Promise<T[]>; cleanup(): Promise<void> }) => {
        const rows = await live.toArrayWhenReady();
        await live.cleanup();
        return rows;
    };
    const { state, workspace } = shellRows(
        await rowsOf(createLiveQueryCollection({ query: shellQuery(c), startSync: true })),
    );
    return {
        state,
        workspace,
        chats: await rowsOf(createLiveQueryCollection({ query: chatsQuery(c), startSync: true })),
        dots: await rowsOf(createLiveQueryCollection({ query: sociosQuery(c), startSync: true })),
    };
}

const withInference = (
    workspace: ShellWorkspace | null,
    inference: NonNullable<ShellWorkspace['setup']['inference']>,
): ShellWorkspace => ({ ...workspace!, setup: { ...workspace!.setup, inference } });

describe('the first run', () => {
    it('opens New chat on a fresh account: the oldest socio not archived chosen, the picker and the privacy line', async () => {
        const view = firstRun(await seeded());
        expect(view).not.toBeNull();
        expect(view!.socios.map((socio) => socio.id)).toEqual(['sebas', 'mine']);
        expect(view!.chosen).toMatchObject({
            id: 'sebas',
            name: 'Sebas',
            character: 'sebas',
            blurb: 'Keeps the team on track.',
            personal: false,
        });
        expect(view!.socios[1]).toMatchObject({ name: 'Pip', personal: true, blurb: NO_INSTRUCTIONS });
        expect(view!.composerLabel).toBe('Message Sebas');
        expect(view!.privacy).toBe(PRIVACY_LINE);
        expect(view!.privacy).toBe(
            'A personal socio and its chats belong to you. A workspace socio is shared, and so are pages in Spaces.',
        );
        // The fake server's setup says nothing about the model: no notice.
        expect(view!.noInference).toBeNull();
    });

    it('takes the socio picked while it is there, and the default again once it is gone', async () => {
        const rows = await seeded();
        expect(firstRun({ ...rows, picked: 'mine' })?.chosen.id).toBe('mine');
        expect(firstRun({ ...rows, picked: 'mine' })?.composerLabel).toBe('Message Pip');
        // Archived or no longer listed: back to the default.
        expect(firstRun({ ...rows, picked: 'old' })?.chosen.id).toBe('sebas');
        expect(firstRun({ ...rows, picked: 'gone' })?.chosen.id).toBe('sebas');
    });

    it('shows Home once there is a chat, or a room while rooms are on', async () => {
        expect(firstRun(await seeded((data) => (data.conversations = [conversation('c1', 'Kickoff')])))).toBeNull();
        const invited = await seeded((data) => {
            data.conversations = [{ ...conversation('r1', 'Team room'), ownerId: 'room:r1', kind: 'room' }];
        });
        expect(firstRun(invited)).toBeNull();
        // With rooms off, a room isn't in the chat list: still the first run.
        expect(
            firstRun({
                ...invited,
                state: { ...invited.state!, settings: { ...invited.state!.settings, rooms: { enabled: false } } },
            }),
        ).not.toBeNull();
    });

    it('counts archived chats as none', async () => {
        const view = firstRun(
            await seeded((data) => (data.archived = [{ ...conversation('c0', 'Old'), archivedAt: 5 }])),
        );
        expect(view?.chosen.id).toBe('sebas');
    });

    it('waits for both shell rows before deciding, and stays Home with no socio', async () => {
        const unpulled = await seeded(undefined, { pull: false });
        expect(unpulled.state).toBeNull();
        expect(firstRun(unpulled)).toBeNull();
        const rows = await seeded();
        expect(firstRun({ ...rows, workspace: null })).toBeNull();
        expect(firstRun({ ...rows, state: null })).toBeNull();
        expect(firstRun(await seeded((data) => (data.dots = [dot('old', 'Old', { archivedAt: 9 })])))).toBeNull();
    });
});

describe('no model on the first run', () => {
    it('shows the web’s line: connect your own where the operator allows it, else ask an operator', async () => {
        const rows = await seeded();
        const connect = firstRun({
            ...rows,
            workspace: withInference(rows.workspace, { available: false, byoAllowed: true }),
        });
        expect(connect?.noInference).toBe(NO_INFERENCE_MESSAGES.connect);
        expect(connect?.canConnect).toBe(true);
        const operator = firstRun({
            ...rows,
            workspace: withInference(rows.workspace, { available: false, byoAllowed: false }),
        });
        expect(operator?.noInference).toBe(NO_INFERENCE_MESSAGES.operator);
        expect(operator?.canConnect).toBe(false);
        const available = firstRun({
            ...rows,
            workspace: withInference(rows.workspace, { available: true, byoAllowed: true, source: 'shared' }),
        });
        expect(available?.noInference).toBeNull();
    });

    it('follows the chosen socio: one set to its own model says nothing until its options are known', async () => {
        const rows = await seeded((data) => {
            data.dots = [
                ...FRESH_DOTS,
                dot('own', 'Own', { createdAt: 3, inference: { source: 'shared', backendId: 'b1' } }),
            ];
        });
        const workspace = withInference(rows.workspace, { available: false, byoAllowed: false });
        expect(firstRun({ ...rows, workspace })?.noInference).toBe(NO_INFERENCE_MESSAGES.operator);
        expect(firstRun({ ...rows, workspace, picked: 'own' })?.noInference).toBeNull();
    });

    it('reads nothing into a setup that doesn’t say (an older server, or no workspace row)', () => {
        const plain: Pick<Dot, 'inference'> = {};
        expect(noInferenceMessage(plain, null)).toBeNull();
        expect(
            noInferenceMessage(plain, {
                setup: { model: true, voice: false, telegram: 'not_configured', missing: [] },
            }),
        ).toBeNull();
        expect(noInferenceMessage(plain, { setup: { inference: true } as never })).toBeNull();
    });

    it('never reads State.configured, which is the research runs’ set-up', async () => {
        const rows = await seeded();
        const state = { ...rows.state!, configured: false };
        expect(firstRun({ ...rows, state })?.noInference).toBeNull();
    });
});

describe('the first run on Home', () => {
    // No React Native renderer under Node, so this reads home.tsx: with no
    // chats yet, the first run keeps Home's header buttons and its tiles, so
    // the Spaces, the Board and the rest stay a tap away.
    const home = readFileSync(join(import.meta.dirname, '../../src/screens/home.tsx'), 'utf8');
    const between = (from: string, to: string) => home.slice(home.indexOf(from), home.indexOf(to, home.indexOf(from)));

    it("keeps the workspace button, the account button and the tiles, as Home's lists do", () => {
        const first = between('<FirstRun', '</FirstRun>');
        expect(first).toContain('leading={<WorkspaceButton withName={false} />}');
        expect(first).toContain('action={<AccountButton />}');
        expect(first).toContain('<Tiles />');
        const lists = between('function HomeLists(', '</Screen>');
        expect(lists).toContain('<Tiles />');
        // Home's lists have the native bar's (CB-431); the first run hides it and keeps its own top.
        expect(lists).not.toContain('HomeHeader');
        expect(home).toContain('useHomeBar(firstRun.view !== null);');
        expect(between('function useHomeBar(', '\n}\n')).toContain('hidden: firstRun,');
    });
});

describe('New chat at any time (Home, a socio row, the Chats tab)', () => {
    const STATE = { settings: { paused: false }, tasks: [] } as never;
    const WORKSPACE = { setup: {} } as never;
    const DOTS = FRESH_DOTS as unknown as Dot[];

    it('opens on the socio asked for, with chats there already, and the picker to change it', () => {
        const view = newChatView({ dots: DOTS, state: STATE, workspace: WORKSPACE, picked: 'mine' });
        expect(view?.chosen.id).toBe('mine');
        expect(view?.socios.map((socio) => socio.id)).toEqual(['sebas', 'mine']);
        expect(view?.composerPlaceholder).toBe('Message Pip…');
        // The first run stays Home's only while there are no chats; New chat isn't bound by that.
        const chats = [conversation('c1', 'Plans')] as never;
        expect(firstRun({ chats, dots: DOTS, state: STATE, workspace: WORKSPACE })).toBeNull();
    });

    it('opens on the default socio (the oldest not archived) for Home and Chats, and on it for a socio gone', () => {
        expect(defaultSocioId(DOTS, STATE)).toBe('sebas');
        expect(defaultSocioId([], STATE)).toBeNull();
        expect(newChatView({ dots: DOTS, state: STATE, workspace: WORKSPACE, picked: 'old' })?.chosen.id).toBe('sebas');
        expect(newChatView({ dots: DOTS, state: null, workspace: WORKSPACE })).toBeNull();
    });

    it("is a route at the web's path, which the new chat replaces", () => {
        const read = (file: string) => readFileSync(join(import.meta.dirname, '../../src', file), 'utf8');
        expect(read('navigation/routes.ts')).toMatch(
            /NewChat: \{\s*gates: \['shell'\],\s*linking: 'dots\/:socioId\/new'/,
        );
        expect(read('navigation/tab-screens.tsx')).toContain('NewChat: NewChatScreen');
        expect(read('screens/new-chat.tsx')).toMatch(/<FirstRun[\s\S]*replace/);
        expect(read('screens/first-run.tsx')).toContain("StackActions.replace('Chat'");
    });

    it("is on each socio row and in the Chats tab's bar, and Home has neither the pill nor Compose", () => {
        const read = (file: string) => readFileSync(join(import.meta.dirname, '../../src', file), 'utf8');
        const home = read('screens/home.tsx');
        // The owner, 2026-11-19 (CB-431): each socio row starts a chat, so Home has no pill and no Compose.
        expect(home).not.toContain('NewChatButton');
        expect(home).not.toContain('home-new-chat');
        expect(home).not.toContain('square.and.pencil');
        expect(home).toContain('onNewChat={(socioId) => navigation.dispatch(newChatAction(socioId))}');
        const parts = read('screens/home-parts.tsx');
        expect(parts).not.toContain('export function NewChatButton');
        expect(parts).toContain('label={newChatWithLabel(socio.name)}');
        expect(parts).toContain('testID={`socio-${socio.id}-new-chat`}');
        expect(newChatWithLabel('Sebas')).toBe('New chat with Sebas');
        const chats = read('screens/chats.tsx');
        // The Chats tab's bar (CB-420): Compose as a native item, an SF Symbol on iOS, starting
        // New chat with the default socio (a menu with New room while rooms are on, CB-470).
        expect(chats).toMatch(/id: 'chats-new-chat',[\s\S]*?symbol: 'square\.and\.pencil',/);
        expect(chats).toContain('navigation.dispatch(newChatAction(newChatWith));');
        expect(NEW_CHAT).toBe('New chat');
    });
});

describe('starter prompts on New chat (CB-359)', () => {
    const STATE = { settings: { paused: false }, tasks: [] } as never;
    const WORKSPACE = { setup: {} } as never;
    const DOTS = FRESH_DOTS as unknown as Dot[];
    const read = (file: string) => readFileSync(join(import.meta.dirname, '../../../..', file), 'utf8');

    it("are the web's three, in its order, from the web's own list", () => {
        // The web's starters are its en-US dictionary's (chat.composer), in order.
        const words = Object.values(
            (
                JSON.parse(
                    readFileSync(
                        new URL('../../../../packages/i18n/locales/en-US/chat.composer.json', import.meta.url),
                        'utf8',
                    ),
                ) as { new: { starters: Record<string, string> } }
            ).new.starters,
        );
        expect(words).toEqual([...STARTERS]);
        expect(read('packages/client/src/views/ChatViews.tsx')).toContain(
            "const STARTERS = ['think', 'research', 'plan']",
        );
        expect(STARTERS).toEqual(['Help me think this through', 'Research a public page', 'Make a plan I can follow']);
    });

    it('show for every socio, on the first run and on New chat at any time', async () => {
        const fresh = firstRun(await seeded());
        expect(fresh?.starters).toEqual(STARTERS.map((text) => ({ text, enabled: true })));
        for (const picked of ['sebas', 'mine']) {
            const view = newChatView({ dots: DOTS, state: STATE, workspace: WORKSPACE, picked });
            expect(view?.starters.map((starter) => starter.text)).toEqual([...STARTERS]);
        }
    });

    it("are off while no model is available, as the web's are, and on again once one is", async () => {
        const rows = await seeded();
        const none = firstRun({
            ...rows,
            workspace: withInference(rows.workspace, { available: false, byoAllowed: true }),
        });
        expect(none?.noInference).toBe(NO_INFERENCE_MESSAGES.connect);
        expect(none?.starters.every((starter) => !starter.enabled)).toBe(true);
        const some = firstRun({
            ...rows,
            workspace: withInference(rows.workspace, { available: true, byoAllowed: false }),
        });
        expect(some?.starters.every((starter) => starter.enabled)).toBe(true);
    });

    it("fill the socio's new-chat box with exactly the starter, in place of what was there, and send nothing", () => {
        const box = new Map<string, string>([[newChatDraft('sebas'), 'half a thought']]);
        const drafts = { write: (scope: string, text: string) => void box.set(scope, text) };
        expect(fillStarter(drafts, 'sebas', STARTERS[1])).toBe(true);
        expect(box.get(newChatDraft('sebas'))).toBe('Research a public page');
        expect(fillStarter(drafts, 'mine', STARTERS[2])).toBe(true);
        expect(box.get(newChatDraft('mine'))).toBe('Make a plan I can follow');
        expect(box.get(newChatDraft('sebas'))).toBe('Research a public page');
        // A locked draft (a newer build's) keeps what it holds; anything else still throws.
        expect(
            fillStarter(
                {
                    write: () => {
                        throw new DraftError('locked');
                    },
                },
                'sebas',
                STARTERS[0],
            ),
        ).toBe(false);
        expect(() =>
            fillStarter(
                {
                    write: () => {
                        throw new Error('closed');
                    },
                },
                'sebas',
                STARTERS[0],
            ),
        ).toThrow('closed');
    });

    it('are buttons above the composer that fill and never send, named for screen readers, gone while the keyboard is up', () => {
        const screen = read('apps/mobile/src/screens/first-run.tsx');
        const body = screen.slice(
            screen.indexOf('function StarterPrompts('),
            screen.indexOf('/** How long the new chat waits'),
        );
        expect(body).toContain('onPress={() => fillStarter(drafts, socioId, starter.text)}');
        expect(body).not.toContain('enqueueNewChat');
        expect(body).toContain('accessibilityLabel={starter.text}');
        expect(body).toContain('accessibilityHint={STARTER_HINT}');
        expect(body).toContain('disabled={!starter.enabled}');
        expect(body).toMatch(/useKeyboardState\(\(state\) => state\.isVisible\)[\s\S]*if \(keyboard/);
        // Outlined neutral cards, as the web's outline buttons, not filled mint ones.
        expect(body).not.toContain('tones.mint');
        expect(body).not.toContain('backgroundColor');
        expect(body).toMatch(/className=\{cx\(\s*'[^']*\bborder border-border\b[^']*'/);
        expect(body).toContain('<Text variant="footnote" tone="muted"');
        expect(body).toContain('<AppSymbol name="arrow-up-right" size={12} color="muted-foreground" />');
        expect(STARTER_HINT).toBe('Puts this in the message box');
        // Just above the composer, as the web's are, with only the model picker between,
        // which takes their place while its list is open.
        // The composer (the picker, then the box) is laid out once: in the scroll view right after
        // the starters, or pinned under it on New chat (CB-466), where the starters end the scroll view.
        const composer = screen.slice(screen.indexOf('const composer = ('), screen.indexOf('<FirstRunComposer'));
        expect(composer).toMatch(/^const composer = \(\s*<View className="gap-1">\s*<NewChatModel[^<]*\/>\s*$/);
        const frame = screen.slice(screen.indexOf('<StarterPrompts'), screen.indexOf('</Screen>'));
        expect(frame).toMatch(
            /^<StarterPrompts socioId=\{chosen\.id\} starters=\{view\.starters\} \/>\}\s*\{pinned \? null : composer\}\s*\{props\.children\}\s*$/,
        );
        expect(screen).toMatch(/\{content\}\s*<PinnedComposer>\{composer\}<\/PinnedComposer>/);
    });
});

describe('the model picker on New chat', () => {
    const read = (file: string) => readFileSync(join(import.meta.dirname, '../../src', file), 'utf8');
    const screen = read('screens/first-run.tsx');

    it("sits by the composer as the web's does, over model-picker.ts's view and the person's choices", () => {
        expect(screen).toContain("import { MODEL_PICKER_HINT, modelPickerView } from '../chat/model-picker';");
        expect(screen).toContain("import { useModelOptions } from './chat-header';");
        expect(screen).toContain('modelPickerView({ value: props.value, dotDefault: dot?.inference, models })');
        // Under the starters, right above the composer, which it hands the choice to.
        expect(screen).toMatch(/<NewChatModel[\s\S]*?<FirstRunComposer[\s\S]*?inference=\{inference\}/);
        expect(screen).toContain('testID="new-chat-model-picker"');
        // Disabled until the choices are known, as the web's (`disabled={!models}`).
        expect(screen).toContain('const disabled = models === null;');
    });

    it('opens an inline list, with no route of its own (the ChatModel sheet needs a chat)', () => {
        expect(screen).toContain('testID="new-chat-model-list"');
        expect(screen).toContain('testID={`new-chat-model-${row.key}`}');
        expect(screen).not.toContain("navigate('ChatModel'");
        expect(read('navigation/routes.ts')).not.toMatch(/NewChatModel/);
    });

    it('sends the chosen model in the create, and another socio starts on its default', () => {
        expect(screen).toMatch(/enqueueNewChat\(\{[\s\S]*?inference,\n\s*\}\)/);
        expect(screen).toContain('model !== null && model.socioId === chosen.id ? model.choice : null');
        // Never a model write after the create: another lane, so the first reply could run on the default.
        expect(screen).not.toContain('setChatModel');
    });

    it('reads "Automatic: …" for the default, as the web does', () => {
        const view = modelPickerView({
            value: null,
            dotDefault: null,
            models: { options: [], automatic: 'Self-hosted · fake-model' },
        });
        expect(view.label).toBe('Automatic: Self-hosted · fake-model');
    });
});
