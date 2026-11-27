import type { LoaderFunctionArgs } from 'react-router';

import { routeI18n } from '../i18n/page-i18n';
import { revalidateOn } from '../lib/page-loader';

export { Home as default } from './Home';

/** Its namespaces (route-namespaces.json), inlined with the page; once a visit, as they don't change with the params. */
export async function loader({ context }: LoaderFunctionArgs) {
    return { i18n: await routeI18n(context, 'home') };
}
export const shouldRevalidate = revalidateOn({ search: false });
