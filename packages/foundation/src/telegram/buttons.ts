/**
 * The inline buttons the Telegram channel puts under its own messages
 * (CB-145): approve or deny an approval request, keep or turn down a
 * proposed memory, and choose a socio. A button's `callback_data` names
 * what it does and the id it acts on; Telegram sends it back as is when
 * it is pressed, so the handler checks who pressed it, as the web routes
 * check the signed-in person, and never trusts the id alone.
 */
export type TelegramButton =
    | { kind: 'approval'; approve: boolean; id: string }
    | { kind: 'memory'; keep: boolean; id: string }
    | { kind: 'socio'; dotId: string };

/**
 * A button that sends its `callback_data` back when pressed: grammy's
 * `InlineKeyboardButton.CallbackButton`, the only kind these are.
 */
export interface CallbackButton {
    text: string;
    callback_data: string;
}

/** Buttons under a message, by row: grammy's `InlineKeyboardMarkup`, callback buttons only. */
export interface CallbackKeyboard {
    inline_keyboard: CallbackButton[][];
}

/** Ours, versioned: buttons another bot or an older format made are not. */
const PREFIX = 'sb1:';
/** Ids as the app makes them (UUIDs), well within Telegram's 64 bytes. */
const ID = /^[A-Za-z0-9_-]{1,48}$/;

export const isOwnButton = (data: string | undefined) => !!data?.startsWith(PREFIX);

/** A button's `callback_data`. */
export function buttonData(button: TelegramButton) {
    switch (button.kind) {
        case 'approval':
            return `${PREFIX}a${button.approve ? '+' : '-'}:${button.id}`;
        case 'memory':
            return `${PREFIX}m${button.keep ? '+' : '-'}:${button.id}`;
        case 'socio':
            return `${PREFIX}s:${button.dotId}`;
    }
}

/** What a pressed button asks for; none for data that isn't a button of ours. */
export function parseButton(data: string | undefined): TelegramButton | undefined {
    if (!data?.startsWith(PREFIX)) {
        return undefined;
    }
    const match = /^(a|m)([+-]):(.+)$|^s:(.+)$/.exec(data.slice(PREFIX.length));
    if (!match) {
        return undefined;
    }
    const id = match[3] ?? match[4];
    if (!ID.test(id)) {
        return undefined;
    }
    if (match[4]) {
        return { kind: 'socio', dotId: id };
    }
    const yes = match[2] === '+';
    return match[1] === 'a' ? { kind: 'approval', approve: yes, id } : { kind: 'memory', keep: yes, id };
}

const button = (text: string, action: TelegramButton): CallbackButton => ({
    text,
    callback_data: buttonData(action),
});

/** Approve and Deny, under an approval request's notice. */
export const approvalButtons = (id: string): CallbackKeyboard => ({
    inline_keyboard: [
        [
            button('Approve', { kind: 'approval', approve: true, id }),
            button('Deny', { kind: 'approval', approve: false, id }),
        ],
    ],
});

/** Keep and Turn down, under a proposed memory. */
export const memoryButtons = (id: string): CallbackKeyboard => ({
    inline_keyboard: [
        [button('Keep', { kind: 'memory', keep: true, id }), button('Turn down', { kind: 'memory', keep: false, id })],
    ],
});

/** One socio per row, the current one checked. */
export const socioButtons = (
    dots: ReadonlyArray<{ id: string; name: string; personal: boolean }>,
    current: string | undefined,
): CallbackKeyboard => ({
    inline_keyboard: dots
        .filter((dot) => ID.test(dot.id))
        .map((dot) => [
            button(`${dot.id === current ? '✓ ' : ''}${dot.name}${dot.personal ? ' (yours)' : ''}`, {
                kind: 'socio',
                dotId: dot.id,
            }),
        ]),
});
