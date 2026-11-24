import type { MiddlewareHandler } from 'hono';

/**
 * The Content Security Policy of everything that isn't a page (files,
 * `/healthz`): scripts only from the app's own files, none inline.
 */
export const CONTENT_SECURITY_POLICY = `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`;

/**
 * A rendered page's policy: the same, plus the inline scripts that carry
 * this response's nonce (React Router's handoff and module bootstrap,
 * React's streamed chunks). The theme script is still a file.
 */
export const pageContentSecurityPolicy = (nonce: string) =>
    CONTENT_SECURITY_POLICY.replace("script-src 'self'", `script-src 'self' 'nonce-${nonce}'`);

/** Adds `frame-src` for one plugin origin. The default policy string is unchanged. */
export function withFrameSrc(policy: string, origin: string) {
    if (!/^https?:\/\/[^\s;]+$/.test(origin)) {
        return policy;
    }
    return `${policy}; frame-src ${origin}`;
}

/**
 * The headers every response from here on carries. Set after the response
 * is made: only then is it known whether a page was rendered (the page
 * guard sets the nonce).
 */
export const securityHeaders: MiddlewareHandler<{ Variables: { cspNonce?: string; frameSrc?: string } }> = async (
    c,
    next,
) => {
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    const nonce = c.get('cspNonce');
    const frame = c.get('frameSrc');
    const policy = nonce ? pageContentSecurityPolicy(nonce) : CONTENT_SECURITY_POLICY;
    c.header('Content-Security-Policy', frame ? withFrameSrc(policy, frame) : policy);
};
