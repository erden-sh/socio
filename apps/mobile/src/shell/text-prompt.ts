import { CANCEL, SAVE } from '../chat/long-press';

// A one-field prompt (rename, a title, a link) in each platform's own component
// (the owner, 2026-11-19):
// - iOS: the system's `Alert.prompt`, a UIAlertController with a text field.
//   Its Save can't be disabled, so Save with text it can't take asks again with
//   the text kept, and a refusal (the app's check or the server's) is said in
//   a follow-up alert whose OK opens the prompt again with what was typed.
// - Android: a drawn Material 3 dialog (Android has no prompt of its own): a
//   title, an outlined text field, and text buttons at its end.
// The screen says what Save does (`onSave`), which gives back the reason when
// it refuses the text. No React Native here, so the Node tests read it as the
// app does.

/** Why Save didn't take the text, said to the person; nothing when it did. */
export type PromptRefusal = string | undefined;

/** What Save does with the text: done, or the reason it can't be. */
export type PromptSave = (text: string) => PromptRefusal | void | Promise<PromptRefusal | void>;

/** Whether the prompt is the system's (iOS's `Alert.prompt`) or the drawn Material dialog (Android). */
export const nativePrompt = (os: string) => os === 'ios';

/** The follow-up alert's one button, which opens the prompt again. */
export const PROMPT_AGAIN = 'OK';

/** The reason for text over the field's limit, which iOS's prompt can't hold to it. */
export const tooLong = (max: number) => `Keep it to ${max} characters or fewer.`;

/** Anything but blank: the prompts' Save by default. */
export const notBlank = (text: string) => text.trim() !== '';

/**
 * What iOS's Save does with `text`, whose button is never disabled:
 * - `again`: the prompt again with the text, as a disabled Save would do nothing;
 * - `refuse`: the reason in an alert, then the prompt again with the text;
 * - `save`: hand it to the screen.
 */
export function promptSaveStep(
    text: string,
    rules: { readonly maxLength: number; readonly canSave?: (text: string) => boolean },
): { readonly kind: 'again' } | { readonly kind: 'refuse'; readonly reason: string } | { readonly kind: 'save' } {
    if (text.length > rules.maxLength) {
        return { kind: 'refuse', reason: tooLong(rules.maxLength) };
    }
    return (rules.canSave ?? notBlank)(text) ? { kind: 'save' } : { kind: 'again' };
}

/** The reason in what `onSave` gave back, if it refused. */
export const refusalOf = (outcome: PromptRefusal | void): string | null =>
    typeof outcome === 'string' && outcome !== '' ? outcome : null;

/** One of iOS's prompt buttons, as `Alert.prompt` takes it, with what it does. */
export interface PromptButton {
    readonly text: string;
    readonly style: 'cancel' | 'default' | 'destructive';
    readonly does: 'cancel' | 'extra' | 'save';
}

/**
 * iOS's prompt buttons: Cancel, the extra one (Remove link, destructive), Save.
 * UIKit puts Cancel at the start and Save, the preferred one, at the end.
 */
export function promptButtons(extra?: string): readonly PromptButton[] {
    return [
        { text: CANCEL, style: 'cancel', does: 'cancel' },
        ...(extra === undefined ? [] : [{ text: extra, style: 'destructive' as const, does: 'extra' as const }]),
        { text: SAVE, style: 'default', does: 'save' },
    ];
}

/**
 * Material 3's dialog (m3.material.io, Dialogs): 28 dp corners, 24 dp padding,
 * 280 to 560 dp wide, a 24 sp headline, 16 dp under it and 24 dp over the
 * actions, text buttons 40 dp tall with 8 dp between them; the outlined field's
 * outline 1 dp, 2 dp in the primary color while focused.
 */
export const MATERIAL_DIALOG = {
    radius: 28,
    padding: 24,
    minWidth: 280,
    maxWidth: 560,
    titleGap: 16,
    actionsGap: 24,
    buttonHeight: 40,
    buttonGap: 8,
    fieldRadius: 4,
    fieldHeight: 56,
    outline: 1,
    outlineFocused: 2,
} as const;
