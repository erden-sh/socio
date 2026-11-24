import { useLoaderData, type LoaderFunctionArgs } from 'react-router';

import type { MediaKind } from '@socio/shared/media-types';

import { revalidateOn } from '../../lib/page-loader';
import { web } from '../../lib/web-context';

import { MediaPage, type MediaSeed } from './MediaPage';

/**
 * The folder the address opens (`?folder=`, `?q=`, `?kind=`): its first
 * 100 files, its subfolders and the tree, as `/api/media` lists them for
 * this user. Previews (the files' bodies) stay in the browser.
 */
export async function loader({ context, request }: LoaderFunctionArgs): Promise<MediaSeed | null> {
    const { services } = web(context);
    if (!(await services.user())) {
        return null;
    }
    const params = new URL(request.url).searchParams;
    const query = {
        folder: params.get('folder') ?? '',
        q: params.get('q') ?? '',
        kind: (params.get('kind') ?? '') as MediaKind | '',
    };
    const listing = await services.media({
        folder: query.folder || undefined,
        q: query.q.trim() || undefined,
        kind: query.kind || undefined,
    });
    return listing && { query, listing };
}
// A folder or search picked on the page loads there, as before.
export const shouldRevalidate = revalidateOn({ search: false });

export default function MediaRoute() {
    const initial = useLoaderData<typeof loader>();
    return <MediaPage initial={initial ?? undefined} />;
}
