import type { Branding } from '@socio/shared/branding';
import type { SignInView } from '@socio/shared/web/web';

import type { AuthProvider } from './contract.js';

/**
 * The sign-in view, moved here from live/views/auth.ts
 * so `auth/` no longer imports `live/`. Other features read it through the
 * `AuthViews` tag (contract.ts, auth/layer.ts), as web/services.ts does
 * since live/views/auth.ts was deleted.
 */

/** `GET /api/auth/session` without the user: what the sign-in screen offers. */
export function signInView(provider: AuthProvider, branding?: Branding): SignInView {
    return {
        provider: provider.kind,
        branding,
        ...(provider.signInMethods ? { methods: provider.signInMethods() } : {}),
    };
}
