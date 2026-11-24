import type { BundledPlugin } from '../bundle-types.js';

import { plannerData } from './data.js';
import { socialStrategyManifest } from './manifest.js';
import { contributePlanner } from './mcp.js';

export const socialStrategyBundle: BundledPlugin = {
    manifest: socialStrategyManifest,
    data: (ctx) => plannerData(ctx.db),
    contributeMcp: (server, ctx) => contributePlanner(server, ctx),
};
