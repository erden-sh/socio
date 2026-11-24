import { useEffect, useState } from 'react';
import { useLoaderData, useParams, type LoaderFunctionArgs } from 'react-router';

import type { OperatorInferenceState } from '@socio/shared/inference';

import { api } from '../../lib/api';
import { revalidateOn } from '../../lib/page-loader';
import { web } from '../../lib/web-context';
import type { RouteHandle } from '../../shell/shell-context';
import { groupOf } from '../settings/sections';
import { SettingsLayout } from '../settings/SettingsLayout';

import { BackendEditor, PLATFORM_PATH } from './BackendEditor';

import { Skeleton } from '@/components/ui/skeleton';

export const handle: RouteHandle = {
    crumb: ({ params }) => [
        { label: 'Settings', to: '/settings' },
        { label: 'Platform', to: PLATFORM_PATH },
        { label: params.backendId === 'new' ? 'Add a backend' : 'Edit backend' },
    ],
};

/** The backends (operators; the gate sends everyone else home). */
export async function loader({ context }: LoaderFunctionArgs) {
    const { services } = web(context);
    if (!(await services.user())) {
        return null;
    }
    return services.inference();
}
export const shouldRevalidate = revalidateOn();

/** `/settings/operator/backends/:backendId` (or `new`): BackendEditor. */
export default function BackendEditorRoute() {
    const initial = useLoaderData<typeof loader>();
    const { backendId } = useParams();
    const [state, setState] = useState<OperatorInferenceState | null>(initial);
    useEffect(() => {
        if (!state) {
            void api<OperatorInferenceState>('/inference').then(setState, () => {});
        }
    }, [state]);
    if (backendId === 'new') {
        return <BackendEditor />;
    }
    if (!state) {
        return <Skeleton className="m-6 h-64" />;
    }
    const backend = state.backends.find((b) => b.id === backendId);
    if (!backend) {
        return (
            <SettingsLayout group={groupOf('operator')}>
                <p className="text-sm text-muted-foreground">
                    That backend is gone. <a href={PLATFORM_PATH}>Back to Platform</a>
                </p>
            </SettingsLayout>
        );
    }
    // Keyed, so going from one backend's page to another's starts fresh.
    return <BackendEditor key={backend.id} backend={backend} />;
}
