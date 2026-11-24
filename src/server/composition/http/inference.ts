/** Inference backends at the HTTP edge. */
import { Context } from 'effect';
import type { Hono } from 'hono';

import type { AppEnv } from '@socio/foundation/http/app-env';

import { inferenceRoutes as inferenceApiRoutes } from '../../inference/routes.js';
import type { AppEdge } from '../../main.js';
import { LegacyWorkspace } from '../base.js';
import { LegacyInference } from '../inference.js';

export function mountInferenceRoutes(app: Hono<AppEnv>, edge: AppEdge) {
    const { services } = edge;
    const workspace = Context.get(services, LegacyWorkspace);
    app.route(
        '/api',
        inferenceApiRoutes(Context.get(services, LegacyInference), (entry) => workspace.audit(entry)),
    );
}

/** Inference backends' step, as index.ts mounts it: their routes. */
export const inferenceRoutes = { routes: mountInferenceRoutes };
