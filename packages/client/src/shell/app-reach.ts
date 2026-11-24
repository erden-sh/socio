import { useEffect, useState } from 'react';
import { z } from 'zod';

import { WORKSPACE_MANIFEST_PATH } from '@socio/shared/device-sign-in';

/** The one field read: the rest of the manifest is the app's. */
const reachSchema = z.object({ methods: z.object({ addDevice: z.boolean() }) });

/**
 * Whether the Socio app can reach this workspace (CB-352): the workspace
 * manifest's `addDevice`, which the server sets where it makes Add a
 * device links (https at the default port, or a test build's setting).
 * Asked once per page, and only with real accounts.
 */
let asked: Promise<{ addDevice: boolean }> | undefined;
export const forgetAppReach = () => {
    asked = undefined;
};
export function appReach() {
    asked ??= fetch(WORKSPACE_MANIFEST_PATH)
        .then(async (response) => {
            const manifest = reachSchema.safeParse(response.ok ? await response.json() : null);
            return { addDevice: manifest.success && manifest.data.methods.addDevice };
        })
        .catch(() => ({ addDevice: false }));
    return asked;
}

export function useAppReach(accounts: boolean) {
    const [reach, setReach] = useState({ addDevice: false });
    useEffect(() => {
        if (!accounts) {
            return;
        }
        let live = true;
        void appReach().then((found) => live && setReach(found));
        return () => {
            live = false;
        };
    }, [accounts]);
    return reach;
}
