import { Navigate, redirect, useParams, type ClientLoaderFunctionArgs, type LoaderFunctionArgs } from 'react-router';

import { routeI18n } from '../../i18n/page-i18n';
import { preloadNamespaces } from '../../i18n/page-instance';
import { revalidateOn } from '../../lib/page-loader';
import { useFlags } from '../../shell/flags';
import type { RouteHandle } from '../../shell/shell-context';

import { OperationsLayout, useSectionHeading } from './OperationsLayout';
import { OpsSectionPage } from './OpsSectionPage';
import { findOpsSection, OPS_HOME, type OpsSection, type OpsSectionId } from './sections';

export const handle: RouteHandle = {
    crumb: ({ params, t }) => {
        const section = findOpsSection(params.section);
        return params.section && section
            ? [
                  // oxlint-disable-next-line socio/translate-in-components -- the header's t, passed at each render (CrumbContext)
                  { label: t('operations:title'), to: OPS_HOME },
                  // oxlint-disable-next-line socio/translate-in-components -- the header's t, passed at each render (CrumbContext)
                  { label: t(`operations:sections.${section.id}.label`) },
              ]
            : // oxlint-disable-next-line socio/translate-in-components -- the header's t, passed at each render (CrumbContext)
              [{ label: t('operations:title') }];
    },
};

/**
 * `/operations` (Overview) and `/operations/:section`: an unknown section
 * goes to Overview. Who may open them is the module gate's (admins). Each
 * page inlines its own namespaces (route-namespaces.json: `operations`
 * for Overview, `operations:section:<section>` for the others).
 */
export async function loader({ params, context }: LoaderFunctionArgs) {
    const section = findOpsSection(params.section);
    if (!section) {
        throw redirect(OPS_HOME);
    }
    return {
        i18n: await routeI18n(context, section.id === 'overview' ? 'operations' : `operations:section:${section.id}`),
    };
}
/**
 * What a section loads on demand that its route doesn't inline, so its
 * page stays within the budget: cards below the fold or opened by a click
 * (Knowledge's storage and limits, Reliability's board and failure
 * labels, Health's numbers and resources, Cost's admin cards, Settings'
 * labeling cards).
 */
const ON_DEMAND: Partial<Record<OpsSectionId, readonly string[]>> = {
    knowledge: ['operations.knowledge-storage'],
    reliability: ['operations.reliability-board', 'operations.failure-label'],
    health: ['operations.health-numbers', 'operations.resources'],
    cost: ['operations.cost-admin'],
    settings: ['operations.labeling'],
};

/**
 * A navigation in the browser: the section's data, and at the same time
 * what it loads on demand (`ON_DEMAND`), so nothing waits for its words
 * after the data comes. The first page load uses the server's data.
 */
export function clientLoader({ params, serverLoader }: ClientLoaderFunctionArgs) {
    const on = ON_DEMAND[findOpsSection(params.section)?.id ?? 'overview'];
    if (on) {
        void preloadNamespaces(on);
    }
    return serverLoader<typeof loader>();
}

// The range and filters only pick what the page shows: no server round trip.
export const shouldRevalidate = revalidateOn({
    params: ['section'],
    search: false,
});

function OperationsPage({ section }: { section: OpsSection }) {
    return (
        <OperationsLayout section={useSectionHeading(section)}>
            <OpsSectionPage id={section.id} />
        </OperationsLayout>
    );
}

export default function OperationsRoute() {
    const { section: id } = useParams();
    const section = findOpsSection(id);
    const on = useFlags()?.on;
    if (!section || (section.flag && on && !on.includes(section.flag))) {
        return <Navigate to={OPS_HOME} replace />;
    }
    return <OperationsPage section={section} />;
}
