import type { Message } from '@ag-ui/core';

import { requestMessages } from '@socio/shared/chat/chat-history';

type RequestBuilder = (this: unknown, input: unknown) => RequestInit;

/**
 * Makes `agent`'s requests (its runs and connects) carry only the messages
 * the server doesn't have yet (CB-156, `requestMessages`): the runner
 * rebuilds the rest from storage. The agent keeps every message it shows.
 * Like the replay cursor, this goes through AG-UI's `requestInit`; for an
 * agent without the hook nothing changes. Returns the undo.
 */
export function sendNewMessagesOnly(agent: object): () => void {
    const target = agent as { requestInit?: RequestBuilder };
    const base = target.requestInit;
    if (typeof base !== 'function') {
        return () => {};
    }
    const own = Object.prototype.hasOwnProperty.call(target, 'requestInit');
    target.requestInit = function (this: unknown, input: unknown) {
        const messages = (input as { messages?: unknown } | undefined)?.messages;
        return base.call(
            this,
            Array.isArray(messages)
                ? {
                      ...(input as object),
                      messages: requestMessages(messages as Message[]),
                  }
                : input,
        );
    };
    return () => {
        if (own) {
            target.requestInit = base;
        } else {
            delete target.requestInit;
        }
    };
}
