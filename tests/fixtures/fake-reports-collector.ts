/**
 * The reports collector in memory (protocol §4), in front of a fake issuer:
 * one `fetch` for both. It accepts only a token the issuer issued for its
 * own origin, keeps each report it stores by id (a repeat answers 200), and
 * answers what a test queues instead (`answers`).
 */
import type { FakeIssuer } from './fake-cloud-issuer.js';

export const REPORTS = 'https://reports.socio.test';

/** A queued answer: a status, with headers, or a network error. */
export type CollectorAnswer = number | { status: number; headers?: Record<string, string> } | 'network';

export interface FakeCollector {
    /** The issuer's and the collector's transport. */
    fetch: typeof fetch;
    /** Every POST to the collector, in order: its body as sent and its token. */
    posts: Array<{ body: Record<string, unknown>; raw: string; token: string; headers: Record<string, string> }>;
    /** Reports stored, by id. */
    stored: Map<string, Record<string, unknown>>;
    /** Answers for the next POSTs, in order, before anything is checked. */
    answers: CollectorAnswer[];
    /** Called before a POST is answered: a test holds one in flight here. */
    before?: () => Promise<void> | void;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

export function fakeCollector(issuer: FakeIssuer): FakeCollector {
    const collector: FakeCollector = {
        posts: [],
        stored: new Map(),
        answers: [],
        fetch: async (input, init) => {
            const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
            if (url.origin !== REPORTS) {
                return issuer.fetch(input, init);
            }
            const headers: Record<string, string> = {};
            new Headers(init?.headers).forEach((value, name) => (headers[name] = value));
            const raw = typeof init?.body === 'string' ? init.body : '';
            const token = headers.authorization?.replace(/^Bearer /, '') ?? '';
            collector.posts.push({ body: JSON.parse(raw) as Record<string, unknown>, raw, token, headers });
            await collector.before?.();
            const answer = collector.answers.shift();
            if (answer === 'network') {
                throw new TypeError('fetch failed');
            }
            if (answer !== undefined) {
                const { status, headers: extra } = typeof answer === 'number' ? { status: answer } : answer;
                return json(status, { error: 'queued answer' }, extra);
            }
            if (url.pathname !== '/v1/reports' || init?.method !== 'POST') {
                return json(404, {});
            }
            const issued = issuer.issued.find((entry) => entry.token === token);
            const client = issued && issuer.clients.get(issued.clientId);
            if (!issued || issued.audience !== REPORTS || client?.status !== 'active') {
                return json(401, { error: 'invalid_token' });
            }
            if (!client.scopes.split(' ').includes('reports:write')) {
                return json(403, { error: 'insufficient_scope' });
            }
            const body = JSON.parse(raw) as Record<string, unknown>;
            const id = String(body.id);
            if (collector.stored.has(id)) {
                return json(200, { id });
            }
            collector.stored.set(id, body);
            return json(201, { id });
        },
    };
    return collector;
}
