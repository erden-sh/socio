import { reportFailure, safeFailure } from '@socio/foundation/observability/failures';

import { Flags } from '../flags/contract.js';
import type { ServerModule } from '../modules/contract.js';
import { Runner } from '../turns/contract.js';
import { Conversations, Socios } from '../workspace/contract.js';

import { learningRoutes } from './learning-routes.js';
import { learningSchema } from './migrations.js';
import { LearningJob } from './tags.js';

/**
 * Learning: review routes, the daily analysis tick and run cancellation.
 *
 * Its hooks read the analysis `LegacyLearning` holds (`LearningJob`,
 * `tags.ts`), and its routes the flags, the runner and the workspace's
 * conversations and socios by the contracts' tags, from the app's services
 * at the moment of use.
 */
export const learningModule: ServerModule = {
    ...learningSchema,
    // The analysis (`LearningJob`), the flags, the runner, and the chats and
    // socios the routes name, from the app's services.
    routes: ({ services }) => {
        const conversations = services.get(Conversations);
        const socios = services.get(Socios);
        return learningRoutes({
            learning: services.get(LearningJob),
            flags: services.get(Flags),
            runner: services.get(Runner),
            workspace: {
                thread: (id) => conversations.thread(id),
                dots: () => socios.dots(),
                dot: (id) => socios.dot(id),
                updateDot: (...args) => socios.updateDot(...args),
            },
        });
    },
    succeed: ({ services }) => services.get(LearningJob).recoverInterrupted(),
    // Daily analysis after 02:00, including catch-up after downtime. Beside
    // it, never holding it up, Learning's triage on the classification seam
    // (CB-200), which does nothing while its use is off.
    tick: {
        everyMs: 60_000,
        run: ({ services }) => {
            const learning = services.get(LearningJob);
            void learning
                .triageTick()
                .catch((error: unknown) => reportFailure('Learning triage', [safeFailure(error)]));
            return learning.tick();
        },
    },
    stop: ({ services }) => services.get(LearningJob).stop(),
};
