// The pages as Markdown, for /llms-full.txt: a small converter for the site's own markup only
// (headings, paragraphs, lists, tables, links, the FAQ's <details>). Decorative parts (the drawn
// app, icons, images, forms) are left out.

const decode = (text: string) =>
    text
        .replace(/&nbsp;/g, ' ')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&');

/** Inline markup to Markdown: links, bold, code; any other tag dropped. */
function inline(html: string): string {
    return decode(
        html
            .replace(/<svg[\s\S]*?<\/svg>/g, '')
            .replace(/<img[^>]*>/g, '')
            .replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g, (_, href: string, text: string) => {
                const label = inline(text).trim();
                const url = href.startsWith('/') ? `https://socio.sh${href}` : href;
                return label ? `[${label}](${url})` : '';
            })
            .replace(/<(b|strong)>([\s\S]*?)<\/\1>/g, '**$2**')
            .replace(/<code>([\s\S]*?)<\/code>/g, '`$1`')
            .replace(/<br\s*\/?>/g, '\n')
            .replace(/<[^>]+>/g, ''),
    )
        .replace(/[ \t]+/g, ' ')
        .replace(/ *\n */g, '\n')
        .trim();
}

/** The <main> of a built page, as Markdown. */
export function pageMarkdown(html: string): string {
    let main = /<main[^>]*>([\s\S]*?)<\/main>/.exec(html)?.[1] ?? '';
    main = main
        .replace(/<form[\s\S]*?<\/form>/g, '')
        .replace(/<div class="hero-visual"[\s\S]*?<\/section>/, '</section>')
        .replace(/<div class="phones">[\s\S]*?<\/section>/, '</section>')
        .replace(/<aside class="toc">[\s\S]*?<\/aside>/g, '')
        .replace(/<div class="codebox[\s\S]*?<\/div>\s*<\/div>/g, '')
        .replace(/<svg[\s\S]*?<\/svg>/g, '')
        .replace(/<div class="callout[^"]*">([\s\S]*?)<\/div>/g, '<p>$1</p>');
    const out: string[] = [];
    const block =
        /<(h[1-5])[^>]*>([\s\S]*?)<\/\1>|<summary[^>]*>([\s\S]*?)<\/summary>|<li[^>]*>([\s\S]*?)<\/li>|<tr>([\s\S]*?)<\/tr>|<p[^>]*>([\s\S]*?)<\/p>/g;
    for (const match of main.matchAll(block)) {
        const [, tag, heading, summary, item, row, para] = match;
        if (tag && heading !== undefined) {
            const level = Math.min(Number(tag[1]), 4);
            const text = inline(heading);
            if (text) {
                out.push(`${'#'.repeat(level)} ${text}`);
            }
        } else if (summary !== undefined) {
            out.push(`**${inline(summary)}**`);
        } else if (item !== undefined) {
            const text = inline(item);
            if (text) {
                out.push(`- ${text.replace(/\n/g, ' ')}`);
            }
        } else if (row !== undefined) {
            const cells = [...row.matchAll(/<t[hd]>([\s\S]*?)<\/t[hd]>/g)].map((cell) => inline(cell[1] ?? ''));
            out.push(`| ${cells.join(' | ')} |`);
            if (row.includes('<th>')) {
                out.push(`|${cells.map(() => ' --- |').join('')}`);
            }
        } else if (para !== undefined) {
            const text = inline(para);
            if (text) {
                out.push(text);
            }
        }
    }
    // A blank line between blocks, except inside a list or a table.
    return out
        .map((line, i) => {
            const prev = out[i - 1] ?? '';
            const together =
                (line.startsWith('- ') && prev.startsWith('- ')) || (line.startsWith('|') && prev.startsWith('|'));
            return i === 0 || together ? line : `\n${line}`;
        })
        .join('\n')
        .trim();
}
