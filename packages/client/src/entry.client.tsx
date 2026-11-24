import { startTransition, StrictMode } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { HydratedRouter } from 'react-router/dom';

import { installMirrorDiscoveryGuard } from './modules/plugins/mirror-discovery';
import { resumeRecording } from './modules/settings/performance/recorder';
import { installChunkReload } from './shell/chunk-reload';
import { installPresence } from './shell/presence';

// After a deploy, a route module that fails to import reloads the page
// (React Router does that itself). Other dynamic imports (the editor,
// passkeys) reload once through Vite's preload error.
installChunkReload();
// Whether this tab is in use, for Dots' notifications (CB-114): the
// shell's poll reports it, and hiding the tab says it's away.
installPresence();
resumeRecording();
// A plugin's address mirror whose route discovery fails is skipped, not an
// error page that would unmount the plugin's frame (CB-446).
installMirrorDiscoveryGuard();
// The push-only service worker (public/sw.js): no fetch handler, no cache.
// Without one (an old browser, a blocked registration) push can't be
// turned on; Account → Notifications says so.
navigator.serviceWorker?.register('/sw.js').catch(() => undefined);

startTransition(() => {
    hydrateRoot(
        document,
        <StrictMode>
            <HydratedRouter />
        </StrictMode>,
        {
            // A server/client mismatch; ui-smoke fails on the `[hydration]` tag.
            onRecoverableError: (error) => console.error('[hydration]', error),
        },
    );
});
