import { expect, it } from 'vitest';

import { GatewayExchangeRows } from '../src/server/coding/infra/rows.js';
import { ExchangeLogger, type ExchangeBodyStore, type ExchangeSession } from '../src/server/gateway/exchangeLogger.js';

import { testDatabase } from './helpers/test-database.js';

const db = () => {
    const connection = testDatabase();
    return connection;
};

const session: ExchangeSession = {
    sessionId: 'sess1',
    holderId: 'alice',
    requesterId: 'socio1',
    harness: 'codex',
};

it('writes an exchange row with hashes and metadata, bodies out-of-line via the store (CB-326 step 6)', async () => {
    const rows = new GatewayExchangeRows(db());
    const written: Array<{ seq: number; request: Uint8Array; response: Uint8Array | null }> = [];
    const store: ExchangeBodyStore = {
        async write(_session, seq, bodies) {
            written.push({ seq, request: bodies.request, response: bodies.response });
            return `gateway-log/${_session.sessionId}/${seq}`;
        },
    };
    const logger = new ExchangeLogger(rows, store);
    const request = new TextEncoder().encode('{"model":"x"}');
    const response = new TextEncoder().encode('{"ok":true}');
    await logger.log({
        session,
        api: 'responses',
        route: '/v1/responses',
        model: 'gpt-5',
        upstreamKind: 'gateway',
        requestAt: 1000,
        responseAt: 1100,
        status: 'ok',
        usageId: 42,
        requestBody: request,
        responseBody: response,
    });
    expect(written).toHaveLength(1);
    expect(written[0]!.seq).toBe(1);
    const [row] = rows.page('sess1', 0, 10);
    expect(row.sessionId).toBe('sess1');
    expect(row.holderId).toBe('alice');
    expect(row.api).toBe('responses');
    expect(row.model).toBe('gpt-5');
    expect(row.status).toBe('ok');
    expect(row.usageId).toBe(42);
    expect(row.bodyPath).toBe('gateway-log/sess1/1');
    expect(row.requestBytes).toBe(request.byteLength);
    expect(row.responseBytes).toBe(response.byteLength);
    expect(row.requestHash).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(row.responseHash).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(row.requestHash).not.toBe(row.responseHash);
});

it('writes a row with null path when there is no body store, and metadata still records the exchange (CB-326 step 6)', async () => {
    const rows = new GatewayExchangeRows(db());
    const logger = new ExchangeLogger(rows, null);
    await logger.log({
        session,
        api: 'messages',
        route: '/v1/messages',
        model: null,
        upstreamKind: 'gateway',
        requestAt: 2000,
        responseAt: null,
        status: 'upstream_broken',
        usageId: null,
        requestBody: new TextEncoder().encode('{}'),
        responseBody: null,
    });
    const [row] = rows.page('sess1', 0, 10);
    expect(row.bodyPath).toBeNull();
    expect(row.responseBytes).toBeNull();
    expect(row.responseHash).toBeNull();
    expect(row.status).toBe('upstream_broken');
    expect(row.usageId).toBeNull();
});

it('soft-deletes a session’s exchanges when the session ends (CB-64)', async () => {
    const connection = db();
    const rows = new GatewayExchangeRows(connection);
    const logger = new ExchangeLogger(rows, null);
    await logger.log({
        session,
        api: 'responses',
        route: '/v1/responses',
        model: 'gpt-5',
        upstreamKind: 'gateway',
        requestAt: 3000,
        responseAt: 3100,
        status: 'ok',
        usageId: 1,
        requestBody: new Uint8Array(),
        responseBody: new Uint8Array(),
    });
    expect(rows.page('sess1', 0, 10)).toHaveLength(1);
    rows.softDelete('sess1', 'system', 'coding-session', 4000);
    expect(rows.page('sess1', 0, 10)).toHaveLength(0);
});
