import { compareText } from '@socio/shared/locale';

import type { ContainerSkills } from '../sync/skills';

// Learning, "Skills" for members:
// the published skills from the `skills` kind, as the web's PublishedSkillList
// shows them, with no React Native: tests/shell runs it under Node. Admins
// review proposals on the web (a "Review in your browser" row through
// useOpenLink); the phone only reads.

/** The page's heading line, by role (the web's LearningPage). */
export const learningIntro = (admin: boolean): string =>
    admin
        ? 'Proposals come from the team’s finished conversations. Nothing reaches a socio until you publish it.'
        : 'Procedures your socios have learned, reviewed by an admin.';
export const SKILLS_HEADING = 'Published skills';
export const SKILLS_LINE = 'Reviewed procedures your socios can load. Admins choose what is published.';
export const REVIEW_ON_WEB = 'Review what your socios are learning';
export const LEARNING_HREF = '/learning';

export interface SkillRow {
    readonly key: string;
    readonly name: string;
    readonly container: string;
    readonly description: string;
}

/**
 * Every container's skills as one list, as the web flattens them. The
 * collection keeps no order, so by container, then name.
 */
export function skillRows(containers: readonly ContainerSkills[]): SkillRow[] {
    return [...containers]
        .sort((a, b) => compareText(a.containerId, b.containerId))
        .flatMap((container) =>
            [...container.skills]
                .sort((a, b) => compareText(a.name, b.name))
                .map((skill) => ({
                    key: `${container.containerId}/${skill.name}`,
                    name: skill.name,
                    container: container.containerId,
                    description: skill.description,
                })),
        );
}

/** What an empty list says: the web's "Loading…" until the first answer, then "No skills yet." */
export const skillsEmpty = (loaded: boolean): string => (loaded ? 'No skills yet.' : 'Loading…');
