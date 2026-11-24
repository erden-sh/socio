import { z } from 'zod';

import {
    PROPOSAL_PAGE,
    type LearningContainerDetail,
    type LearningContainerSummary,
    type LearningProposalPage,
    type LearningSkillView,
    type PublishedSkills,
} from '@socio/shared/learning';

import type { SociosShape } from '../workspace/contract.js';

import type { EvidenceShape, LearningShape, LearningViewsShape, ProposalKey, SkillsShape } from './contract.js';

/**
 * Learning's views, moved from the now-deleted `live/views/learning.ts`
 * (the pages read them through `LearningViews`). Each reads its sources
 * when it is called.
 */

/** What the views read: the analysis, the evidence, the published skills and the socios. */
export interface LearningViewSources {
    readonly learning: Pick<
        LearningShape,
        'configured' | 'running' | 'runs' | 'proposalPage' | 'proposalCount' | 'seamTriage'
    >;
    readonly evidence: Pick<EvidenceShape, 'containers' | 'count' | 'analyzedThrough'>;
    readonly skills: Pick<SkillsShape, 'containers' | 'published' | 'latest' | 'current' | 'pinned'>;
    readonly socios: Pick<SociosShape, 'dots'>;
}

/** Every learning container: set on a Dot, with evidence, or published to. */
export function learningContainers(sources: Pick<LearningViewSources, 'evidence' | 'skills' | 'socios'>) {
    return [
        ...new Set([
            ...sources.socios
                .dots()
                .map((dot) => dot.learningContainerId)
                .filter((id): id is string => !!id),
            ...sources.evidence.containers(),
            ...sources.skills.containers(),
        ]),
    ].sort();
}

const publishedSkills = (sources: Pick<LearningViewSources, 'skills'>, id: string): LearningSkillView[] =>
    sources.skills.published(id).map((skill) => ({
        name: skill.name,
        description: skill.description,
        revision: skill.revision,
        revisionId: skill.id,
    }));

/** `GET /api/learning/skills`: everyone's published skills, by container. */
export function publishedSkillsView(
    sources: Pick<LearningViewSources, 'evidence' | 'skills' | 'socios'>,
): PublishedSkills {
    return learningContainers(sources).map((id) => ({
        containerId: id,
        skills: publishedSkills(sources, id),
    }));
}

/** `GET /api/learning/containers` (admins): each container's state. */
export function learningContainersView(sources: LearningViewSources): LearningContainerSummary[] {
    const { socios, evidence, learning } = sources;
    const dots = socios.dots();
    return learningContainers(sources).map((id) => ({
        id,
        dots: dots
            .filter((dot) => dot.learningContainerId === id)
            .map((dot) => ({
                id: dot.id,
                name: dot.name,
                delivery: !!dot.skillDeliveryEnabled,
            })),
        newEvidence: evidence.count(id),
        pendingProposals: learning.proposalCount(id, 'pending'),
        published: publishedSkills(sources, id).length,
        running: learning.running(id),
        lastRun: learning.runs(id, 1)[0] ?? null,
    }));
}

/** A proposal cursor: base64url of `[createdAt, id]`, the page's last one. */
const proposalCursor = z
    .string()
    .max(200)
    .transform((value, ctx): ProposalKey => {
        try {
            const [createdAt, id] = z
                .tuple([z.number().int().nonnegative(), z.string().min(1).max(64)])
                .parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')));
            return { createdAt, id };
        } catch {
            ctx.addIssue({ code: 'custom', message: 'Invalid cursor.' });
            return z.NEVER;
        }
    });
const cursorOf = (key: ProposalKey) => Buffer.from(JSON.stringify([key.createdAt, key.id])).toString('base64url');
/** Reads `?cursor=`; undefined when it is not one this server gave out. */
export function parseProposalCursor(value: string) {
    return proposalCursor.safeParse(value).data;
}

/**
 * `GET /api/learning/containers/:id/proposals?limit=&cursor=` (admins): a
 * page of the container's proposals, newest first (createdAt, then id),
 * after `cursor`. `bodies: false` as in learningContainerView.
 */
export function learningProposalsView(
    sources: Pick<LearningViewSources, 'learning'>,
    id: string,
    { limit = PROPOSAL_PAGE, after, bodies = true }: { limit?: number; after?: ProposalKey; bodies?: boolean } = {},
): LearningProposalPage {
    const page = sources.learning.proposalPage(id, { limit, after });
    return {
        items: page.items.map((proposal) =>
            bodies ? proposal : (({ skillMd: _, rationale: __, ...rest }) => rest)(proposal),
        ),
        ...(page.next ? { nextCursor: cursorOf(page.next) } : {}),
    };
}

/**
 * `GET /api/learning/containers/:id` (admins): runs, the first page of
 * proposals, what is published and delivered, and Learning's triage on
 * the classification seam (CB-200). `bodies: false`
 * (`?bodies=false`) leaves out each proposal's SKILL.md and rationale: the
 * list doesn't show them, and a proposal's own review reads them.
 */
export async function learningContainerView(
    sources: Pick<LearningViewSources, 'learning' | 'evidence' | 'skills'>,
    id: string,
    { bodies = true }: { bodies?: boolean } = {},
): Promise<LearningContainerDetail> {
    const { evidence, skills, learning } = sources;
    const latest = skills.latest(id);
    const proposals = learningProposalsView(sources, id, { bodies });
    return {
        id,
        newEvidence: evidence.count(id),
        running: learning.running(id),
        configured: await learning.configured(),
        runs: learning.runs(id),
        proposals: proposals.items,
        ...(proposals.nextCursor ? { proposalsCursor: proposals.nextCursor } : {}),
        published: publishedSkills(sources, id),
        revision: latest?.revision ?? 0,
        pinned: skills.pinned(id) ?? null,
        delivered: skills.current(id)?.revision ?? 0,
        // Learning on the classification seam (CB-200): its state, and this
        // container's conversations with their triage.
        triage: (await learning.seamTriage()?.view(id, evidence.analyzedThrough(id))) ?? null,
    };
}

/** Every view over the same sources, as the `LearningViews` tag offers them. */
export function learningViews(sources: LearningViewSources): LearningViewsShape {
    return {
        containerIds: () => learningContainers(sources),
        publishedSkills: () => publishedSkillsView(sources),
        containers: () => learningContainersView(sources),
        container: (id, options) => learningContainerView(sources, id, options),
        proposals: (id, options) => learningProposalsView(sources, id, options),
        parseProposalCursor,
    };
}
