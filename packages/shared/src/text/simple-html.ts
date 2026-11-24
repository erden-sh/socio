/**
 * Page text is Markdown, but a socio sometimes writes simple HTML into it
 * (CB-201: a quoted post wrapped in <blockquote>). This turns the few tags
 * that are safe and lossless into Markdown, so the page shows a quotation
 * and the rich editor can open it. Nothing else is let through: it is a
 * string rewrite, not an HTML parser, and a tag with any attribute, or any
 * other tag (script, iframe, style, a, img…), is left exactly as written.
 * The Markdown renderers still treat that as unsupported or as plain text.
 *
 * Handled: <blockquote>…</blockquote> (nested too) and <br>. Fenced code
 * and `inline code` are never touched. Unbalanced tags are left alone.
 */
const MASK = /(^|\n)([ \t]*)(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n[ \t]*\3[`~]*[ \t]*(?=\n|$)|$)|`+[^`\n]*`+/g;
const TAG = /<(\/?)(blockquote|br)[ \t]*(\/?)>/gi;
const SLOT = /(\d+)/g;

/** True when the text holds a tag this module would convert. */
export const hasSimpleHtml = (source: string) => /<(?:\/?blockquote|br)[ \t]*\/?>/i.test(source);

const quote = (inner: string) =>
    inner
        .replace(/\n{3,}/g, '\n\n')
        .replace(/^\s*\n|\s+$/g, '')
        .split('\n')
        .map((line) => (line.trim() ? `> ${line}` : '>'))
        .join('\n');

/** Converts balanced blockquotes inside one span of text, innermost first. */
function convert(text: string, saved: string[]): string {
    const tags = [...text.matchAll(TAG)];
    const stack: { inner: string }[] = [];
    let out = '';
    let cursor = 0;
    const flush = (to: number) => {
        const target = stack.length ? stack[stack.length - 1] : null;
        const piece = text.slice(cursor, to);
        if (target) {
            target.inner += piece;
        } else {
            out += piece;
        }
        cursor = to;
    };
    for (const tag of tags) {
        const at = tag.index;
        const name = tag[2].toLowerCase();
        if (name === 'br') {
            if (tag[1]) {
                continue;
            }
            flush(at);
            const br = '\\\n';
            if (stack.length) {
                stack[stack.length - 1].inner += br;
            } else {
                out += br;
            }
            cursor = at + tag[0].length;
            continue;
        }
        if (tag[3] && !tag[1]) {
            continue;
        } // <blockquote/> is not an open tag
        if (!tag[1]) {
            flush(at);
            cursor = at + tag[0].length;
            stack.push({ inner: '' });
            continue;
        }
        if (!stack.length) {
            continue;
        } // a stray close tag stays as written
        flush(at);
        cursor = at + tag[0].length;
        const done = stack.pop()!;
        // A fenced block inside a quote would lose its "> " prefixes: leave the
        // whole document as written rather than guess.
        for (const slot of done.inner.matchAll(SLOT)) {
            if (saved[Number(slot[1])].includes('\n')) {
                return text;
            }
        }
        const block = `\n\n${quote(done.inner)}\n\n`;
        if (stack.length) {
            stack[stack.length - 1].inner += block;
        } else {
            out += block;
        }
    }
    // An unclosed blockquote is not converted: restore it as written.
    if (stack.length) {
        return text;
    }
    out += text.slice(cursor);
    return out;
}

export function simpleHtmlToMarkdown(source: string): string {
    if (!hasSimpleHtml(source)) {
        return source;
    }
    const saved: string[] = [];
    const masked = source.replace(MASK, (match) => {
        saved.push(match);
        return `${saved.length - 1}`;
    });
    const converted = convert(masked, saved);
    if (converted === masked) {
        return source;
    }
    return converted
        .replace(/\n{3,}/g, '\n\n')
        .replace(/^\n+/, '')
        .replace(/\n+$/, source.endsWith('\n') ? '\n' : '')
        .replace(SLOT, (_, index) => saved[Number(index)]);
}
