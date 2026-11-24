import { useParams } from 'react-router';

import type { RouteHandle } from '../shell/shell-context';

import { ReleasesPage } from './ReleasesPage';

// `/releases` and `/releases/v0.5.0` (CB-168): Release notes › v0.5.0.
export const handle: RouteHandle = {
    crumb: ({ params }) =>
        params.tag
            ? [{ label: 'Release notes', to: '/releases' }, { label: params.tag }]
            : [{ label: 'Release notes' }],
};

/** Socio's release notes; a tag opens at that release. */
export default function ReleasesRoute() {
    const { tag } = useParams();
    return <ReleasesPage tag={tag} />;
}
