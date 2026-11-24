/** Voice at the HTTP edge: its service, and live dictation's socket. */
import { Context } from 'effect';
import type { Hono } from 'hono';

import type { AppEnv } from '@socio/foundation/http/app-env';

import type { AppEdge } from '../../main.js';
import { dictationUpgrade } from '../../voice/dictation-stream.js';
import { LegacyVoice } from '../voice.js';

/**
 * Calls and dictation, for the workspace routes and Settings: the one the
 * graph made (`voiceLayers.voice`), from the app's services; none without
 * them.
 */
export function voiceService(edge: AppEdge | undefined) {
    return edge && Context.get(edge.services, LegacyVoice);
}

/** Live dictation's socket (CB-222), through the app's own checks. */
export function dictationSockets(app: Hono<AppEnv>) {
    return dictationUpgrade((request, env) => app.fetch(request, env));
}

/** Voice's steps, as index.ts uses them: its service and live dictation's socket. */
export const voiceRoutes = { service: voiceService, dictationSockets };
