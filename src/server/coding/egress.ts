import { z } from 'zod';

import { deriveKey, egressCredentialKey, signEgressCredential } from '@socio/foundation/actors/keys';

/**
 * The coding egress proxy, from Socio's side (CB-239;
 * `src/coding-egress/`): the sandbox's proxy credential, signed for the
 * network's subnet with the session id as the sandbox id (so the stamp the
 * proxy adds names the session, and a `cbgw_` bound to it is accepted only
 * through that sandbox's proxy), and the proxy's denial counts from its
 * diagnostics listener.
 */

/** The proxy credential for one sandbox (`POST /sandboxes/:id/start`). */
export function sandboxProxyCredential(
    egressSecret: string,
    claims: {
        sessionId: string;
        subnet: string;
        allow: string[];
        expiresAt: number;
    },
) {
    return signEgressCredential(egressCredentialKey(egressSecret), {
        sandboxId: claims.sessionId,
        allow: claims.allow,
        subnet: claims.subnet,
        expiresAt: claims.expiresAt,
    });
}

/**
 * The bearer token of the proxy's diagnostics listener; the same as
 * `diagnosticsToken` in src/coding-egress/proxy.ts (a test keeps them
 * equal), without pulling the proxy into the app.
 */
export const egressDiagnosticsToken = (secret: string) =>
    deriveKey(secret, 'coding-egress-diagnostics').toString('base64url');

const denials = z.object({
    sandboxId: z.string(),
    denials: z
        .array(
            z.object({
                target: z.string().min(1).max(300),
                count: z.number().int().nonnegative(),
                firstAt: z.number().optional(),
                lastAt: z.number().optional(),
            }),
        )
        .max(1000),
});

/**
 * A sandbox's denials (`GET /denials/<sandboxId>` on the diagnostics
 * port), or undefined when the proxy can't be asked. Session id and
 * `host:port` only: never headers, bodies or addresses.
 */
export async function readDenials(
    options: { url: string; secret: string; fetch?: typeof fetch },
    sessionId: string,
): Promise<Array<{ target: string; count: number }> | undefined> {
    const fetchImpl = options.fetch ?? ((...args) => fetch(...args));
    try {
        const response = await fetchImpl(`${options.url.replace(/\/$/, '')}/denials/${encodeURIComponent(sessionId)}`, {
            headers: {
                Authorization: `Bearer ${egressDiagnosticsToken(options.secret)}`,
            },
            redirect: 'error',
            signal: AbortSignal.timeout(5_000),
        });
        if (!response.ok) {
            return undefined;
        }
        const parsed = denials.safeParse(await response.json());
        if (!parsed.success || parsed.data.sandboxId !== sessionId) {
            return undefined;
        }
        return parsed.data.denials
            .filter((entry) => /^[A-Za-z0-9.:[\]_-]{1,300}$/.test(entry.target))
            .map(({ target, count }) => ({ target, count }));
    } catch {
        return undefined;
    }
}
