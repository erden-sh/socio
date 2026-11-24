import { HISTORY_AFTER_HEADER } from '@socio/shared/chat/chat-history';

type RequestBuilder = (this: unknown, input: unknown) => RequestInit;

/**
 * Makes `agent`'s connection ask the server to replay only the runs after
 * `after()` (CB-136): the chat shows the earlier ones from its store.
 * CopilotKit's runtime agent builds each request with AG-UI's
 * `requestInit`, the HttpAgent's documented hook; this adds the header
 * there. While `after()` is undefined, or for an agent without the hook,
 * nothing changes: the whole conversation replays, as before. Returns the
 * undo.
 */
export function sendReplayCursor(agent: object, after: () => number | undefined): () => void {
    const target = agent as { requestInit?: RequestBuilder };
    const base = target.requestInit;
    if (typeof base !== 'function') {
        return () => {};
    }
    const own = Object.prototype.hasOwnProperty.call(target, 'requestInit');
    target.requestInit = function (this: unknown, input: unknown) {
        const init = base.call(this, input);
        const seq = after();
        return seq === undefined
            ? init
            : {
                  ...init,
                  headers: {
                      ...(init.headers as Record<string, string> | undefined),
                      [HISTORY_AFTER_HEADER]: String(seq),
                  },
              };
    };
    return () => {
        if (own) {
            target.requestInit = base;
        } else {
            delete target.requestInit;
        }
    };
}
