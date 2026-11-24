import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';

import { MODULE_IDS } from '@socio/shared/modules';

import { WorkspacePage } from '../../views/WorkspacePage';

import { launchUrl } from './launch';

/**
 * `/apps/:appId/open?next=`: where an app's origin sends someone without a
 * session there. Signed in here, this asks for a one-time code and goes
 * straight back to the app with it.
 */
export function AppOpenPage() {
    const { appId = '' } = useParams();
    const [params] = useSearchParams();
    const [error, setError] = useState<string>();
    useEffect(() => {
        let cancelled = false;
        launchUrl(appId, params.get('next') ?? '/')
            .then((url) => {
                if (!cancelled) {
                    window.location.replace(url);
                }
            })
            .catch((e) => {
                if (!cancelled) {
                    setError(e instanceof Error ? e.message : 'Could not open the app.');
                }
            });
        return () => {
            cancelled = true;
        };
    }, [appId, params]);
    return (
        <WorkspacePage
            slot="app-open-page"
            module={MODULE_IDS.apps}
            title={error ? 'Can’t open this app' : 'Opening…'}
            description={
                error ? (
                    <>
                        {error} It may have been unregistered, or not shared with you.{' '}
                        <Link to="/apps">See your apps</Link>.
                    </>
                ) : (
                    'Signing you in to the app.'
                )
            }
        />
    );
}
