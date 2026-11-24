import { Navigate, redirect, useParams, type LoaderFunctionArgs } from 'react-router';

import { revalidateOn } from '../../lib/page-loader';
import { useFlags } from '../../shell/flags';
import type { RouteHandle } from '../../shell/shell-context';

import { OperationsLayout } from './OperationsLayout';
import { OpsSectionPage } from './OpsSectionPage';
import { findOpsSection, OPS_HOME } from './sections';

export const handle: RouteHandle = {
    crumb: ({ params }) => {
        const section = findOpsSection(params.section);
        return params.section && section
            ? [{ label: 'Operations', to: OPS_HOME }, { label: section.label }]
            : [{ label: 'Operations' }];
    },
};

/**
 * `/operations` (Overview) and `/operations/:section`: an unknown section
 * goes to Overview. Who may open them is the module gate's (admins).
 */
export function loader({ params }: LoaderFunctionArgs) {
    if (!findOpsSection(params.section)) {
        throw redirect(OPS_HOME);
    }
    return null;
}
// The range and filters only pick what the page shows: no server round trip.
export const shouldRevalidate = revalidateOn({
    params: ['section'],
    search: false,
});

export default function OperationsRoute() {
    const { section: id } = useParams();
    const section = findOpsSection(id);
    const on = useFlags()?.on;
    if (!section || (section.flag && on && !on.includes(section.flag))) {
        return <Navigate to={OPS_HOME} replace />;
    }
    return (
        <OperationsLayout section={section}>
            <OpsSectionPage id={section.id} />
        </OperationsLayout>
    );
}
