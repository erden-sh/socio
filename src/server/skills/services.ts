/**
 * The implementation of skills' `UnfurlTools` tag (`contract.ts`): over the
 * `PageTools` tag (`unfurlToolsOver`, what `layer.ts` provides). Nothing
 * here changes how a tool is made: each method is today's builder with the
 * pages given.
 */
import type { UnfurlToolsShape } from './contract.js';
import { unfurlRecursiveTools, type UnfurlApprovals } from './unfurl-recursive.js';
import { unfurlTools, type UnfurlPages } from './unfurl-tool.js';

/**
 * The tag over the page tools (`PageTools`) the unfurl tools read and write
 * pages through, and the approvals a large recursive import asks through
 * (CB-492).
 */
export const unfurlToolsOver = (pages: UnfurlPages, approvals: UnfurlApprovals): UnfurlToolsShape => ({
    unfurlTools: (options) => unfurlTools({ ...options, pages }),
    unfurlRecursiveTools: (options) => unfurlRecursiveTools({ ...options, pages, approvals }),
});
