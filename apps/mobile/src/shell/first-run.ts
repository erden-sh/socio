import { NO_INFERENCE_MESSAGES } from '@socio/shared/inference';
import type { Conversation, Dot, State } from '@socio/shared/types';

import { chatInputLabel, chatPlaceholder } from '../chat/chat-header';
import { DraftError, type Drafts, newChatDraft } from '../sync/chat-drafts';
import type { ShellWorkspace } from '../sync/shell';

import { chatList } from './chat-list';
import { homeSocios, type SocioRow } from './home';

// The first run: with no chats
// yet, Home opens New chat with the default socio chosen, a socio picker at
// the top (ChatGPT's model picker) and the privacy line. Home
// shows it, through `useFirstRun` and
// `FirstRun` (src/screens/first-run.tsx). No React Native, so tests/shell runs
// it under Node on seeded collections.
// - Only once the scope knows there are none: both shell rows have come (the
//   state row says whether rooms count, the workspace row brought the chats),
//   and no chat shows in the chat list (rooms included, while they're on), so
//   someone invited to a room lands on their chats. With no socio there is
//   nothing to chat with, and Home stays.
// - The default socio is the web's `homeDot`: the one picked, while it is
//   still there, else the first not archived, oldest first.
// - No model: the web's NoInferenceNotice, from the workspace row's
//   `setup.inference` (`State.configured` is the research runs' set-up, not
//   chat's model). A socio set to its own model needs the person's model
//   options, which nothing here fetches, so it says nothing, as the web
//   does while they load.
// - Its composer sends the first message as a new chat: the
//   screen then opens that chat under its local id.
// - New chat, at any time: the same
//   screen as its own route (`NewChat`, screens/new-chat.tsx), from Home's New
//   chat, a socio row's new-chat button and the Chats tab's compose button.
//   `newChatView` is its view, with no condition on the chat list, opening on
//   the socio it was asked for (else the default).
// - Starter prompts (CB-359): the web's three new-chat starters, the same for
//   every socio, above the composer while the chat has no message yet. A tap
//   fills the box with the starter, as the web's `setPrompt(text)` does; it
//   never sends. They are off while no model is available (the web's
//   `disabled={!usable}`).

/** New chat's words: Home's button, the Chats tab's compose button. */
export const NEW_CHAT = 'New chat';
/** A socio row's new-chat button (the web's `dot-new-chat`). */
export const newChatWithLabel = (socio: string) => `New chat with ${socio}`;

/** A short form of the web guide's privacy note (packages/client/src/modules/onboarding/guides.ts). */
export const PRIVACY_LINE =
    'A personal socio and its chats belong to you. A workspace socio is shared, and so are pages in Spaces.';

/**
 * The web's new-chat starters (packages/client/src/views/ChatViews.tsx,
 * `starters`), in its order; tests/shell/first-run.test.ts reads the web's file
 * to keep them the same.
 */
export const STARTERS = ['Help me think this through', 'Research a public page', 'Make a plan I can follow'] as const;

/** What a starter does, for screen readers. */
export const STARTER_HINT = 'Puts this in the message box';

/** The starters' group, for screen readers. */
export const STARTERS_LABEL = 'Suggestions';

export interface StarterPrompt {
    /** What fills the box, and what the card says. */
    readonly text: string;
    /** Off while no model is available to the person, as the web's are. */
    readonly enabled: boolean;
}

/**
 * A tap on a starter: the socio's new-chat box holds exactly its text, in place
 * of what was there (the web's `setPrompt(text)`). Nothing is sent. False when
 * the draft is locked (a newer build's), which keeps what it holds.
 */
export function fillStarter(drafts: Pick<Drafts, 'write'>, socioId: string, text: string): boolean {
    try {
        drafts.write(newChatDraft(socioId), text);
        return true;
    } catch (error) {
        if (error instanceof DraftError) {
            return false;
        }
        throw error;
    }
}

/** A socio in the picker: Home's row, and whether it is someone's own (the web's "Personal" badge). */
export interface FirstRunSocio extends SocioRow {
    readonly personal: boolean;
}

export interface FirstRunView {
    /** The picker's socios, oldest first. */
    readonly socios: readonly FirstRunSocio[];
    /** The one the new chat is with. */
    readonly chosen: FirstRunSocio;
    /** The composer's label, which names the socio. */
    readonly composerLabel: string;
    /** The composer's placeholder, the web's "Message Sebas…". */
    readonly composerPlaceholder: string;
    readonly privacy: string;
    /** NO_INFERENCE_MESSAGES' line when no model is available to the person, else null. */
    readonly noInference: string | null;
    /** The person may connect their own subscription (Account → Inference, on the web). */
    readonly canConnect: boolean;
    /** The web's starters, above the composer. */
    readonly starters: readonly StarterPrompt[];
}

export interface FirstRunInput {
    readonly chats: readonly Conversation[];
    readonly dots: readonly Dot[];
    readonly state: Pick<State, 'settings' | 'tasks'> | null;
    readonly workspace: Pick<ShellWorkspace, 'setup'> | null;
    /** The socio the person picked, if any. */
    readonly picked?: string | null;
}

/** The workspace row's chat model availability, or null when it doesn't say (an older server). */
function availability(workspace: Pick<ShellWorkspace, 'setup'> | null) {
    const inference: unknown = workspace?.setup?.inference;
    return inference !== null && typeof inference === 'object'
        ? (inference as NonNullable<ShellWorkspace['setup']['inference']>)
        : null;
}

/** The web's NoInferenceNotice line for a new chat with `dot`, or null. */
export function noInferenceMessage(
    dot: Pick<Dot, 'inference'>,
    workspace: Pick<ShellWorkspace, 'setup'> | null,
): string | null {
    if (dot.inference !== undefined && dot.inference !== null) {
        return null;
    }
    const inference = availability(workspace);
    if (inference === null || inference.available !== false) {
        return null;
    }
    return inference.byoAllowed === true ? NO_INFERENCE_MESSAGES.connect : NO_INFERENCE_MESSAGES.operator;
}

/** The first-run screen's view, or null when Home shows its lists. */
export function firstRun(input: FirstRunInput): FirstRunView | null {
    const { chats, dots, state } = input;
    if (state === null || chatList(chats, dots, state).length > 0) {
        return null;
    }
    return newChatView(input);
}

/** The socio a new chat opens on with none asked for: the oldest not archived (the web's `homeDot`), or null. */
export function defaultSocioId(dots: readonly Dot[], state: Pick<State, 'settings' | 'tasks'> | null): string | null {
    return homeSocios(dots, state)[0]?.id ?? null;
}

/**
 * New chat's view at any time (the `NewChat` route): the picker's socios, the
 * one `picked` while it is still there (else the default), the privacy line
 * and the no-model line. Null until both shell rows have come, or with no socio.
 */
export function newChatView({
    dots,
    state,
    workspace,
    picked = null,
}: Omit<FirstRunInput, 'chats'>): FirstRunView | null {
    if (state === null || workspace === null) {
        return null;
    }
    const byId = new Map(dots.map((dot) => [dot.id, dot]));
    const socios = homeSocios(dots, state).map((row) => {
        const owner = byId.get(row.id)?.ownerId;
        return { ...row, personal: typeof owner === 'string' && owner !== '' };
    });
    const chosen = socios.find((socio) => socio.id === picked) ?? socios[0];
    if (chosen === undefined) {
        return null;
    }
    const dot = byId.get(chosen.id);
    const noInference = dot === undefined ? null : noInferenceMessage(dot, workspace);
    return {
        socios,
        chosen,
        composerLabel: chatInputLabel(chosen.name),
        composerPlaceholder: chatPlaceholder(chosen.name),
        privacy: PRIVACY_LINE,
        noInference,
        canConnect: availability(workspace)?.byoAllowed === true,
        starters: STARTERS.map((text) => ({ text, enabled: noInference === null })),
    };
}
