/**
 * Redaction of Socio's tokens by shape (CB-232): any runtime
 * can redact any token, live or not, because only hashes are stored and
 * no runtime knows another's plaintext. Applied to computer output, tool
 * results, `app_*` snapshots, logs and audit text.
 */

/** A data token's prefix (`dataspace/tokens.ts` issues them). */
export const DATA_TOKEN_PREFIX = 'cbdt_';

/** Prefixes of every Socio credential a computer, app or log could echo. */
export const SOCIO_TOKEN_PREFIXES = ['cbsa_', 'cbgw_', 'cbob_', 'cbdt_', 'cbk_', 'cbat_', 'cbrt_'] as const;

/**
 * A token of any of those prefixes. `cbob_` request tokens carry a dot
 * (`cbob_v1.<sealed>`), so the alphabet includes it; a run of at least 16
 * characters keeps prose such as "cbsa_ tokens" intact.
 */
export const SOCIO_TOKEN_PATTERN = new RegExp(`(?:${SOCIO_TOKEN_PREFIXES.join('|')})[A-Za-z0-9_.-]{16,}`, 'g');

/** An `x-cb-actor` envelope: `v1.<claims>.<mac>`, both base64url. */
export const ACTOR_ENVELOPE_PATTERN = /\bv1\.[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{43}\b/g;

export const REDACTED = '[redacted]';

/** `text` with every Socio token (and, if asked, envelope) replaced. */
export function redactSocioTokens(text: string, { envelopes = false }: { envelopes?: boolean } = {}) {
    const out = text.replace(SOCIO_TOKEN_PATTERN, REDACTED);
    return envelopes ? out.replace(ACTOR_ENVELOPE_PATTERN, REDACTED) : out;
}

/** Whether `text` holds anything shaped like a Socio token (push scans). */
export function hasSocioToken(text: string) {
    SOCIO_TOKEN_PATTERN.lastIndex = 0;
    const found = SOCIO_TOKEN_PATTERN.test(text);
    SOCIO_TOKEN_PATTERN.lastIndex = 0;
    return found;
}

/**
 * A URL's `user:password@` part (`scheme://user:password@host`). A coding
 * sandbox's proxy credential lives in its `HTTP_PROXY` URL, which an agent
 * can print; it has no Socio token shape.
 */
export const URL_USERINFO_PATTERN = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@:]*:[^\s/?#@]+@/gi;

/** `text` with every URL's `user:password@` replaced. */
export const redactUrlUserinfo = (text: string) => text.replace(URL_USERINFO_PATTERN, `$1${REDACTED}@`);
