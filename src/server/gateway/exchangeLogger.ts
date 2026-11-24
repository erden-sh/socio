import { createHash, randomUUID } from 'node:crypto';

import type { GatewayExchangesShape } from '../coding/contract.js';

/**
 * The coding session gateway exchange log (CB-326 step 6): records one row per
 * gateway request and response for a coding session. The bodies (request
 * as-forwarded, response as-received) are stored out-of-line by a
 * {@link ExchangeBodyStore} — in production, the object store (SeaweedFS),
 * Brotli-compressed and sealed under the `gateway-log` purpose; the DB row
 * carries the metadata, sizes and content hashes. The store is pluggable so the
 * app side is complete and testable without the object store (an in-memory
 * store stands in for tests; the SeaweedFS-backed store is a deploy pipeline
 * handoff).
 *
 * Credentials never reach the log by construction: the request body is the
 * post-`cbgw_`-removal, sanitized body the gateway forwards (the inbound
 * `cbgw_` and the upstream's vendor credentials are not in it), and the
 * response is the upstream's answer as received. The redaction the body
 * store applies (token shapes + the session's Socio Secrets values) is the
 * store's responsibility; the row never holds a body.
 */
export interface ExchangeBodyStore {
    /**
     * Stores one exchange's request and response bodies, returning the path
     * the DB row records. Best-effort: a failure logs and the row is written
     * with a null path (the metadata and hashes still record that the exchange
     * happened, per the "raw stream kept only on errors" fallback).
     */
    write(
        session: ExchangeSession,
        seq: number,
        bodies: { request: Uint8Array; response: Uint8Array | null },
    ): Promise<string | null>;
}

/** The coding-session facts an exchange row names (CB-326 step 6). */
export interface ExchangeSession {
    readonly sessionId: string;
    readonly holderId: string;
    readonly requesterId: string | null;
    readonly harness: string;
}

/** What one gateway exchange records: the request, the response, the join. */
export interface ExchangeEntry {
    readonly session: ExchangeSession;
    readonly api: string;
    readonly route: string;
    readonly model: string | null;
    readonly upstreamKind: string;
    readonly requestAt: number;
    readonly responseAt: number | null;
    readonly status: string | null;
    /** The `gateway_usage` row this exchange joins, for token counts. */
    readonly usageId: number | null;
    /** The request body as-forwarded (sanitized, post-`cbgw_`). */
    readonly requestBody: Uint8Array;
    /** The response body as-received (null on a non-JSON / failed read). */
    readonly responseBody: Uint8Array | null;
}

/**
 * One exchange logger per gateway (constructed with the rows + an optional
 * body store). `log` is the single entry point: it hashes the bodies, asks
 * the store to persist them, and writes the row. Safe to call without a store
 * (the row records metadata + hashes only); safe to call after the response
 * stream has reassembled (the caller holds the bodies).
 */
export class ExchangeLogger {
    private seq = 0;
    constructor(
        private readonly rows: GatewayExchangesShape,
        private readonly store: ExchangeBodyStore | null,
    ) {}

    async log(entry: ExchangeEntry): Promise<void> {
        const id = randomUUID();
        const seq = (this.seq += 1);
        const requestHash = sha256(entry.requestBody);
        const responseHash = entry.responseBody ? sha256(entry.responseBody) : null;
        let bodyPath: string | null = null;
        if (this.store && entry.responseBody) {
            try {
                bodyPath = await this.store.write(entry.session, seq, {
                    request: entry.requestBody,
                    response: entry.responseBody,
                });
            } catch {
                // The body didn't persist; the row still records the exchange
                // happened: metadata + hashes, no path.
                bodyPath = null;
            }
        }
        this.rows.insert({
            id,
            usageId: entry.usageId,
            sessionId: entry.session.sessionId,
            holderId: entry.session.holderId,
            requesterId: entry.session.requesterId,
            harness: entry.session.harness,
            api: entry.api,
            route: entry.route,
            model: entry.model,
            upstreamKind: entry.upstreamKind,
            requestAt: entry.requestAt,
            responseAt: entry.responseAt,
            status: entry.status,
            bodyPath,
            requestBytes: entry.requestBody.byteLength,
            responseBytes: entry.responseBody?.byteLength ?? null,
            requestHash,
            responseHash,
            deletedAt: null,
            deletedBy: null,
            deletedWith: null,
        });
    }
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('base64url');
