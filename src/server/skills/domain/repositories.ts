import type { SkillProvenance, WorkspaceSkill } from '../contract.js';

/**
 * Chat skills' repositories (CB-110): the workspace's own skills
 * with their revisions, and the skill each person has on in each chat. Only
 * `skills/infra` implements them; each write works inside or outside a unit
 * of work: outside one it opens its own. Their types are in the contract;
 * these are the helpers around them.
 */

/** Provenance belongs to each immutable revision, including rollback targets. */
export function provenanceOf(
    skill: Pick<
        WorkspaceSkill,
        'source' | 'sourceUrl' | 'sourcePath' | 'sourceRef' | 'sourceCommit' | 'sourceMetadata'
    >,
): SkillProvenance | undefined {
    if (
        skill.source !== 'git' ||
        !skill.sourceUrl ||
        !skill.sourcePath ||
        !skill.sourceRef ||
        !skill.sourceCommit ||
        !skill.sourceMetadata
    ) {
        return undefined;
    }
    const metadata = JSON.parse(skill.sourceMetadata) as Pick<
        SkillProvenance,
        'sha256' | 'license' | 'licenseText' | 'locallyModified'
    >;
    return {
        url: skill.sourceUrl,
        path: skill.sourcePath,
        ref: skill.sourceRef,
        commit: skill.sourceCommit,
        ...metadata,
    };
}
/** Compares two revisions' provenance: '' when there is none. */
export const provenanceKey = (source?: SkillProvenance) =>
    source
        ? JSON.stringify([
              source.url,
              source.path,
              source.ref,
              source.commit,
              source.sha256,
              source.license,
              source.licenseText,
              !!source.locallyModified,
          ])
        : '';
