/**
 * The capability key and the words behind it: how Dots' capability requests
 * are deduplicated and how the board's search and duplicate checks read
 * words. Moved from `issues/requests.ts`, which re-exports it.
 */
import type { IssueArea } from '@socio/shared/issues/issue-types';

export const STOPWORDS = new Set(
    `a an the to for of and or with without in on at by from into via my me i we our you your it its this that these those is are be been being
  able ability can could would should will way ways some any new more better support supports supported access capability capabilities tool tools
  feature features function please need needs want wants allow allows let lets do does use uses using used make get have has thing things`.split(
        /\s+/,
    ),
);
/** Words that mean the same thing here, mapped before stemming. */
const SYNONYMS: Record<string, string[]> = {
    mail: ['email'],
    db: ['database'],
    kv: ['key', 'value'],
    storage: ['store'],
    persistent: ['persist'],
    persistence: ['persist'],
    persisted: ['persist'],
    durable: ['persist'],
    cron: ['schedule'],
    timer: ['schedule'],
    browse: ['web'],
    browsing: ['web'],
    internet: ['web'],
    http: ['web'],
    https: ['web'],
    spreadsheet: ['sheet'],
    spreadsheets: ['sheet'],
};

/** A crude stemmer: plural and verb endings, then a final `e`. */
export function stem(word: string) {
    let w = word;
    if (w.length > 4 && w.endsWith('ies')) {
        w = `${w.slice(0, -3)}y`;
    } else if (w.length > 4 && w.endsWith('sses')) {
        w = w.slice(0, -2);
    } else if (w.length > 3 && /[^su]s$/.test(w) && !w.endsWith('ss')) {
        w = w.slice(0, -1);
    }
    for (const suffix of ['ing', 'ed']) {
        if (w.endsWith(suffix) && w.length - suffix.length >= 3) {
            w = w.slice(0, -suffix.length);
            // `sending` → `send`, but `running` → `run`.
            if (/([b-df-hj-np-tv-z])\1$/.test(w) && !/(ll|ss|zz)$/.test(w)) {
                w = w.slice(0, -1);
            }
            break;
        }
    }
    if (w.length > 3 && w.endsWith('e')) {
        w = w.slice(0, -1);
    }
    return w;
}

/**
 * The dedupe key of a capability name: lowercase, accents and punctuation
 * dropped, stopwords removed, synonyms mapped, words stemmed, then unique
 * and sorted, so "Send emails" and "email sending" are the same request.
 * Falls back to the plain lowercase words when every word is a stopword.
 */
export function capabilityKey(capability: string) {
    const plain = capability
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/\be-mail/g, 'email')
        .replace(/\bkey[\s-]*value\b/g, 'kv')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
    const words = plain.split(' ').filter(Boolean);
    const kept = words
        .filter((word) => !STOPWORDS.has(word))
        .flatMap((word) => SYNONYMS[word] ?? [word])
        .map(stem)
        .filter((word) => !STOPWORDS.has(word));
    return [...new Set(kept.length ? kept : words)].sort().join(' ');
}

/** A guess at the issue area from the capability's words; none when unsure. */
const AREA_WORDS: Array<[IssueArea, RegExp]> = [
    ['telegram', /\btelegram\b/],
    ['chat', /\bweb ?chat\b/],
    ['homepage', /\bhome ?page\b/],
    ['schedules', /\b(schedules?|scheduled|cron|recurring)\b/],
    ['computers', /\b(computer|shell|terminal|exec|browser|desktop|sandbox)\b/],
    ['spaces', /\b(page|pages|space|spaces|document|editor)\b/],
    ['learning', /\b(skill|skills|learn|learning)\b/],
    ['model', /\b(model|llm|inference|vision|image generation)\b/],
    ['auth', /\b(sign in|login|passkey|auth)\b/],
];
export function guessArea(text: string): IssueArea | null {
    const lower = text.toLowerCase();
    return AREA_WORDS.find(([, words]) => words.test(lower))?.[0] ?? null;
}
