import type { LoaderFunctionArgs, MetaFunction, ShouldRevalidateFunction } from 'react-router';

import { DEFAULT_BRANDING, type Branding } from '@socio/shared/branding';

import { polledLoadersSkipped } from '../hooks/use-tab-refresh';
import { web } from '../lib/web-context';

import { uiHints } from './ui-hints';

export { App as default } from './App';
export { AppError as ErrorBoundary } from '../views/RouteError';

/**
 * What the shell's first render needs: the hints from the page request,
 * and either this user's state and workspace (what `/api/state` and
 * `/api/workspace` return them) or, signed out, what the sign-in screen
 * offers. The server renders the real shell, or sign-in, from it.
 */
export async function loader({ context, request }: LoaderFunctionArgs) {
    const { services } = web(context);
    const ui = uiHints(request);
    if (!(await services.user())) {
        return {
            session: 'signed-out',
            ui,
            signIn: await services.signIn(),
        } as const;
    }
    const [state, workspace] = await Promise.all([services.state(), services.workspace()]);
    return { session: 'signed-in', ui, state, workspace } as const;
}

/** The shell's loader data (`App` reads it). */
export type ShellData = Awaited<ReturnType<typeof loader>>;

function shellBranding(data: ShellData): Branding {
    return (data.session === 'signed-in' ? data.state.settings.branding : data.signIn.branding) ?? DEFAULT_BRANDING;
}

/**
 * Server-render the workspace brand in the document head, including the
 * favicon. The link carries no `type`: `brand.logo` may be an SVG path, a
 * same-origin raster asset, or an uploaded PNG/JPEG/WebP data URL, so a
 * fixed MIME would mislabel any of those. Browsers sniff the type from the
 * data URL or the asset's own Content-Type, matching `useBrandingDocument`.
 */
export const meta: MetaFunction<typeof loader> = ({ loaderData }) => {
    const brand = loaderData ? shellBranding(loaderData) : DEFAULT_BRANDING;
    return [{ title: brand.name }, { tagName: 'link', rel: 'icon', href: brand.logo }];
};

/**
 * The 3 s poll keeps the shell fresh, so navigations never ask again
 * (React Router's default would when the search changes). A revalidation
 * does: after sign-in and sign-out, also when a module gate then sends
 * the new user home. Not the pages-only one when the tab comes back or
 * another tab wrote (use-tab-refresh.ts): the poll re-reads the shell.
 */
export const shouldRevalidate: ShouldRevalidateFunction = ({ currentUrl, nextUrl, defaultShouldRevalidate }) =>
    defaultShouldRevalidate && !polledLoadersSkipped() && currentUrl.search === nextUrl.search;
