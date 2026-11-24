import { PlatformError } from './platform.js';

/** One stack env entry, as Portainer keeps it. */
export interface StackEnvEntry {
    name: string;
    value: string;
}

export interface PortainerStack {
    id: number;
    name: string;
    endpointId: number;
    env: StackEnvEntry[];
}

/** Portainer refused or didn't answer: the `portainer` adapter's platform error. */
export class PortainerError extends PlatformError {
    constructor(message: string, status?: number) {
        super(message, status);
        this.name = 'PortainerError';
    }
}

export interface PortainerSettings {
    url: string;
    token: string;
    endpointId: number;
    timeoutMs: number;
}

/**
 * The few Portainer calls the updater makes (CB-259): find the stack, read
 * its file and env, update it with a file and env, and look an image up on
 * the node (read-only). Everything goes through the stack API; it never
 * touches services or containers directly. Errors name the call and the
 * status, never the API key or env values.
 */
export class PortainerClient {
    constructor(
        private settings: PortainerSettings,
        private transport: typeof fetch = fetch,
    ) {}

    private async call(
        path: string,
        init: { method?: string; json?: unknown } = {},
    ): Promise<{ status: number; body: unknown }> {
        let response: Response;
        try {
            response = await this.transport(`${this.settings.url}/api${path}`, {
                method: init.method ?? 'GET',
                headers: {
                    'X-API-Key': this.settings.token,
                    Accept: 'application/json',
                    ...(init.json !== undefined ? { 'Content-Type': 'application/json' } : {}),
                },
                body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
                redirect: 'error',
                signal: AbortSignal.timeout(this.settings.timeoutMs),
            });
        } catch (error) {
            const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
            throw new PortainerError(
                timedOut
                    ? `Portainer did not answer ${init.method ?? 'GET'} ${path.split('?')[0]} in time.`
                    : 'Portainer is unreachable.',
            );
        }
        const text = await response.text().catch(() => '');
        let body: unknown;
        try {
            body = text ? JSON.parse(text) : null;
        } catch {
            body = null;
        }
        return { status: response.status, body };
    }

    private fail(what: string, status: number, body: unknown): never {
        const detail =
            body && typeof body === 'object'
                ? [(body as { message?: unknown }).message, (body as { details?: unknown }).details]
                      .filter((part) => typeof part === 'string' && part)
                      .join(': ')
                : '';
        throw new PortainerError(
            `Portainer refused to ${what} (${status}${detail ? `: ${String(detail).replace(/\s+/g, ' ').slice(0, 300)}` : ''}).`,
            status,
        );
    }

    /** The stack named `name` on the endpoint. */
    async findStack(name: string): Promise<PortainerStack> {
        const { status, body } = await this.call('/stacks');
        if (status !== 200 || !Array.isArray(body)) {
            this.fail('list the stacks', status, body);
        }
        const found = (body as Record<string, unknown>[]).filter(
            (stack) => stack.Name === name && Number(stack.EndpointId) === this.settings.endpointId,
        );
        if (found.length !== 1) {
            throw new PortainerError(
                found.length
                    ? `Portainer has ${found.length} stacks named ${name} on endpoint ${this.settings.endpointId}.`
                    : `Portainer has no stack named ${name} on endpoint ${this.settings.endpointId}.`,
            );
        }
        return this.stack(Number(found[0]!.Id));
    }

    /** One stack, with its env exactly as Portainer has it. */
    async stack(id: number): Promise<PortainerStack> {
        const { status, body } = await this.call(`/stacks/${id}`);
        if (status !== 200 || !body || typeof body !== 'object') {
            this.fail('read the stack', status, body);
        }
        const raw = body as Record<string, unknown>;
        const env = Array.isArray(raw.Env) ? raw.Env : [];
        if (
            env.some(
                (entry) =>
                    !entry ||
                    typeof (entry as StackEnvEntry).name !== 'string' ||
                    typeof (entry as StackEnvEntry).value !== 'string',
            )
        ) {
            throw new PortainerError('The stack’s env is not a list of names and values.');
        }
        return {
            id: Number(raw.Id),
            name: String(raw.Name),
            endpointId: Number(raw.EndpointId),
            env: (env as StackEnvEntry[]).map(({ name, value }) => ({ name, value })),
        };
    }

    /** The stack's compose file, byte for byte. */
    async stackFile(id: number): Promise<string> {
        const { status, body } = await this.call(`/stacks/${id}/file`);
        const content =
            body && typeof body === 'object' ? (body as { StackFileContent?: unknown }).StackFileContent : undefined;
        if (status !== 200 || typeof content !== 'string') {
            this.fail('read the stack file', status, body);
        }
        return content as string;
    }

    /**
     * Updates the stack with this file and env (every key: Portainer drops
     * the ones left out). Never prunes services.
     */
    async updateStack(id: number, update: { file: string; env: StackEnvEntry[]; pullImage: boolean }) {
        const { status, body } = await this.call(`/stacks/${id}?endpointId=${this.settings.endpointId}`, {
            method: 'PUT',
            json: {
                stackFileContent: update.file,
                env: update.env,
                prune: false,
                pullImage: update.pullImage,
            },
        });
        if (status !== 200) {
            this.fail('update the stack', status, body);
        }
    }

    /** Whether the image is on the endpoint's node (read-only). */
    async imageExists(reference: string): Promise<boolean> {
        const { status, body } = await this.call(
            `/endpoints/${this.settings.endpointId}/docker/images/${encodeURIComponent(reference)}/json`,
        );
        if (status === 200) {
            return true;
        }
        if (status === 404) {
            return false;
        }
        this.fail(`look up the image ${reference}`, status, body);
    }
}
