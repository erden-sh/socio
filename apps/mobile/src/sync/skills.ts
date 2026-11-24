import type { PublishedSkills } from '@socio/shared/learning';

import type { SnapshotDefinition } from './snapshot-cache';
import { keyed, list } from './snapshot-shape';

// The skills kind: what
// everyone's socios can load, as Learning shows a member (the web's
// PublishedSkillList), `GET /api/learning/skills`
// (src/server/learning/learning-routes.ts), the shape packages/shared's
// PublishedSkills: one entry per learning container.
// - `skills` holds each container's published skills, by container id,
//   unversioned.
// The path sends no ETag, so the source keeps a hash of the body in its place
// (`hashBody`, snapshot-source.ts): an unchanged body applies nothing. The web
// reads it once as the page opens, with no poll; so does Learning here, on its
// view when the last answer is older than 5 s.

export const SKILLS = 'skills';

/** One container's published skills, as its row holds them. */
export type ContainerSkills = PublishedSkills[number];

const SKILLS_PATH = '/api/learning/skills';

/** `GET /api/learning/skills`: each container's published skills, by container id. */
export const SKILLS_SNAPSHOT: SnapshotDefinition = {
    id: 'skills',
    path: SKILLS_PATH,
    format: 1,
    hashBody: true,
    feeds: [{ collection: SKILLS }],
    split(body) {
        return [keyed(SKILLS_PATH, list(SKILLS_PATH, body, 'the body'), 'containers', { key: 'containerId' })];
    },
};

/** A container's row as its collection holds it. */
export const skillsRow = (_key: string, value: unknown): ContainerSkills => value as ContainerSkills;
