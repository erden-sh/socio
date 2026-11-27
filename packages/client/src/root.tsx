import type { ReactNode } from 'react';
import {
    Links,
    Meta,
    Outlet,
    Scripts,
    type LoaderFunctionArgs,
    type MetaFunction,
    type ShouldRevalidateFunction,
} from 'react-router';

import { DEFAULT_BRANDING } from '@socio/shared/branding';

import { polledLoadersSkipped } from './hooks/use-tab-refresh';
import { I18nRoot, usePageLocale } from './i18n/I18nRoot';
import { routeI18n } from './i18n/page-i18n';
import { ThemeProvider } from './shell/theme';
import { AppError } from './views/RouteError';
import './globals.css';

/**
 * This page's CSP nonce, in the browser. The server renders it into the
 * links and scripts (React Router passes it there only); the browser hides
 * it from the markup but keeps it on each element, which is what hydration
 * compares. Undefined on the server, where React Router's own applies.
 */
const pageNonce =
    typeof document === 'undefined'
        ? undefined
        : document.querySelector<HTMLScriptElement>('script[nonce]')?.nonce || undefined;

/**
 * The page's locale, signed in or out (the preference, the `socio_locale`
 * cookie, Accept-Language), and the namespaces every page uses
 * (route-namespaces.json's `root`), inlined into the HTML.
 */
export async function loader({ context }: LoaderFunctionArgs) {
    return { i18n: await routeI18n(context, 'root') };
}

/** Like the shell's: after signing in or out, not on every poll or search change. */
export const shouldRevalidate: ShouldRevalidateFunction = ({ currentUrl, nextUrl, defaultShouldRevalidate }) =>
    defaultShouldRevalidate && !polledLoadersSkipped() && currentUrl.search === nextUrl.search;

export const meta: MetaFunction = () => [
    { title: 'Socio' },
    {
        name: 'description',
        content: "Socio: your team's workspace, with AI socios. Chat, pages, a board and approvals in one place.",
    },
    // The built-in favicon. A route that knows the workspace brand (the shell,
    // the docs frame) emits its own icon link and replaces this whole set, so
    // the brand icon ships in the initial HTML; this default is the fallback
    // for routes and error pages that don't. No `type`: see Shell.route.
    { tagName: 'link', rel: 'icon', href: DEFAULT_BRANDING.logo },
];

/**
 * The document around every page, error pages included. The theme script
 * comes first: a file (the CSP allows no inline script without the nonce)
 * that sets the theme class on <html> before the first paint, which
 * `suppressHydrationWarning` lets differ from the server's markup.
 * `lang` and `dir` are the page's locale (the root loader's), and every
 * page renders inside its translations (`I18nRoot`).
 * `#root` stays because the legacy stylesheets are scoped to it.
 */
export function Layout({ children }: { children: ReactNode }) {
    const { lang, dir } = usePageLocale();
    return (
        <html lang={lang} dir={dir} suppressHydrationWarning>
            <head>
                <script src="/theme-init.js" />
                <meta charSet="UTF-8" />
                {/* The favicon comes from <Meta /> (root or the active route), so a
            workspace brand can override the built-in in the initial HTML
            (CB-300). Installable as an app (CB-113); scripts/locals/app-icon.mjs
            renders the favicon and the icons from a Local (Sebas). */}
                <link rel="manifest" href="/manifest.webmanifest" />
                <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />
                {/* resizes-content: Android's keyboard shrinks the page as an
            iPhone's does with useVisibleHeight (CB-102). */}
                <meta
                    name="viewport"
                    content="width=device-width, initial-scale=1.0, interactive-widget=resizes-content"
                />
                <meta name="theme-color" content="#f8f7f4" media="(prefers-color-scheme: light)" />
                <meta name="theme-color" content="#141415" media="(prefers-color-scheme: dark)" />
                <Meta />
                <Links nonce={pageNonce} />
            </head>
            <body>
                <div id="root">
                    <I18nRoot>
                        <ThemeProvider>{children}</ThemeProvider>
                    </I18nRoot>
                </div>
                <Scripts nonce={pageNonce} />
            </body>
        </html>
    );
}

export default function Root() {
    return <Outlet />;
}

export { AppError as ErrorBoundary };
