/**
 * Whether the person asked, in their own words, for a memory about
 * themselves (CB-172): "remember I prefer metric units". Such a memory is
 * saved at once, with no approval; anything else a socio proposes waits
 * for the person. A socio's say-so is never enough: the person's own
 * newest message must ask for it, so a socio can't skip approval by
 * claiming it. Text the person pastes is left out where it shows as a
 * paste (quoted, fenced, long, or given to translate or summarize); a
 * short paste that asks, without any of these, still reads as theirs.
 *
 * Deliberately strict, since a miss only means the usual proposal. The
 * message, without its quoted lines, quoted spans and code blocks
 * (pasted text), must:
 * - be short, as a request is; a long one is most likely a paste;
 * - not hand the socio text to work on ("translate this", "summarize");
 * - ask to remember something (in English or Spanish), not ask whether
 *   the socio remembers, nor ask it not to;
 * - be about the person: in the first person, with no one else in it
 *   ("he", "they", "boss", "my new team lead", "mi madre", a name that
 *   does something: "Bob is", "Sam, who …"), and the memory no one
 *   else's either ("Their boss …", "Ana is …", "Wife loves …");
 * - have no relative pronoun, in the message or the memory, whatever
 *   comes before it (who, whose, whom, quien, cuyo; any Spanish "que"
 *   but the one right after the request): "an intern who is pregnant",
 *   "bob who is diabetic", "alguien que tiene epilepsia";
 * - name no generic person ("intern", "someone", "the new hire",
 *   "alguien", "vecino" …) either: when in doubt it goes to approval;
 * - hold most of the memory's words, and say "not" where it does, so the
 *   socio saves what they said and nothing it made up or turned around.
 */

/** The longest message, quotes and code left out, that can ask. */
export const ASKED_MESSAGE_MAX = 600;
/** The share of the memory's words the person's message must hold. */
const WORDS_SHARE = 0.6;

/** Any of `words`, whole, in any case: letters beyond ASCII count as letters. */
const anyOf = (words: string, flags = 'iu') => new RegExp(`(?<!\\p{L})(?:${words})(?!\\p{L})`, flags);
const ASKING =
    "remember|memori[sz]e|don['’]?t forget|do not forget|keep in mind|make a note|note down|recuerda|recuérda(?:lo|melo)|acuérdate|no olvides|apunta|anota|ten en cuenta";
const ASK = anyOf(ASKING);
/** "Don't remember …" or "do you remember …": not a request. */
const NOT_ASK = anyOf(
    "(?:don['’]?t|do not|never|no need to) (?:remember|memori[sz]e|keep in mind|note down)|(?:do|did|can|could|will|would) you (?:still )?remember",
);
/** Asking the socio to work on text the person pasted, not to remember. */
const WORKS_ON_PASTE = anyOf(
    'translate|summari[sz]e|summary of|tl;?dr|proofread|tradu(?:ce|z|cir|ceme)|resúme(?:me|lo)|resume (?:esto|este|esta)',
);
const FIRST_PERSON = anyOf("I|I['’](?:m|ve|d|ll)|me|my|mine|myself|yo|mi|mis|conmigo");
/** The people in someone's life, in English and Spanish, one or more. */
const RELATIONS =
    '(?:wife|husband|spouse|partner|boyfriend|girlfriend|fianc[eé]e?|boss|manager|(?:team|tech) ?lead|supervisor|colleague|co-?worker|teammate|employee|assistant|friend|mom|mum|mother|mommy|mummy|dad|father|daddy|parent|son|daughter|kid|child|children|baby|brother|sister|sibling|family|cousin|aunt|uncle|niece|nephew|grandma|grandmother|grandpa|grandfather|grandparent|in-laws?|doctor|dentist|therapist|nurse|neighbou?r|roommate|flatmate|landlord|landlady|client|customer|co-?founder|madre|padre|mamá|papá|jefe|jefa|esposa|esposo|mujer|marido|pareja|novio|novia|prometid[oa]|hijo|hija|niño|niña|bebé|hermano|hermana|amigo|amiga|compañer[oa]|colega|abuelo|abuela|tío|tía|primo|prima|sobrino|sobrina|suegro|suegra|familia|médico|médica|doctora|dentista|vecino|vecina|cliente|clienta|intern|someone|somebody|anyone|anybody|everyone|everybody|nobody|new hire|hire|alguien|nadie|becari[oa]|practicante|emplead[oa])(?:e?s)?';
/** Someone else's: "my boss", "my lovely new team lead", "mi madre". */
const SOMEONE_ELSES = anyOf(`(?:my|our|his|her|their|mi|mis|nuestr[oa]s?|su|sus)(?: \\p{L}+){0,2} ${RELATIONS}`);
/**
 * Someone in the person's life, with no "my": "Wife loves it". All but
 * "son", which is Spanish for "are" ("my son" is still caught above).
 */
const SOMEONE = anyOf(`(?!sons?(?!\\p{L}))${RELATIONS}`);
/**
 * A relative pronoun: something is being said of someone, named or not,
 * in any case ("bob who is diabetic", "an intern who is pregnant").
 */
const RELATIVE = anyOf('who|whose|whom|quien|quienes|cuy[oa]s?');
/**
 * Spanish "que" is a relative pronoun ("con Bob que es diabético") as well
 * as "that" ("recuerda que prefiero …"), and the two can't be told apart
 * reliably. So any "que" counts, but the one right after the request
 * ("recuerda que", "acuérdate de que", "ten en cuenta que").
 */
const QUE = anyOf('que');
const RELATIVE_QUE = (words: string) =>
    QUE.test(words.replace(new RegExp(`(?<!\\p{L})(?:${ASKING})(?: de)? que(?!\\p{L})`, 'giu'), ' '));
const OTHERS = anyOf('he|she|him|her|his|hers|they|them|their|theirs|él|ella|ellos|ellas|su|sus');
/** Saying "not": the memory must say it where the person did, and only there. */
const NEGATION = new RegExp(
    `${anyOf('not|no|never|nothing|none|cannot|nunca|jamás|tampoco|nada|ni').source}|\\p{L}n['’]t(?!\\p{L})`,
    'iu',
);

/**
 * The message as the person typed it: quoted lines, code blocks and
 * quoted spans ("…", “…”, «…») out.
 */
const ownWords = (said: string) =>
    said
        .replace(/```[\s\S]*?(?:```|$)/g, ' ')
        .replace(/"[^"]*(?:"|$)|“[^”]*(?:”|$)|«[^»]*(?:»|$)/g, ' ')
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('>'))
        .join('\n')
        .trim();

/**
 * The memory's words of four letters or more: those that carry meaning
 * ("not" is checked on its own: "doesn't" is no word here).
 */
const words = (text: string) =>
    (
        text
            .toLowerCase()
            .replace(/\p{L}+n['’]t(?!\p{L})/gu, ' ')
            .match(/\p{L}{4,}/gu) ?? []
    ).filter((word) => !['person', 'people', 'user', 'socio'].includes(word));

/** The same word, give or take an ending: "pack", "packs", "packing". */
const same = (a: string, b: string) => {
    const length = Math.min(5, a.length, b.length);
    return a.slice(0, length) === b.slice(0, length);
};

/**
 * What follows a name that says something about its person: a relative
 * clause ("Bob, who", "Ana que"), a possessive ("Bob's") or a verb ("Bob
 * is", "Sam hates", "John loved", "Ana es").
 */
const DOES =
    "(?:,?\\s+(?:who|whose|whom|que|quien|quienes|cuy[oa]s?)|['’]s|\\s+(?:is|was|are|were|has|had|have|can|could|will|would|should|must|does|did|do|isn['’]t|wasn['’]t|doesn['’]t|didn['’]t|can['’]t|won['’]t|es|está|era|fue|tiene|ha|odia|ama|quiere|prefiere|come|vive|trabaja|no|\\p{Ll}+(?:s|ed)))(?!\\p{L})";

/**
 * Someone the person named, that the memory is about: "remember I work
 * with Ana and Ana is vegetarian" saved as "Ana is vegetarian", or "I live
 * with Bob who is diabetic" as "Lives with Bob, who is diabetic". A name
 * is a word the person capitalized mid-sentence (or one that starts a
 * sentence and is in the memory too: "… Bob loves it"), but "I". It is
 * someone else when, in the message or the memory, something is said of
 * them, or the memory starts with them or has them start a clause.
 */
const aboutNamed = (own: string, text: string) => {
    const names = new Set<string>();
    for (const match of own.matchAll(/(^|[.!?\n¿¡:;]\s*|\s+)(\p{Lu}\p{L}*)(?!\p{L})/gu)) {
        const [, before, name] = match;
        if (name === 'I' || ASK.test(name)) {
            continue;
        }
        const midSentence = /^\s+$/.test(before) && match.index > 0;
        if (midSentence || new RegExp(`(?<!\\p{L})${name}(?!\\p{L})`, 'u').test(text)) {
            names.add(name);
        }
    }
    return [...names].some(
        (name) =>
            new RegExp(`(?<!\\p{L})${name}${DOES}`, 'u').test(own) ||
            new RegExp(`(?<!\\p{L})${name}${DOES}`, 'u').test(text) ||
            new RegExp(
                `(?:^|[.;:,!?]\\s*|\\s(?:and|but|that|so|because|y|pero|que|porque)\\s+)${name}\\s+\\p{Ll}`,
                'u',
            ).test(text.trim()),
    );
};

export function askedToRemember(said: string | undefined, text: string) {
    if (!said) {
        return false;
    }
    const own = ownWords(said);
    if (!own || own.length > ASKED_MESSAGE_MAX || WORKS_ON_PASTE.test(own)) {
        return false;
    }
    // A request: a sentence asking to remember, not a question ("do you
    // remember …?") nor a "don't remember …".
    const asks = own
        .split(/(?<=[.!?\n])/)
        .some((sentence) => ASK.test(sentence) && !/[?¿]/.test(sentence) && !NOT_ASK.test(sentence));
    if (!asks || !FIRST_PERSON.test(own)) {
        return false;
    }
    if (
        OTHERS.test(own) ||
        [own, text].some(
            (words) => SOMEONE_ELSES.test(words) || SOMEONE.test(words) || RELATIVE.test(words) || RELATIVE_QUE(words),
        )
    ) {
        return false;
    }
    if (aboutNamed(own, text)) {
        return false;
    }
    // "Don't forget" asks; it says no "not" about the person.
    const stated = own.replace(anyOf(ASKING, 'giu'), ' ');
    if (NEGATION.test(stated) !== NEGATION.test(text)) {
        return false;
    }
    const wanted = words(text);
    if (!wanted.length) {
        return false;
    }
    const typed = words(own);
    const held = wanted.filter((word) => typed.some((other) => same(word, other))).length;
    return held / wanted.length >= WORDS_SHARE;
}
