// Moved from `src/server/web/contract.ts`: one web read as a socio's
// declared agent and its answer, which the folders below web (skills'
// unfurl tools, notifications' images) read through web's `WebReader` tag.
// Types only.

export interface WebReadRequest {
    dotId: string;
    /** The user the Dot acts for: audited, never sent. */
    userId?: string;
    url: string;
    method?: 'GET' | 'HEAD';
    headers?: Record<string, string>;
    signal?: AbortSignal;
}
export interface WebResponse {
    ok: true;
    status: number;
    /** After redirects. */
    url: string;
    contentType: string;
    /** The response's Content-Length, when it sent one. */
    contentLength?: number;
    headers: Record<string, string>;
    body: Buffer;
    /** Bytes received (decoded). */
    bytes: number;
    /** False when the size cap cut the body short. */
    complete: boolean;
    cached: boolean;
    revalidated: boolean;
    redirects: number;
    /** Set when the site refused: the Dot is told it now backs off. */
    notice?: string;
}
export interface WebRefusal {
    ok: false;
    reason: 'browser_identity' | 'invalid' | 'blocked' | 'rate_limited' | 'host_stopped' | 'timeout' | 'failed';
    message: string;
    retryAfterSeconds?: number;
}
export type WebReadResult = WebResponse | WebRefusal;
