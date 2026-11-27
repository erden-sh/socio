import { isRouteErrorResponse, useRouteError } from 'react-router';

import { Mascot } from '../locals/Mascot';

import { EmptyPage, NotFound, emptyAction, useErrorWords } from './NotFound';
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
    const { t } = useErrorWords();
    if (isNotFound(useRouteError())) {
        return <NotFound />;
    }
    return (
        <EmptyPage role="alert" title={t('shell:error.page.title')}>
            <p>{t('shell:error.reload-hint')}</p>
            <button className={emptyAction} onClick={reload}>
                {t('shell:error.reload')}
            </button>
        </EmptyPage>
    );
}

/**
 * The whole app failed to render (the root's and the shell route's error
 * boundary), or the not-found notice for a 404.
 */
export function AppError() {
    const { t } = useErrorWords();
    if (isNotFound(useRouteError())) {
        return <NotFound />;
    }
    return (
        <main className={unlock} role="alert">
            <Mascot />
            <h1>{t('shell:error.app.title')}</h1>
            <p>{t('shell:error.reload-hint')}</p>
            <button onClick={reload}>{t('shell:error.reload')}</button>
        </main>
    );
}
