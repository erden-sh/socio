import type { Root as PageTree } from 'fumadocs-core/page-tree';
import { useSearchContext } from 'fumadocs-ui/contexts/search';
import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { DocsPage, DocsTitle, DocsDescription, DocsBody } from 'fumadocs-ui/layouts/docs/page';
import { RootProvider } from 'fumadocs-ui/provider/react-router';
import { setNonce } from 'get-nonce';
import { toJsxRuntime } from 'hast-util-to-jsx-runtime';
import { useEffect, useMemo, type ReactNode } from 'react';
import {
    isRouteErrorResponse,
    useLoaderData,
    useRouteError,
    type LoaderFunctionArgs,
    type MetaFunction,
} from 'react-router';
import { Fragment, jsx, jsxs } from 'react/jsx-runtime';

import { DEFAULT_BRANDING } from '@socio/shared/branding';
import type { DocsScreen, DocsTree } from '@socio/shared/docs';

import { web } from '../../lib/web-context';
import { AppError } from '../../views/RouteError';

import docsCss from './docs.css?url';

export const links = () => [{ rel: 'stylesheet', href: docsCss }];
export const meta: MetaFunction = ({ loaderData }) => [
    {
        title: loaderData ? `${(loaderData as DocsScreen).page.title} · Socio help` : 'Not found · Socio help',
    },
    // Docs is a pathless route outside the shell, so it doesn't inherit the
    // shell's brand icon; emit the built-in here as the SSR fallback (CB-300).
    { tagName: 'link', rel: 'icon', href: DEFAULT_BRANDING.logo },
];
/** What a 404 carries to the error boundary. */
export interface DocsNotFoundData {
    tree: DocsTree;
    nonce: string;
}
const EMPTY_TREE: DocsTree = { name: 'Socio help', children: [] };

export async function loader({ context, params }: LoaderFunctionArgs) {
    const { services } = web(context);
    await services.user();
    const slug = params['*'] ?? '';
    const found = await services.docsPage?.('/docs' + (slug ? '/' + slug : ''));
    // Missing and hidden articles get the same 404, carrying only the
    // viewer's own navigation, so the page never says which one it was.
    if (!found) {
        throw Response.json(
            {
                tree: (await services.docsTree?.()) ?? EMPTY_TREE,
                nonce: web(context).nonce,
            } satisfies DocsNotFoundData,
            { status: 404 },
        );
    }
    return { ...found, nonce: web(context).nonce };
}
/** Always refetch on navigation: a previously privileged browser has no role cache. */
export const shouldRevalidate = () => true;
/**
 * The help center's frame: Fumadocs with the viewer's navigation and
 * search, around an article or the not-found notice.
 */
function DocsChrome({ tree, nonce, children }: { tree: DocsTree; nonce: string; children: ReactNode }) {
    const navigation = useMemo(() => structuredClone(tree) as PageTree, [tree]);
    // A BFCache restore or returning to a background tab must check revoked roles again.
    useEffect(() => {
        setNonce(nonce);
        const restore = (event: PageTransitionEvent) => {
            if (event.persisted) {
                location.reload();
            }
        };
        window.addEventListener('pageshow', restore);
        const refresh = () => {
            if (document.visibilityState === 'visible') {
                location.reload();
            }
        };
        document.addEventListener('visibilitychange', refresh);
        return () => {
            window.removeEventListener('pageshow', restore);
            document.removeEventListener('visibilitychange', refresh);
        };
    }, [nonce]);
    return (
        <div className="socio-docs">
            <RootProvider theme={{ enabled: false }} search={{ options: { api: '/docs/search' } }}>
                <DocsLayout
                    tree={navigation}
                    nav={{ title: 'Socio help', url: '/docs' }}
                    links={[{ text: 'Workspace', url: '/', external: true }]}
                    themeSwitch={{ enabled: false }}
                >
                    {children}
                </DocsLayout>
            </RootProvider>
        </div>
    );
}

export function DocsView({ page, tree, nonce }: DocsScreen & { nonce: string }) {
    return (
        <DocsChrome tree={tree} nonce={nonce}>
            <DocsPage toc={page.toc}>
                <DocsTitle>{page.title}</DocsTitle>
                <DocsDescription>{page.description}</DocsDescription>
                <nav aria-label="Article formats" className="docs-formats">
                    <a href={page.url + '.md'}>Markdown</a>
                    <a href="/llms.txt">Docs for agents</a>
                </nav>
                <DocsBody>{toJsxRuntime(page.body, { Fragment, jsx, jsxs })}</DocsBody>
            </DocsPage>
        </DocsChrome>
    );
}

/** Opens the help center's search, as the sidebar's search box does. */
function SearchButton() {
    const { enabled, setOpenSearch } = useSearchContext();
    if (!enabled) {
        return null;
    }
    return (
        <button type="button" onClick={() => setOpenSearch(true)}>
            Search the help center
        </button>
    );
}

/**
 * No article at this address for this viewer (CB-264). The same page for
 * one that doesn't exist and one the viewer's role can't open: nothing in
 * it depends on the address.
 */
export function DocsNotFound({ tree, nonce }: DocsNotFoundData) {
    return (
        <DocsChrome tree={tree} nonce={nonce}>
            <DocsPage toc={[]} breadcrumb={{ enabled: false }} footer={{ enabled: false }}>
                <DocsTitle>Article not found</DocsTitle>
                <DocsDescription>There&apos;s no help article here. The link may be out of date.</DocsDescription>
                <nav aria-label="Find an article" className="docs-formats docs-not-found">
                    <a href="/docs">Back to the help center</a>
                    <SearchButton />
                </nav>
            </DocsPage>
        </DocsChrome>
    );
}

/** A 404 is the not-found page; anything else is the app's error page. */
export function ErrorBoundary() {
    const error = useRouteError();
    if (isRouteErrorResponse(error) && error.status === 404) {
        const found = error.data as Partial<DocsNotFoundData> | null;
        return <DocsNotFound tree={found?.tree ?? EMPTY_TREE} nonce={found?.nonce ?? ''} />;
    }
    return <AppError />;
}

export default function DocsRoute() {
    return <DocsView {...useLoaderData<typeof loader>()} />;
}
