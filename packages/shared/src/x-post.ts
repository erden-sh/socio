/**
 * X post text the way X counts it (twitter-text v3): a weight per code
 * point, URLs counted as 23. This builds intent links only. Nothing here
 * calls X.
 */

const SCALE = 100;
/** Counted as one character. Everything else (emoji, CJK) counts as two. */
const SINGLE: readonly (readonly [number, number])[] = [
    [0, 4351],
    [8192, 8205],
    [8208, 8223],
    [8242, 8247],
];
const URL_LENGTH = 23;
const TRAILING = /[.,!?;:'")\]]+$/;

export const X_POST_LIMIT = 280;

function single(code: number) {
    return SINGLE.some(([start, end]) => code >= start && code <= end);
}

/** A URL starting at `index`, without trailing punctuation, or undefined. */
function urlAt(text: string, index: number) {
    const rest = text.slice(index);
    const match = /^(?:https?:\/\/|www\.)\S+/i.exec(rest);
    if (!match) {
        return undefined;
    }
    const trimmed = match[0].replace(TRAILING, '');
    return trimmed.length ? trimmed : undefined;
}

/** Display length: weighted total divided by the scale. */
export function weightedLength(text: string) {
    let weight = 0;
    for (let i = 0; i < text.length;) {
        const url = urlAt(text, i);
        if (url) {
            weight += URL_LENGTH * SCALE;
            i += url.length;
            continue;
        }
        const code = text.codePointAt(i)!;
        weight += single(code) ? SCALE : SCALE * 2;
        i += code > 0xffff ? 2 : 1;
    }
    return weight / SCALE;
}

export function overLimit(text: string) {
    return weightedLength(text) > X_POST_LIMIT;
}

/** `https://x.com/intent/post?text=` and `in_reply_to` when there is an id. */
export function intentUrl(text: string, inReplyTo?: string) {
    const url = new URL('https://x.com/intent/post');
    url.searchParams.set('text', text);
    if (inReplyTo) {
        url.searchParams.set('in_reply_to', inReplyTo);
    }
    return url.toString();
}

export interface ThreadPart {
    text: string;
    /** The id of this part once it is posted on X, so the next part can reply. */
    xId?: string;
}

/** One intent link per part. A reply is set only when the previous part has an id. */
export function threadIntents(parts: readonly ThreadPart[]) {
    return parts.map((part, index) => {
        const previous = index > 0 ? parts[index - 1]?.xId : undefined;
        return {
            text: part.text,
            url: intentUrl(part.text, previous),
        };
    });
}

/**
 * The same ranges and the same rules, as a script the planner page runs.
 * Tests compare it with `weightedLength`.
 */
export function weightProgram() {
    return `const SCALE=${SCALE};const SINGLE=${JSON.stringify(SINGLE)};const URL_LENGTH=${URL_LENGTH};
function single(code){return SINGLE.some(([a,b])=>code>=a&&code<=b)}
function urlAt(text,index){const rest=text.slice(index);const match=/^(?:https?:\\/\\/|www\\.)\\S+/i.exec(rest);if(!match)return;const trimmed=match[0].replace(${TRAILING.toString()},"");return trimmed.length?trimmed:undefined}
function weightedLength(text){let weight=0;for(let i=0;i<text.length;){const url=urlAt(text,i);if(url){weight+=URL_LENGTH*SCALE;i+=url.length;continue}const code=text.codePointAt(i);weight+=single(code)?SCALE:SCALE*2;i+=code>0xffff?2:1}return weight/SCALE}
function overLimit(text){return weightedLength(text)>${X_POST_LIMIT}}`;
}
