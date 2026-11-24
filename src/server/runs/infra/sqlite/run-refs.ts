import { runRefRecorder } from '@socio/foundation/runs/run-refs';

import type { RunRefsShape } from '../../contract.js';

/** `runRefRecorder` as the `RunRefs` tag's shape (`runs/contract.ts`), for the composition root. */
export const sqliteRunRefs: RunRefsShape = {
    recorder: (db, runId, threadId) => runRefRecorder(db, runId, threadId),
};
