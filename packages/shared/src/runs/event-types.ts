import type { EventType } from '@ag-ui/core';

/**
 * AG-UI's event types as plain strings, for code that compares an
 * event's `type` and runs where `@ag-ui/core` may only be imported for its
 * types: this package, and the native app that bundles its source. The
 * `satisfies` below holds it to `EventType` key for key and value for
 * value, so a type added or renamed upstream fails `pnpm run check`.
 */
export const AG_UI_EVENT = {
    TEXT_MESSAGE_START: 'TEXT_MESSAGE_START',
    TEXT_MESSAGE_CONTENT: 'TEXT_MESSAGE_CONTENT',
    TEXT_MESSAGE_END: 'TEXT_MESSAGE_END',
    TEXT_MESSAGE_CHUNK: 'TEXT_MESSAGE_CHUNK',
    TOOL_CALL_START: 'TOOL_CALL_START',
    TOOL_CALL_ARGS: 'TOOL_CALL_ARGS',
    TOOL_CALL_END: 'TOOL_CALL_END',
    TOOL_CALL_CHUNK: 'TOOL_CALL_CHUNK',
    TOOL_CALL_RESULT: 'TOOL_CALL_RESULT',
    STATE_SNAPSHOT: 'STATE_SNAPSHOT',
    STATE_DELTA: 'STATE_DELTA',
    MESSAGES_SNAPSHOT: 'MESSAGES_SNAPSHOT',
    ACTIVITY_SNAPSHOT: 'ACTIVITY_SNAPSHOT',
    ACTIVITY_DELTA: 'ACTIVITY_DELTA',
    RAW: 'RAW',
    CUSTOM: 'CUSTOM',
    RUN_STARTED: 'RUN_STARTED',
    RUN_FINISHED: 'RUN_FINISHED',
    RUN_ERROR: 'RUN_ERROR',
    STEP_STARTED: 'STEP_STARTED',
    STEP_FINISHED: 'STEP_FINISHED',
    REASONING_START: 'REASONING_START',
    REASONING_MESSAGE_START: 'REASONING_MESSAGE_START',
    REASONING_MESSAGE_CONTENT: 'REASONING_MESSAGE_CONTENT',
    REASONING_MESSAGE_END: 'REASONING_MESSAGE_END',
    REASONING_MESSAGE_CHUNK: 'REASONING_MESSAGE_CHUNK',
    REASONING_END: 'REASONING_END',
    REASONING_ENCRYPTED_VALUE: 'REASONING_ENCRYPTED_VALUE',
    SUBAGENT_STARTED: 'SUBAGENT_STARTED',
    SUBAGENT_FINISHED: 'SUBAGENT_FINISHED',
    SUBAGENT_ERROR: 'SUBAGENT_ERROR',
} as const satisfies { readonly [K in keyof typeof EventType]: `${(typeof EventType)[K]}` };

/** One AG-UI event type, as its string. */
export type AgUiEventType = (typeof AG_UI_EVENT)[keyof typeof AG_UI_EVENT];

/**
 * The reasoning events' names before AG-UI 1.0 renamed them REASONING_*.
 * Nothing sends them any more, but runs stored before the upgrade may hold
 * them, so every reader of stored events keeps matching these too.
 */
export const LEGACY_THINKING_EVENT = {
    THINKING_START: 'THINKING_START',
    THINKING_END: 'THINKING_END',
    THINKING_TEXT_MESSAGE_START: 'THINKING_TEXT_MESSAGE_START',
    THINKING_TEXT_MESSAGE_CONTENT: 'THINKING_TEXT_MESSAGE_CONTENT',
    THINKING_TEXT_MESSAGE_END: 'THINKING_TEXT_MESSAGE_END',
} as const;
