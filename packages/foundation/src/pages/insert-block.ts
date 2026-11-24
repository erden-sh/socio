/**
 * Where a block goes in a page's Markdown (moved from
 * `src/server/pages/page-tools.ts`, which re-exports it): the dataset view
 * tool and link unfurling both use it.
 */
import { PageError } from './page-error.js';

/**
 * Where a view block goes in a page's Markdown: after the first heading
 * whose text is `afterHeading` (case-insensitive), else at the end.
 */
export function insertBlock(content: string, block: string, afterHeading?: string) {
    const lines = content.split('\n');
    const wanted = afterHeading?.trim().toLowerCase();
    const at = wanted
        ? lines.findIndex(
              (line) =>
                  /^#{1,6}\s/.test(line) &&
                  line
                      .replace(/^#+\s*/, '')
                      .trim()
                      .toLowerCase() === wanted,
          )
        : -1;
    if (wanted && at < 0) {
        throw new PageError(`No heading "${afterHeading}" in this page.`, 400);
    }
    if (at < 0) {
        return `${content.replace(/\s+$/, '')}${content.trim() ? '\n\n' : ''}${block}\n`;
    }
    const before = lines.slice(0, at + 1).join('\n');
    const after = lines
        .slice(at + 1)
        .join('\n')
        .replace(/^\s+/, '');
    return `${before}\n\n${block}\n${after ? `\n${after}` : ''}`;
}
