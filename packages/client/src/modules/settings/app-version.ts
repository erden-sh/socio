import { useEffect, useState } from 'react';

import type { ReleasesResponse } from '@socio/shared/updates/releases';

import { api } from '../../lib/api';

export interface AppVersion {
    version: string;
    commit: string | null;
}

// Asked once per page load: it changes only with a deploy, which reloads.
let asked: Promise<AppVersion> | undefined;

/** The running app's version and commit (CB-165); undefined until known. */
export function useAppVersion() {
    const [version, setVersion] = useState<AppVersion>();
    useEffect(() => {
        let cancelled = false;
        asked ??= api<ReleasesResponse>('/releases?limit=0').then(({ current, commit }) => ({
            version: current,
            commit,
        }));
        asked
            .then((found) => !cancelled && setVersion(found))
            .catch(() => {
                // Shown again on the next page load; the footer just stays empty.
                asked = undefined;
            });
        return () => {
            cancelled = true;
        };
    }, []);
    return version;
}
