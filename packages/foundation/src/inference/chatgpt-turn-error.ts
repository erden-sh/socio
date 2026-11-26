import { EventType } from '@ag-ui/core';

import { errorDetailFields } from '@socio/shared/runs/socio-fields';

import { failureDetail } from '../observability/failures.js';

import { ChatGptError, chatGptFailure } from './chatgpt-errors.js';

/**
 * The RUN_ERROR for a turn that failed on the user's own ChatGPT plan
 * (usage limit, sign-in ended, plan without Codex, …): the module's
 * friendly message and its `chatgpt_*` code, the same in the app and in
 * Telegram. Undefined for any other failure. Moved from the server's
 * `inference/chatgpt/turn-error.ts`.
 */
export function connectionTurnError(error: unknown) {
    const known = chatGptFailure(error);
    if (!known) {
        return undefined;
    }
    return {
        type: EventType.RUN_ERROR as const,
        message: known.message,
        code: known.code,
        ...errorDetailFields(error instanceof ChatGptError ? error.detail : failureDetail(error)),
    };
}
