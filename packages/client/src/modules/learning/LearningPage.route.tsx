import { useLoaderData, type LoaderFunctionArgs } from 'react-router';

import { isAdmin } from '@socio/shared/roles';

import { revalidateOn } from '../../lib/page-loader';
import { web } from '../../lib/web-context';

import { LearningPage } from './LearningPage';
import type { LearningSeed } from './LearningView';

/**
 * The page's first screen: for admins, the containers and the first one's
 * runs and first page of proposals (without their bodies, which a
 * proposal's review reads; "Load more" reads the next pages); for members,
 * the published skills. Analyzes stay in the browser.
 */
export async function loader({ context }: LoaderFunctionArgs): Promise<LearningSeed | null> {
    const { services } = web(context);
    const user = await services.user();
    if (!user) {
        return null;
    }
    if (!isAdmin(user)) {
        const skills = await services.learningSkills();
        return skills && { admin: false, skills };
    }
    const containers = await services.learningContainers();
    if (!containers) {
        return null;
    }
    const first = containers[0];
    return {
        admin: true,
        containers,
        open: first ? await services.learningContainer(first.id) : null,
    };
}
export const shouldRevalidate = revalidateOn({ polled: true });

export default function LearningRoute() {
    const initial = useLoaderData<typeof loader>();
    return <LearningPage initial={initial ?? undefined} />;
}
