import { upstreamIssueLink } from '@socio/shared/updates/upstream';

/** The parts of a Markdown tree (mdast) the plugin reads and writes. */
interface MdNode {
    type: string;
    value?: string;
    url?: string;
    children?: MdNode[];
    data?: { hProperties?: Record<string, string> };
}

export interface IssueKeyOptions {
    /**
     * Also "#123" (CB-274), as an issue's text writes it. Not in headings
     * ("## #1 goal"), nor after a letter, digit or URL mark ("page#12",
     * "/#12", "&#12;"), nor before one ("#12ab"); no number starts with 0,
     * so "#000" and the like stay too.
     */
    hash?: boolean;
    /**
     * Mark each reference for an issue chip (`data-issue-ref`, its number)
     * instead of a plain link: the renderer shows the chip once the issue is
     * read, and the words as they were when the reader can't have it.
     */
    chips?: boolean;
    /**
     * The keys are Socio's own (the release notes, CB-381): each links to
     * the upstream board, `https://brain.ingenioventures.com/issues/CB-157`,
     * unless `origin` is that instance, where it stays `/issues/CB-157`.
     */
    upstream?: boolean;
    /** This app's origin, for `upstream`; `location.origin` otherwise. */
    origin?: string;
}

const ISSUE_KEY = /\bCB-([1-9]\d{0,8})\b/g;
const ISSUE_KEY_OR_HASH = /\bCB-([1-9]\d{0,8})\b|(?<![\p{L}\p{N}_&#/=?:.@\\-])#([1-9]\d{0,8})(?![\p{L}\p{N}_]|\.\d)/gu;
/** Text that is a link or code already stays as it is. */
const KEEP = new Set(['link', 'linkReference', 'definition', 'inlineCode', 'code', 'html']);

function linkKeys(node: MdNode, options: IssueKeyOptions, heading = false) {
    if (!node.children || KEEP.has(node.type)) {
        return;
    }
    const inHeading = heading || node.type === 'heading';
    const pattern = options.hash && !inHeading ? ISSUE_KEY_OR_HASH : ISSUE_KEY;
    node.children = node.children.flatMap((child) => {
        if (child.type !== 'text' || !child.value) {
            linkKeys(child, options, inHeading);
            return [child];
        }
        const text = child.value;
        const parts: MdNode[] = [];
        let last = 0;
        for (const match of text.matchAll(pattern)) {
            const number = match[1] ?? match[2]!;
            if (match.index > last) {
                parts.push({ type: 'text', value: text.slice(last, match.index) });
            }
            parts.push({
                type: 'link',
                url: options.upstream
                    ? upstreamIssueLink(`CB-${number}`, options.origin ?? globalThis.location?.origin)!.href
                    : `/issues/CB-${number}`,
                children: [{ type: 'text', value: match[0] }],
                ...(options.chips ? { data: { hProperties: { dataIssueRef: number } } } : {}),
            });
            last = match.index + match[0].length;
        }
        if (!parts.length) {
            return [child];
        }
        if (last < text.length) {
            parts.push({ type: 'text', value: text.slice(last) });
        }
        return parts;
    });
}

/**
 * A remark plugin: each issue key in the text ("CB-157") becomes a link to
 * its issue, `/issues/CB-157`; with `upstream`, on Socio's own board (the
 * release notes, CB-168, CB-381). With `hash`,
 * "#157" does too; with `chips`, each is marked for an issue chip (an
 * issue's description and comments, CB-274). Code, links and raw HTML
 * keep their text.
 */
export const remarkIssueKeys =
    (options: IssueKeyOptions = {}) =>
    (tree: MdNode) => {
        linkKeys(tree, options);
    };
