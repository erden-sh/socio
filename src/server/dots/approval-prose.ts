/**
 * Approvals happen on cards, never in prose (CB-492). A socio that needs
 * consent calls the tool that asks for it: the tool answers
 * `pending_approval` and the person decides on the approval card in the
 * chat. A reply that asks them to approve in text ("Please approve the
 * import to proceed") leaves them typing "You're approved", which grants
 * nothing.
 *
 * Here: the system prompt's rule, the check of a final reply, and the note
 * the next turn starts with after a reply the check flagged.
 */
import type { ChatMiddleware } from '@tanstack/ai';

import { pendingApproval } from '@socio/shared/approvals';

/** The system prompt's rule (CB-492). */
export const APPROVAL_GUIDE =
    'Consent for an action is given only on an approval card. A tool whose action needs consent asks for it itself: it answers "pending_approval" and the person sees the card in this chat, then the decision comes back to you. Never ask for approval or permission in your reply ("please approve", "do you approve", "reply yes to proceed"), and never ask the person to type their approval: call the tool, which shows the card, and say in a line what is waiting there. A typed "yes" or "approved" never replaces a card. Asking which option they want, or what they meant, is fine.';

/**
 * Phrases that ask the reader for approval or permission, in English and
 * Spanish. Each needs a request aimed at the reader (please, you, your,
 * reply/type) next to an approval word, so a reply that only mentions an
 * approval ("Ada approved it", "the approval card") doesn't match.
 */
const ASKS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
    { name: 'please_approve', pattern: /\bplease,?\s+(?:approve|authorize|authorise|confirm)\b/i },
    {
        name: 'you_approve',
        pattern:
            /\b(?:do|would|will|can|could)\s+you\s+(?:approve|authorize|authorise|consent|give\s+(?:me\s+)?(?:your\s+)?(?:approval|permission|consent|go-ahead))\b(?!\s+of\b)/i,
    },
    {
        name: 'approve_to_proceed',
        pattern: /\b(?:approve|authorize|authorise)\b[^.!?\n]{0,80}?\bto\s+(?:proceed|continue|go\s+ahead|start)\b/i,
    },
    {
        name: 'need_your_approval',
        pattern:
            /\b(?:need|needs|require|requires|waiting\s+for|awaiting|with)\s+your\s+(?:explicit\s+)?(?:approval|permission|consent|authori[sz]ation|go-ahead|ok|okay)\b/i,
    },
    {
        name: 'reply_to_approve',
        pattern:
            /\b(?:reply|respond|type|say|answer|write)\s+["“']?(?:yes|approve[d]?|ok|okay|confirm(?:ed)?|go)\b["”']?[^.!?\n]{0,40}?\bto\s+(?:proceed|continue|confirm|approve|go\s+ahead|start)\b/i,
    },
    {
        name: 'es_please_approve',
        pattern: /\bpor\s+favor,?\s+(?:apru[eé]b(?:a|e|alo|elo)|autoriza|autorice|confirm(?:a|e))\b/i,
    },
    {
        name: 'es_you_approve',
        pattern:
            /(?:¿|\b)(?:(?:me\s+)?apruebas|(?:me\s+)?autorizas|(?:me\s+)?das\s+(?:tu\s+)?(?:permiso|aprobaci[oó]n|autorizaci[oó]n|visto\s+bueno)|(?:me\s+)?(?:da|dan)\s+(?:su\s+)?(?:permiso|aprobaci[oó]n|autorizaci[oó]n|visto\s+bueno))\b/i,
    },
    {
        name: 'es_approve_to_proceed',
        pattern:
            /\b(?:apru[eé]b(?:a|e|alo|elo|en)|autoric(?:e|en)|autoriza)\b[^.!?\n]{0,80}?\bpara\s+(?:continuar|proceder|seguir|empezar)\b/i,
    },
    {
        name: 'es_need_your_approval',
        pattern:
            /\b(?:necesito|requiero|espero|esperando|con)\s+(?:tu|su)\s+(?:aprobaci[oó]n|autorizaci[oó]n|permiso|visto\s+bueno|confirmaci[oó]n)\b/i,
    },
    {
        name: 'es_reply_to_approve',
        pattern:
            /\b(?:responde|responda|escribe|escriba|di|diga|contesta|conteste)\s+["“']?(?:s[ií]|apruebo|aprobado|ok|vale|confirmo)(?![a-záéíóúñ])["”']?[^.!?\n]{0,40}?\bpara\s+(?:continuar|proceder|seguir|confirmar|aprobar)\b/i,
    },
];

/**
 * Words that point at the card: a reply that tells the person where to
 * decide ("approve it on the card above") is what a pending request should
 * get, and never flagged.
 */
const POINTS_AT_CARD = /\b(?:card|button|tarjeta|bot[oó]n)\b/i;

/** Code, quotes and links don't ask anything: they are dropped before the check. */
const quoted = (text: string) =>
    text
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/`[^`\n]*`/g, ' ')
        .replace(/^\s*>.*$/gm, ' ')
        .replace(/\[[^\]]*\]\([^)]*\)/g, ' ');

/**
 * The phrase in a final reply that asks the person to approve or permit
 * something in text, by its pattern's name; undefined when it asks nothing
 * of the kind or points at an approval card.
 */
export function approvalAsk(reply: string): { name: string; phrase: string } | undefined {
    const text = quoted(reply);
    if (!text.trim() || POINTS_AT_CARD.test(text)) {
        return undefined;
    }
    for (const { name, pattern } of ASKS) {
        const match = pattern.exec(text);
        if (match) {
            return { name, phrase: match[0].trim().slice(0, 120) };
        }
    }
    return undefined;
}

/** A message as the turn reads its history (`role`, `content`, a tool call's `toolCalls`). */
interface HistoryMessage {
    role: string;
    content?: unknown;
}

const textOf = (content: unknown): string => {
    if (typeof content === 'string') {
        return content;
    }
    if (Array.isArray(content)) {
        return content
            .map((part) =>
                part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
                    ? (part as { text: string }).text
                    : '',
            )
            .join('\n');
    }
    return '';
};

/**
 * Whether a request is still waiting in this conversation as far as its
 * messages show: a tool result that came back `pending_approval` after the
 * person's last message. Older ones were decided or are on their cards.
 */
export function pendingInHistory(messages: readonly HistoryMessage[]): boolean {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message.role === 'user') {
            return false;
        }
        if (message.role === 'tool' && pendingApproval(message.content)) {
            return true;
        }
    }
    return false;
}

/**
 * The note a turn starts with when the socio's previous reply asked for
 * approval in prose while nothing was waiting (CB-492): the correction,
 * once, so a typed "approved" leads to the tool, and its card, instead of
 * to the action.
 */
export const APPROVAL_PROSE_CORRECTION =
    'Your previous reply asked the person to approve in text, which grants nothing. If an action needs their consent, call its tool now: it shows them an approval card. Don’t ask in your reply again, and don’t take a typed approval as consent for it.';

/**
 * The correction for this turn, when the reply before the person's newest
 * message asked for approval in prose with no request waiting.
 */
export function approvalProseCorrection(messages: readonly HistoryMessage[]): string | undefined {
    let lastUser = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (messages[index].role === 'user') {
            lastUser = index;
            break;
        }
    }
    if (lastUser <= 0) {
        return undefined;
    }
    const before = messages.slice(0, lastUser);
    let reply = -1;
    for (let index = before.length - 1; index >= 0; index -= 1) {
        if (before[index].role === 'user') {
            break;
        }
        if (before[index].role === 'assistant' && textOf(before[index].content).trim()) {
            reply = index;
            break;
        }
    }
    if (reply < 0 || !approvalAsk(textOf(before[reply].content))) {
        return undefined;
    }
    return pendingInHistory(before) ? undefined : APPROVAL_PROSE_CORRECTION;
}

/** A final reply the check flagged (CB-492), as its log line carries it: no reply text. */
export interface ApprovalProseEvent {
    event: 'approval_prose';
    runId: string;
    threadId: string;
    dotId: string;
    /** The matching pattern's name (`please_approve`, `es_you_approve`, ...). */
    pattern: string;
}

/** The event's structured log line. */
export const approvalProseLogLine = (event: ApprovalProseEvent) =>
    `Approvals: ${event.event} run=${JSON.stringify(event.runId)} thread=${JSON.stringify(event.threadId)} dot=${JSON.stringify(event.dotId)} pattern=${event.pattern}`;

/**
 * The turn's check of its final reply (CB-492), as chat middleware: a
 * reply that asks for approval in prose while no request of this turn is
 * waiting (no tool came back `pending_approval`, and the turn didn't end
 * waiting for the person) is flagged to `flag`. The loop can't take the
 * streamed reply back, so the correction comes as the next turn's note
 * (`approvalProseCorrection`).
 */
export function approvalProseCheck(options: {
    /** Whether the turn ended waiting for the person (a client tool or an approval). */
    waiting: () => boolean;
    flag: (ask: { name: string }) => void;
}): ChatMiddleware {
    let pending = false;
    return {
        name: 'socio-approval-prose',
        onAfterToolCall: (_ctx, info) => {
            if (pendingApproval(info.result)) {
                pending = true;
            }
        },
        onFinish: (_ctx, info) => {
            if (pending || options.waiting() || info.finishReason === 'tool_calls') {
                return;
            }
            const ask = approvalAsk(info.content);
            if (ask) {
                options.flag(ask);
            }
        },
    };
}
