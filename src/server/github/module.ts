import { MODULE_IDS } from '@socio/shared/modules';

import type { ServerModule } from '../modules/contract.js';

import { GitHubAdmin, GitHubConfig } from './contract.js';
import { githubRoutes } from './routes.js';

/**
 * The GitHub App (CB-32, CB-325): the service lives on the platform
 * (`platform.github`), which the coding gateway's Git proxy and pull
 * requests use; the module owns its admin-only routes under `/api/github`.
 * Its rows still live in dispatch's old key-value table (`infra/store.ts`), so
 * it has no migrations of its own yet.
 *
 * Its routes read the service as `GitHubAdmin` (`contract.ts`), and the
 * app's origin and GitHub's reach from `GitHubConfig`, from the app's
 * services when the routes are built.
 */
export const githubModule: ServerModule = {
    id: MODULE_IDS.github,
    access: 'admin',
    routes: ({ services }) => {
        const { appOrigin, access } = services.get(GitHubConfig);
        return githubRoutes({ github: services.get(GitHubAdmin), config: { appOrigin, githubAccess: access } });
    },
};
