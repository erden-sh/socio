import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { ModelOptions } from '@socio/shared/inference';

import {
    chatInputLabel,
    chatMenu,
    chatPlaceholder,
    HERE_WITH_YOU,
    SAVE_AS_PAGE,
    SAVE_AS_PAGE_RUNNING,
    SCHEDULE_TASK,
    scheduleTaskHref,
    socioLineLabel,
    socioStatus,
} from '../../src/chat/chat-header';
import { COMPOSER_PLACEHOLDER } from '../../src/chat/composer';
import {
    INHERIT_MODEL,
    inheritedModelLabel,
    keptModelOptions,
    MODEL_PICKER_HINT,
    MODEL_PICKER_RUNNING_HINT,
    MODELS_OFFLINE,
    modelPickerView,
    modelTrigger,
    NO_LONGER_AVAILABLE,
} from '../../src/chat/model-picker';

// A private chat's header (the PWA comparison's 2.1 and 2.5): the socio's
// identity and status, the model picker, the "…" menu and the composer's
// "Message Sebas…", with the screens' wiring read as text.

const SRC = join(import.meta.dirname, '../../src');
const read = (file: string) => readFileSync(join(SRC, file), 'utf8');

const MODELS: ModelOptions = {
    automatic: 'Self-hosted · qwen',
    options: [
        {
            key: 'shared:local',
            choice: { source: 'shared', backendId: 'local' },
            label: 'qwen',
            group: 'Self-hosted',
            available: true,
        },
        {
            key: 'byo:chatgpt:astra',
            choice: { source: 'byo', kind: 'chatgpt', model: 'astra' },
            label: 'GPT-6-Astra',
            group: 'ChatGPT',
            available: false,
        },
    ],
};

describe("the socio's line", () => {
    it("says the web's words", () => {
        expect(socioStatus(false)).toBe('Here with you');
        expect(socioStatus(true)).toBe('Paused');
        expect(socioLineLabel('Sebas', HERE_WITH_YOU)).toBe('Sebas, Here with you');
        expect(socioLineLabel(null, HERE_WITH_YOU)).toBe('Your socio, Here with you');
    });
});

describe("the composer's placeholder", () => {
    it('names the socio as the web does, and stays plain while it is unknown', () => {
        expect(chatPlaceholder('Sebas')).toBe('Message Sebas…');
        expect(chatInputLabel('Sebas')).toBe('Message Sebas');
        expect(chatPlaceholder(null)).toBe(COMPOSER_PLACEHOLDER);
        expect(chatPlaceholder('  ')).toBe(COMPOSER_PLACEHOLDER);
        expect(chatPlaceholder('A'.repeat(40))).toBe(`Message ${'A'.repeat(24)}…`);
    });

    it("is the private chat's and the new chat's box", () => {
        expect(read('screens/chat.tsx')).toMatch(/placeholder=\{chatPlaceholder\(props\.socio\)\}/);
        expect(read('screens/first-run.tsx')).toMatch(/placeholder=\{placeholder\}/);
    });
});

describe('the "…" menu', () => {
    it('offers Save as page and Schedule a task, which opens the chat on the web', () => {
        expect(chatMenu(false)).toEqual([SAVE_AS_PAGE, SCHEDULE_TASK]);
        expect(SCHEDULE_TASK.label).toContain('opens in your browser');
        expect(scheduleTaskHref('a b')).toBe('/chats/a%20b');
    });

    it('offers nothing on a new chat not created yet', () => {
        expect(chatMenu(true)).toEqual([]);
        expect(chatMenu(true, true)).toEqual([]);
    });

    it("shows Save as page but can't choose it while a reply is being written, as the web", () => {
        expect(chatMenu(false, true)).toEqual([SAVE_AS_PAGE_RUNNING, SCHEDULE_TASK]);
        expect(SAVE_AS_PAGE_RUNNING).toEqual({
            name: SAVE_AS_PAGE.name,
            label: 'Save as a page once the reply is done',
            disabled: true,
        });
        expect(read('../../../packages/client/src/modules/chat/Chat.tsx')).toContain(
            "label={running ? t('chat:header.save-page-later') : t('chat:header.save-page')}",
        );
        // The web's words are its en-US dictionary's (chat).
        expect(
            (
                JSON.parse(
                    readFileSync(new URL('../../../../packages/i18n/locales/en-US/chat.json', import.meta.url), 'utf8'),
                ) as { header: Record<string, string> }
            ).header['save-page-later'],
        ).toBe('Save as a page once the reply is done');
        expect(SAVE_AS_PAGE.disabled).toBeUndefined();
    });

    it("follows the transcript's run, and its menu and prompt hold Save while it runs", () => {
        const chat = read('screens/chat.tsx');
        expect(chat).toContain('const menu = useChatMenu(id, view.title, running);');
        expect(chat).toContain('running={running}\n                menu={menu.menu}');
        expect(chat).toContain('onRunning={setRunning}');
        expect(chat).toContain('const running = turn.running || steering.running;');
        expect(chat).toContain('onRunning?.(running);');
        const header = read('screens/chat-header.tsx');
        expect(header).toContain('const actions = chatMenu(isLocalChat(id), running);');
        expect(header).toContain("canSave={(text) => !busy && !running && text.trim() !== ''}");
        // A disabled item: the native menu dims it (`attributes.disabled`, src/shell/native-menu.ts) and never runs it.
        const menu = read('screens/action-menu.tsx');
        expect(menu).toContain('const action = chosenAction(request.actions, id);');
        expect(menu).toContain('disabledButtonIndices: disabled');
    });

    it("holds the web's Save as page and Schedule a task in the bar's \u2026 (CB-420), and no voice call", () => {
        const header = read('screens/chat-header.tsx');
        expect(header).not.toMatch(/icons\/phone/);
        expect(header).not.toContain('FilePlus');
        expect(header).toContain("if (name === 'save-page') {\n                          savePage();");
        const chat = read('screens/chat.tsx');
        // One bar: the menu is a native bar item, never a second row under the bar.
        expect(chat).toMatch(/id: 'chat-menu',\s+label: CHAT_MENU_LABEL,\s+symbol: 'ellipsis',/);
        expect(chat).not.toContain('ChatSocioBar');
        expect(chat).not.toContain('HeaderBar');
    });

    it("is the private chat's bar: the socio and its model as the title, which opens the model sheet", () => {
        const chat = read('screens/chat.tsx');
        expect(chat).toContain('<PrivateChatBar');
        expect(chat).toMatch(
            /titleView: \{[\s\S]*?<ChatTitle[\s\S]*?onPick=\{\(\) => navigation\.navigate\('ChatModel', \{ id: props\.chatId \}\)\}/,
        );
        // The transcript scrolls under the bar, padded by it, the banners over it under the bar.
        expect(chat).toContain('contentContainerStyle={{ padding: 16, paddingTop: 16 + barInset }}');
        expect(chat).toContain('style={{ top: barInset }}');
        const header = read('screens/chat-header.tsx');
        expect(header).toContain('testID="chat-model-picker"');
        expect(header).toContain('<LocalAvatar character={props.character} size={SOCIO_SIZE} />');
    });
});

describe("the model picker's trigger", () => {
    it('opens the sheet, reads only on a new chat, and is disabled while a reply runs, as the web', () => {
        expect(modelTrigger({ local: false, running: false })).toEqual({
            disabled: false,
            chevron: true,
            hint: MODEL_PICKER_HINT,
        });
        expect(modelTrigger({ local: false, running: true })).toEqual({
            disabled: true,
            chevron: true,
            hint: MODEL_PICKER_RUNNING_HINT,
        });
        expect(modelTrigger({ local: true, running: true })).toEqual({
            disabled: true,
            chevron: false,
            hint: undefined,
        });
        expect(read('../../../packages/client/src/modules/chat/Chat.tsx')).toContain('disabled={!models || running}');
        const header = read('screens/chat-header.tsx');
        expect(header).toContain(
            'const trigger = modelTrigger({ local: isLocalChat(props.chatId), running: props.running });',
        );
        expect(header).toContain('disabled={trigger.disabled}');
        expect(header).toContain('accessibilityState={{ disabled: trigger.disabled }}');
    });

    it('holds a long name to its share of the row, cut at its end as the web cuts it, and keeps it whole for screen readers', () => {
        const header = read('screens/chat-header.tsx');
        // The bar's title holds the name and the model to the bar's middle; the model is the one cut.
        expect(header).toContain('style={{ maxWidth: width - 150 }}');
        expect(header).toContain('ellipsizeMode="tail"');
        // The start of the backend's name says what it is: never cut there.
        expect(header).not.toContain('ellipsizeMode="middle"');
        expect(header).toContain(
            'accessibilityLabel={`${socioLineLabel(props.socio, props.status)}. ${picker.accessibilityLabel}`}',
        );
        const long = 'Automatic: Self-hosted · fake-model-with-a-very-long-name';
        const view = modelPickerView({
            value: null,
            dotDefault: null,
            models: { automatic: 'Self-hosted · fake-model-with-a-very-long-name', options: [] },
        });
        expect(view.label).toBe(long);
        expect(view.accessibilityLabel).toBe(`Model for this chat: ${long}`);
        expect(view.rows[0]!.label).toBe(long);
    });
});

describe('the model picker', () => {
    it('labels what the chat inherits as the web does', () => {
        expect(inheritedModelLabel(null, MODELS)).toBe('Automatic: Self-hosted · qwen');
        expect(inheritedModelLabel({ source: 'shared', backendId: 'local' }, MODELS)).toBe(
            'Socio default: Self-hosted · qwen',
        );
        expect(inheritedModelLabel({ source: 'shared', backendId: 'gone' }, MODELS)).toBe(
            'Socio default unavailable; automatic: Self-hosted · qwen',
        );
    });

    it("checks the chat's model and disables one the person can't run on now", () => {
        const view = modelPickerView({
            value: { source: 'shared', backendId: 'local' },
            dotDefault: null,
            models: MODELS,
        });
        expect(view.label).toBe('qwen');
        expect(view.accessibilityLabel).toBe('Model for this chat: qwen');
        expect(view.rows.map((row) => [row.key, row.checked, row.disabled])).toEqual([
            [INHERIT_MODEL, false, false],
            ['shared:local', true, false],
            ['byo:chatgpt:astra', false, true],
        ]);
        expect(view.rows[2]!.label).toBe('GPT-6-Astra (not connected)');
        expect(view.rows[0]!.choice).toBeNull();
        expect(view.note).toBeNull();
    });

    it("shows a model that's gone as the web does", () => {
        const view = modelPickerView({
            value: { source: 'shared', backendId: 'old' },
            dotDefault: null,
            models: MODELS,
        });
        expect(view.label).toBe(NO_LONGER_AVAILABLE);
        expect(view.rows[1]).toMatchObject({ key: 'shared:old', checked: true, disabled: true });
    });

    it('reads offline with no choices kept: what the chat runs on, and a note', () => {
        const view = modelPickerView({ value: null, dotDefault: null, models: null });
        expect(view.label).toBe('Automatic');
        expect(view.rows).toHaveLength(1);
        expect(view.note).toBe(MODELS_OFFLINE);
        expect(keptModelOptions(JSON.stringify(MODELS))).toEqual(MODELS);
        expect(keptModelOptions('{')).toBeNull();
        expect(keptModelOptions(null)).toBeNull();
    });
});
