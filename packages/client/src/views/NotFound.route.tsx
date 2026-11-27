import { data } from 'react-router';

import type { RouteHandle } from '../shell/shell-context';

import { NotFound } from './NotFound';

/** An unknown address answers 404, with the shell around the notice. */
export const loader = () => data(null, { status: 404 });

export const handle: RouteHandle = {
    // oxlint-disable-next-line socio/translate-in-components -- the header's t, passed at each render (CrumbContext)
    crumb: ({ t }) => [{ label: t('shell:error.not-found.crumb') }],
};
export default function NotFoundRoute() {
    return <NotFound />;
}
