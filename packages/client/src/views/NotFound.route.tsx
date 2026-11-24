import { data } from 'react-router';

import type { RouteHandle } from '../shell/shell-context';

import { NotFound } from './NotFound';

/** An unknown address answers 404, with the shell around the notice. */
export const loader = () => data(null, { status: 404 });

export const handle: RouteHandle = { crumb: () => [{ label: 'Not found' }] };
export default function NotFoundRoute() {
    return <NotFound />;
}
