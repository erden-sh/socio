import { isRouteErrorResponse, useRouteError } from 'react-router';

import { Mascot } from '../locals/Mascot';

import { EmptyPage, NotFound, emptyAction } from './NotFound';
import { unlock } from './unlock';

const reload = () => location.reload();

/**
 * A loader that threw a 404 (CB-264): there is nothing here, and reloading
 * won't change that.
 */
const isNotFound = (error: unknown) => isRouteErrorResponse(error) && error.status === 404;

/**
 * A page that failed to render, in the shell's page area (a module gate's
 * error boundary), or the not-found notice for a 404. React logs the error
 * to the console; the page doesn't show it.
 */
export function RouteError() {
    if (isNotFound(useRouteError())) {
        return <NotFound />;
    }
    return (
        <EmptyPage role="alert" title="This page failed to load.">
            <p>Reloading usually fixes it.</p>
            <button className={emptyAction} onClick={reload}>
                Reload
            </button>
        </EmptyPage>
    );
}

/**
 * The whole app failed to render (the root's and the shell route's error
 * boundary), or the not-found notice for a 404.
 */
export function AppError() {
    if (isNotFound(useRouteError())) {
        return <NotFound />;
    }
    return (
        <main className={unlock} role="alert">
            <Mascot />
            <h1>Something went wrong.</h1>
            <p>Reloading usually fixes it.</p>
            <button onClick={reload}>Reload</button>
        </main>
    );
}
