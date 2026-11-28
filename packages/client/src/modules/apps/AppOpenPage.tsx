import { useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';

import { Trans, useTranslation } from '@socio/i18n/react';
import { MODULE_IDS } from '@socio/shared/modules';

import { WorkspacePage } from '../../views/WorkspacePage';

import { launchUrl } from './launch';

/**
 * `/apps/:appId/open?next=`: where an app's origin sends someone without a
 * session there. Signed in here, this asks for a one-time code and goes
 * straight back to the app with it.
 */
export function AppOpenPage() {
    const { t } = useTranslation(['apps.open']);
    // The latest t, for callbacks and effects that shouldn't run again when the language changes.
    const latestT = useRef(t);
    latestT.current = t;
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
                    setError(e instanceof Error ? e.message : latestT.current('apps.open:failed'));
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
            title={error ? t('apps.open:error-title') : t('apps.open:opening')}
            description={
                error ? (
                    <>
                        {error}{' '}
                        <Trans t={t} i18nKey="apps.open:error-detail" components={{ apps: <Link to="/apps" /> }} />
                    </>
                ) : (
                    t('apps.open:signing-in')
                )
            }
        />
    );
}
