import { useEffect, useState } from 'react';

import { browserOffline } from '../lib/api';

/**
 * Whether the browser says it is offline, following its `offline` and
 * `online` events. False in the server render and until mounted.
 */
export function useOffline() {
    const [offline, setOffline] = useState(false);
    useEffect(() => {
        const update = () => setOffline(browserOffline());
        update();
        window.addEventListener('offline', update);
        window.addEventListener('online', update);
        return () => {
            window.removeEventListener('offline', update);
            window.removeEventListener('online', update);
        };
    }, []);
    return offline;
}
