import { useState } from 'react';

import type { GatewayExchangeView, GatewayExchangesPage } from '@socio/shared/coding/coding-sessions';
import { inertText } from '@socio/shared/text/inert-text';

import { api, ApiError } from '../../lib/api';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

/**
 * The gateway exchange log viewer for one coding session (CB-326 step 5):
 * the model requests and responses the gateway logged for the session,
 * paged by `requestAt`. The holder (the session's own person) and admins
 * see it; anyone else sees nothing of it. Metadata and content hashes
 * only — the bodies live in the object store, plugged in by the IaC
 * handoff; the null store writes no `bodyPath`. Export downloads the same
 * records as JSON Lines. Everything here is metadata the gateway produced,
 * shown inert.
 */

const inert = (value: string, max = 200) => inertText(value, { max });

/** One row of the exchange log. */
function ExchangeRow({ exchange }: { exchange: GatewayExchangeView }) {
    const when = new Date(exchange.requestAt).toLocaleTimeString();
    return (
        <li className="grid min-w-0 gap-0.5">
            <p className="m-0 [overflow-wrap:anywhere]">
                <span className="text-muted-foreground">{when}</span>{' '}
                <span className="font-mono text-xs">{inert(exchange.api, 32)}</span>{' '}
                {exchange.model && <span className="text-xs">{inert(exchange.model, 64)}</span>}{' '}
                <Badge variant="outline">{inert(exchange.upstreamKind, 16)}</Badge>
                {exchange.status && (
                    <Badge variant={exchange.status.startsWith('2') ? 'secondary' : 'destructive'}>
                        {inert(exchange.status, 16)}
                    </Badge>
                )}
            </p>
            <p className="m-0 font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]">
                {inert(exchange.route, 120)}
            </p>
            <p className="m-0 text-xs text-muted-foreground">
                {exchange.requestBytes ?? 0}→{exchange.responseBytes ?? 0} bytes
                {exchange.requestHash && <span className="ml-1">req {inert(exchange.requestHash, 16)}</span>}
                {exchange.responseHash && <span className="ml-1">res {inert(exchange.responseHash, 16)}</span>}
            </p>
        </li>
    );
}

export function CodingExchangesSection({ id }: { id: string }) {
    const [open, setOpen] = useState(false);
    const [rows, setRows] = useState<GatewayExchangeView[]>([]);
    const [after, setAfter] = useState(0);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);

    const load = async (cursor: number) => {
        setLoading(true);
        try {
            const page = await api<GatewayExchangesPage>(
                `/gateway/sessions/${encodeURIComponent(id)}/exchanges?after=${cursor}&limit=50`,
                'GET',
            );
            if (page.exchanges.length > 0) {
                setRows((prev) => [...prev, ...page.exchanges]);
                setAfter(page.next ?? page.exchanges.at(-1)!.requestAt);
            }
            setError(null);
        } catch (failure) {
            setError(
                failure instanceof ApiError && failure.status === 404 ? null : 'The exchange log couldn’t be loaded.',
            );
        } finally {
            setLoading(false);
        }
    };

    if (!open) {
        return (
            <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                    setOpen(true);
                    void load(0);
                }}
            >
                Show gateway exchanges
            </Button>
        );
    }

    return (
        <div className="grid min-w-0 gap-1.5">
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                <span className="text-xs font-medium">Gateway exchanges</span>
                <a
                    href={`/api/gateway/sessions/${encodeURIComponent(id)}/exchanges/export`}
                    className="text-xs underline underline-offset-3"
                    download
                >
                    Export as JSON Lines
                </a>
                <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
                    Hide
                </Button>
            </div>
            {error && (
                <p className="m-0 text-xs text-muted-foreground" role="status">
                    {error}
                </p>
            )}
            {rows.length === 0 && !loading && !error && (
                <p className="m-0 text-xs text-muted-foreground">No gateway exchanges logged yet.</p>
            )}
            <ol className="m-0 grid min-w-0 list-none gap-1.5 p-0">
                {rows.map((exchange) => (
                    <ExchangeRow key={exchange.id} exchange={exchange} />
                ))}
            </ol>
            {rows.length > 0 && (
                <Button type="button" size="sm" variant="ghost" disabled={loading} onClick={() => void load(after)}>
                    {loading ? 'Loading…' : 'Load more'}
                </Button>
            )}
        </div>
    );
}
