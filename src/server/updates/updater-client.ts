import type { UpdaterApplyRequest, UpdaterJob, UpdaterStatus } from '@socio/shared/updates/updates';

import type { UpdaterEndpoint } from './contract.js';

export class UpdaterError extends Error {
    constructor(
        message: string,
        /** The updater's HTTP status; undefined when it didn't answer. */
        readonly status?: number,
    ) {
        super(message);
        this.name = 'UpdaterError';
    }
}

/**
 * The app's side of the internal channel to the updater sidecar (CB-259):
 * a bearer token both hold (`UPDATER_TOKEN`), over the stack's internal
 * network. No redirects, short timeouts, capped answers.
 */
export class UpdaterClient {
    constructor(
        private endpoint: UpdaterEndpoint,
        private transport: typeof fetch = fetch,
        private timeoutMs = 10_000,
    ) {}

    private async call<T>(path: string, init: { method?: string; json?: unknown } = {}) {
        let response: Response;
        try {
            response = await this.transport(`${this.endpoint.url}${path}`, {
                method: init.method ?? 'GET',
                headers: {
                    Authorization: `Bearer ${this.endpoint.token}`,
                    Accept: 'application/json',
                    ...(init.json !== undefined ? { 'Content-Type': 'application/json' } : {}),
                },
                body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
                redirect: 'error',
                signal: AbortSignal.timeout(this.timeoutMs),
            });
        } catch {
            throw new UpdaterError('The updater is unreachable.');
        }
        const text = (await response.text().catch(() => '')).slice(0, 1_000_000);
        let body: unknown;
        try {
            body = text ? JSON.parse(text) : null;
        } catch {
            body = null;
        }
        if (!response.ok) {
            const message =
                body && typeof body === 'object' && 'error' in body
                    ? String((body as { error: unknown }).error).slice(0, 500)
                    : `HTTP ${response.status}`;
            throw new UpdaterError(
                response.status === 401
                    ? 'The updater refused the app’s token: UPDATER_TOKEN differs between them.'
                    : message,
                response.status,
            );
        }
        return body as T;
    }

    status() {
        return this.call<UpdaterStatus>('/v1/status');
    }

    apply(request: UpdaterApplyRequest) {
        return this.call<{ job: UpdaterJob }>('/v1/apply', {
            method: 'POST',
            json: request,
        });
    }
}
