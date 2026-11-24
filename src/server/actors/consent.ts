import {
    SCOPE_WORDS,
    type ActorScope,
    type AppAccessLevel,
    type Audience,
    type GrantConversationKind,
} from '@socio/shared/actor-scopes';
import { cardLabel, cardTask } from '@socio/shared/actors/card-text';
import {
    DATA_APPROVAL_WORDS,
    isConsequentialOperation,
    type DataApiOperation,
} from '@socio/shared/dataspace/operations';
import { canonicalJson } from '@socio/shared/jcs';
import {
    ACCESS_NEVER,
    ACCESS_VERB,
    ACTION_PARAMS,
    CARD_TEXT,
    type AppAccessCard,
    type AppActionCard,
    type CardAppFacts,
    type ParamCount,
} from '@socio/shared/socio-access';
import { inertText } from '@socio/shared/text/inert-text';

/**
 * The consent cards of delegated app access (CB-232): what the
 * person decides on, built from what the platform knows, with the
 * socio's and the app's words last, inert and marked as theirs. Payloads
 * are what the approval stores; the cards are rebuilt from them for every
 * view.
 */

/** A `request_app_access` approval's stored payload. */
export interface AccessPayload {
    v: 1;
    audience: Audience;
    appId: string;
    access: AppAccessLevel;
    scopes: ActorScope[];
    minutes: number;
    /** The socio's words as it gave them (trimmed, capped). */
    task: string;
    conversationId: string;
    conversationKind: GrantConversationKind;
    /** The app version's policy the card was shown for. */
    policyVersion: string;
    /** The live, narrower grant in this conversation this one widens. */
    replaces: string | null;
    alwaysAsk: boolean;
    socioName: string;
    facts: CardAppFacts;
    visibleTo: string | null;
    correlationId: string;
}

/** An `app_action` approval's stored payload. */
export interface ActionPayload {
    v: 1;
    audience: Audience;
    /** The id the intent digest names: an app's id, or `plugin:<id>`. */
    appId: string;
    grantId: string;
    /** The action's manifest name as declared. */
    action: string;
    /** The parameters as RFC 8785 canonical JSON: what the digest is over. */
    canonical: string;
    bytes: number;
    digest: string;
    counts: ParamCount[];
    /** The app's description, made inert already. */
    display: Array<{ label: string; value: string }>;
    socioName: string;
    facts: CardAppFacts;
    correlationId: string;
    /** A data operation's approval (`data:<op>`): the operation. */
    operation?: DataApiOperation;
}

/** The task and an app's label as a card shows them: moved to `@socio/shared/actors/card-text`. */
export { cardLabel, cardTask };

export const accessVerb = (access: AppAccessLevel) => ACCESS_VERB[access];

/** What each scope of a grant allows, in the platform's words. */
export function scopeLines(scopes: readonly ActorScope[]) {
    return scopes.map((scope) => SCOPE_WORDS[scope]);
}

/** The scopes a card names for each level: each line true of the whole. */
const CARD_SCOPES: Record<AppAccessLevel, ActorScope[]> = {
    read: ['app:read'],
    write: ['app:write'],
    act: ['app:write', 'app:act'],
};

export function accessCard(payload: AccessPayload): AppAccessCard {
    return {
        kind: 'app_access',
        socioName: inertText(payload.socioName, {
            max: CARD_TEXT.label,
            lines: false,
        }),
        access: payload.access,
        minutes: payload.minutes,
        app: payload.facts,
        // What the level adds, without the narrower scopes' "it can't
        // change anything" contradicting a write card.
        allows: scopeLines(CARD_SCOPES[payload.access]),
        never: ACCESS_NEVER,
        visibleTo: payload.visibleTo,
        task: cardTask(payload.task),
        widens: !!payload.replaces,
        alwaysAsk: payload.alwaysAsk,
    };
}

export function actionCard(payload: ActionPayload): AppActionCard {
    const preview = utf8Prefix(payload.canonical, ACTION_PARAMS.inlineBytes);
    return {
        kind: 'app_action',
        socioName: inertText(payload.socioName, {
            max: CARD_TEXT.label,
            lines: false,
        }),
        app: payload.facts,
        action: inertText(payload.action, {
            max: CARD_TEXT.action,
            lines: false,
        }),
        tier: 'consequential',
        // A data operation is the platform's: said in Socio's words.
        ...(payload.operation && isConsequentialOperation(payload.operation)
            ? {
                  operation: {
                      op: payload.operation,
                      words: DATA_APPROVAL_WORDS[payload.operation],
                  },
              }
            : {}),
        params: {
            preview: inertText(preview, { max: ACTION_PARAMS.maxBytes }),
            bytes: payload.bytes,
            complete: preview.length === payload.canonical.length,
            counts: payload.counts,
        },
        display: payload.display,
    };
}

/** The full parameters, inert, for the person who opens them. */
export const fullParams = (payload: ActionPayload) => inertText(payload.canonical, { max: ACTION_PARAMS.maxBytes + 1 });

/** Whether Allow waits until the parameters are opened (past 2 KB). */
export const paramsMustOpen = (payload: ActionPayload) => payload.bytes > ACTION_PARAMS.inlineBytes;

/** The longest prefix of `text` within `bytes` UTF-8 bytes, whole characters. */
export function utf8Prefix(text: string, bytes: number) {
    if (Buffer.byteLength(text) <= bytes) {
        return text;
    }
    let used = 0;
    let end = 0;
    for (const char of text) {
        const size = Buffer.byteLength(char);
        if (used + size > bytes) {
            break;
        }
        used += size;
        end += char.length;
    }
    return text.slice(0, end);
}

/** The most arrays a card counts, and how deep it looks for them. */
const COUNTS_MAX = 10;
const DEPTH_MAX = 8;
/**
 * The most values it visits: well past what the 64 KB the parameters may
 * be can hold (each value takes at least a byte), so it is never reached
 * by parameters a card shows; a bound on the work all the same.
 */
const VISITS_MAX = ACTION_PARAMS.maxBytes * 2;

/**
 * Every array in the parameters with its length, largest first: "142
 * items in `recipients`" heads the card, computed by the platform, not
 * the app. Arrays in arrays count by path pattern, summed over every
 * element (`batch[].to`: all the recipients of all the batches), never
 * the first element's alone.
 */
export function paramCounts(params: unknown): ParamCount[] {
    const totals = new Map<string, number>();
    let visits = 0;
    const walk = (value: unknown, path: string, depth: number) => {
        if (depth > DEPTH_MAX || ++visits > VISITS_MAX || value === null || typeof value !== 'object') {
            return;
        }
        if (Array.isArray(value)) {
            const at = path || '(the parameters)';
            totals.set(at, (totals.get(at) ?? 0) + value.length);
            for (const item of value) {
                walk(item, `${path}[]`, depth + 1);
            }
            return;
        }
        for (const [key, item] of Object.entries(value)) {
            walk(
                item,
                path
                    ? `${path}.${inertText(key, { max: 40, lines: false })}`
                    : inertText(key, { max: 40, lines: false }),
                depth + 1,
            );
        }
    };
    walk(params, '', 0);
    return [...totals]
        .map(([path, count]) => ({ path, count }))
        .sort((a, b) => b.count - a.count || a.path.localeCompare(b.path))
        .slice(0, COUNTS_MAX);
}

/**
 * The app's own description of an action (`display`), inert and capped:
 * shown last on the card, as the app's words. A string is one line, an
 * object one line per field; anything else is left out.
 */
export function displayLines(display: unknown): Array<{ label: string; value: string }> {
    const value = (item: unknown) =>
        inertText(
            typeof item === 'string'
                ? item
                : typeof item === 'number' || typeof item === 'boolean'
                  ? String(item)
                  : safeJson(item),
            { max: CARD_TEXT.displayValue },
        );
    if (typeof display === 'string') {
        return display.trim() ? [{ label: 'Description', value: value(display) }] : [];
    }
    if (!display || typeof display !== 'object' || Array.isArray(display)) {
        return [];
    }
    return Object.entries(display)
        .slice(0, CARD_TEXT.displayFields)
        .map(([key, item]) => ({
            label: inertText(key, { max: 60, lines: false }),
            value: value(item),
        }));
}

function safeJson(value: unknown) {
    try {
        return canonicalJson(value);
    } catch {
        return '(not shown)';
    }
}
