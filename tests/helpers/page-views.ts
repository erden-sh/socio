// The views the pages answer with (`PageViews`, web/services.ts), for tests
// and benches that build a `Platform` without the app's runtime: each
// feature's own views module over the platform's members, as its tag
// offers them in the server's graph (composition/http/web.ts reads the
// tags there). With no platform, only what the pages read signed out or
// without one: the sign-in screen, the build's releases and the state view.
import { approvalsViews } from '../../src/server/approvals/views.js';
import { signInView } from '../../src/server/auth/sign-in-view.js';
import { viewSourcesOf } from '../../src/server/composition/workspace.js';
import { dataspaceViews } from '../../src/server/dataspace/data-views.js';
import { operatorInferenceView } from '../../src/server/inference/views.js';
import { issuesViews } from '../../src/server/issues/views.js';
import { learningViews } from '../../src/server/learning/views.js';
import { stateView } from '../../src/server/live/views/state.js';
import { mediaViews } from '../../src/server/media/view.js';
import { memoriesViews } from '../../src/server/memory/routes.js';
import { pagesViews } from '../../src/server/pages/views.js';
import { roomReads } from '../../src/server/rooms/read-state.js';
import { runsViews } from '../../src/server/runs/views.js';
import { ScheduleDetailViews } from '../../src/server/schedules/detail.js';
import { limitDefaults } from '../../src/server/settings/limits.js';
import { releases } from '../../src/server/updates/layer.js';
import type { PageViews } from '../../src/server/web/services.js';
import { workspaceViews } from '../../src/server/workspace/views.js';

import type { TestPlatform } from './test-platform.js';

/** What a page reads that no platform member backs: a test that needs it gets an error. */
const missing = (name: string) =>
    new Proxy(
        {},
        {
            get: () => {
                throw new Error(`No platform: the pages' ${name} views are not there.`);
            },
        },
    );

/**
 * The workspace's views over `platform`, as `WorkspaceViews` offers them
 * (composition/workspace.ts): the store's slices, the platform's members
 * and the rooms' read state.
 */
export function testWorkspaceViews(platform: TestPlatform) {
    const { workspace } = platform;
    return workspaceViews(
        workspace,
        viewSourcesOf(
            workspace,
            platform,
            () => roomReads(platform),
            () => platform.plugins,
        ),
    );
}

/** `PageViews` over `platform`'s members; signed-out ones only without it. */
export function testPageViews(platform?: TestPlatform): PageViews {
    const base = { auth: { signInView }, releases, state: { stateView } };
    if (!platform) {
        return {
            ...base,
            ...Object.fromEntries(
                (
                    [
                        'memories',
                        'limits',
                        'workspace',
                        'issues',
                        'pages',
                        'approvals',
                        'runs',
                        'media',
                        'data',
                        'schedules',
                        'learning',
                        'inference',
                    ] as const
                ).map((name) => [name, missing(name)]),
            ),
        } as PageViews;
    }
    const { workspace, learning } = platform;
    return {
        ...base,
        memories: memoriesViews(platform.store),
        limits: { defaults: () => limitDefaults(platform.config) },
        workspace: testWorkspaceViews(platform),
        issues: issuesViews(platform, workspace.counters),
        pages: pagesViews({ spaceAccess: workspace.spaceAccess, pages: workspace.pages, counters: workspace.counters }),
        approvals: approvalsViews(platform),
        runs: runsViews(platform),
        media: mediaViews(platform.media),
        data: dataspaceViews(platform.data),
        schedules: new ScheduleDetailViews(platform),
        learning: learningViews({ learning, evidence: learning.evidence, skills: learning.skills, socios: workspace }),
        inference: { operatorInferenceView },
    };
}
