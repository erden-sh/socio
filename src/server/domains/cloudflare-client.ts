import { DomainsError, type DomainsSettings } from './contract.js';
import { failure, requestJson, type Redactor } from './http.js';

export interface CloudflareRecord {
    id: string;
    type: string;
    name: string;
    content: string;
    proxied?: boolean;
    ttl?: number;
    comment?: string | null;
}

/**
 * Marks the records this module created (Cloudflare's record comment). It
 * keeps the app's old name: records already made carry it.
 */
export const RECORD_COMMENT = 'Managed by Socio (domains)';

interface Envelope<T> {
    success?: boolean;
    errors?: { code?: number; message?: string }[];
    result?: T;
}

/**
 * Cloudflare's DNS API for one zone, with a token scoped to Zone → DNS →
 * Edit on it. A records only, never proxied, TTL automatic (1). Nothing
 * about the user goes in: names, addresses and a fixed comment.
 */
export class CloudflareClient {
    private zoneId?: string;
    constructor(
        private settings: DomainsSettings['cloudflare'],
        private zone: string,
        private redactor: Redactor,
        private transport: typeof fetch = fetch,
    ) {
        redactor.add(settings.token);
        this.zoneId = settings.zoneId;
    }

    private async call<T>(path: string, init: { method?: string; json?: unknown } = {}): Promise<T> {
        const response = await requestJson('cloudflare', this.transport, `${this.settings.url}${path}`, {
            ...init,
            headers: { Authorization: `Bearer ${this.settings.token}` },
            timeoutMs: this.settings.timeoutMs,
        });
        const body = (response.body ?? {}) as Envelope<T>;
        if (!response.ok || body.success === false) {
            const message = body.errors
                ?.map((error) => error.message)
                .filter(Boolean)
                .join('; ');
            throw failure('cloudflare', response.status, message, this.redactor);
        }
        return body.result as T;
    }

    /** The zone's id: CLOUDFLARE_ZONE_ID, or looked up by name once. */
    async zoneIdOf() {
        if (this.zoneId) {
            return this.zoneId;
        }
        const zones = await this.call<{ id: string; name: string }[]>(`/zones?name=${encodeURIComponent(this.zone)}`);
        const zone = zones?.find((entry) => entry.name === this.zone);
        if (!zone) {
            throw new DomainsError(
                'not_configured',
                `Cloudflare has no zone ${this.zone} for this token (or the token can't list it; set CLOUDFLARE_ZONE_ID).`,
                'cloudflare',
            );
        }
        this.zoneId = zone.id;
        return zone.id;
    }

    /** Every record of any type with exactly this name. */
    async records(name: string) {
        const zone = await this.zoneIdOf();
        return (
            (await this.call<CloudflareRecord[]>(
                `/zones/${zone}/dns_records?name=${encodeURIComponent(name)}&per_page=100`,
            )) ?? []
        );
    }

    async createA(name: string, content: string) {
        const zone = await this.zoneIdOf();
        return this.call<CloudflareRecord>(`/zones/${zone}/dns_records`, {
            method: 'POST',
            json: {
                type: 'A',
                name,
                content,
                ttl: 1,
                proxied: false,
                comment: RECORD_COMMENT,
            },
        });
    }

    async updateA(id: string, name: string, content: string) {
        const zone = await this.zoneIdOf();
        return this.call<CloudflareRecord>(`/zones/${zone}/dns_records/${encodeURIComponent(id)}`, {
            method: 'PATCH',
            json: {
                type: 'A',
                name,
                content,
                ttl: 1,
                proxied: false,
                comment: RECORD_COMMENT,
            },
        });
    }

    async delete(id: string) {
        const zone = await this.zoneIdOf();
        await this.call(`/zones/${zone}/dns_records/${encodeURIComponent(id)}`, {
            method: 'DELETE',
        });
    }
}
