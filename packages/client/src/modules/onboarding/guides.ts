import type { GuideId } from '@socio/shared/onboarding';
import { isAdmin, isOperator } from '@socio/shared/roles';

import { canUse } from '../derive';
import type { ClientModule, ModuleContext } from '../types';

export interface GuideStep {
    id: string;
    title: string;
    text: string;
    article: string;
    target?: string;
    path?: string;
    /** Only display guidance for a feature this person can actually use. */
    module?: string;
}
export interface Guide {
    id: GuideId;
    title: string;
    description: string;
    steps: GuideStep[];
}
const step = (id: string, title: string, text: string, article: string, rest: Partial<GuideStep> = {}): GuideStep => ({
    id,
    title,
    text,
    article: '/docs/' + article,
    ...rest,
});

/** Authored product guidance only: no user content becomes popover HTML. */
export function availableGuides(context: ModuleContext, modules: readonly ClientModule[]): Guide[] {
    const { workspace, configured } = context;
    const socio = workspace.dots.find((d) => !d.archivedAt);
    const space = workspace.spaces[0];
    const spacesPath = space ? `/spaces/${encodeURIComponent(space.id)}` : '/spaces';
    const guides: Guide[] = [
        {
            id: 'getting-started',
            title: 'Getting started',
            description: 'Your socios, a first conversation, shared pages and approvals.',
            steps: [
                step(
                    'welcome',
                    'Welcome to Socio',
                    'This optional guide explains the controls. Nothing is sent, created, saved or approved for you. Close it at any time; Help lets you return or restart.',
                    'getting-started',
                    { path: '/', target: '[data-tour="home"]' },
                ),
                ...(socio
                    ? [
                          step(
                              'choose-socio',
                              'Choose a socio',
                              'Open a socio to see its conversations and plans. Each has its own instructions. Choose one that fits your task.',
                              'socios',
                              { path: '/', target: '[data-tour="socios"]', module: 'chat' },
                          ),
                      ]
                    : []),
                ...(socio && configured
                    ? [
                          step(
                              'first-conversation',
                              'Start with a conversation',
                              'Write a request here, then choose Send when you are ready. The guide never writes or sends a message. You can keep a draft without sending it.',
                              'chats',
                              {
                                  path: `/dots/${encodeURIComponent(socio.id)}/new`,
                                  target: '[data-tour="new-chat-composer"]',
                                  module: 'chat',
                              },
                          ),
                      ]
                    : []),
                step(
                    'privacy',
                    'Personal and workspace content',
                    'A personal socio and its conversations belong to you. A workspace socio is shared. Pages in Spaces are shared with the workspace; check where you are writing before sharing sensitive information.',
                    'privacy',
                    { path: '/', target: '[data-tour="socios"]' },
                ),
                step(
                    'spaces',
                    'Find Spaces and pages',
                    'Spaces organize the team’s shared pages. Open an existing page to read or edit it. Search finds pages without asking a socio.',
                    'spaces',
                    {
                        path: spacesPath,
                        target: '[data-tour="space-library"]',
                        module: 'spaces',
                    },
                ),
                step(
                    'create-page',
                    'Create a page when you need one',
                    'New page creates a shared page in this Space when you choose it. You can also open a page to edit. The guide does not press this button or create a sample page.',
                    'pages',
                    {
                        path: spacesPath,
                        target: '[data-tour="new-page"]',
                        module: 'spaces',
                    },
                ),
                step(
                    'edit-page',
                    'Write and review your page',
                    'On an open page, edit the title and content, then save when you decide it is ready. Unsaved changes keep their normal navigation warning. Open a page yourself to try this control.',
                    'pages',
                    { target: '[data-tour="page-document"]', module: 'spaces' },
                ),
                step(
                    'page-conversation',
                    'Talk about this page',
                    'The page conversation keeps a focused discussion alongside the document. Choose its specialist and type your request yourself. Suggestions still need the normal review and save actions.',
                    'page-conversations',
                    { target: '[data-tour="page-conversation"]', module: 'spaces' },
                ),
                step(
                    'approvals',
                    'You decide about actions',
                    'Approvals shows requests from your socios and their outcomes. Review what an action will do before approving it. This guide never makes that decision for you.',
                    'approvals',
                    {
                        path: '/approvals',
                        target: '[data-tour="approval-requests"]',
                        module: 'approvals',
                    },
                ),
                step(
                    'read-more',
                    'Help is always here',
                    'Read More opens the relevant article in a separate tab and leaves this step in place. Help also offers focused guides, Continue, and an explicit Restart.',
                    'getting-started',
                    { path: '/', target: '[data-tour="help"]' },
                ),
            ],
        },
        {
            id: 'goals-schedules',
            title: 'Goals and schedules',
            description: 'Plan ongoing work and understand recurring tasks.',
            steps: [
                step(
                    'goals',
                    'Goals describe the outcome',
                    'Goals keep the result you want visible, with its current progress. Review existing goals here; decide yourself whether to ask a socio to start new work.',
                    'goals',
                    {
                        path: '/schedules',
                        target: '[data-slot="goal-list"]',
                        module: 'schedules',
                    },
                ),
                step(
                    'schedules',
                    'Schedules repeat work',
                    'Schedules run a conversation or job at its configured time. Check the timing and time zone, and review the next run before enabling one.',
                    'schedules',
                    {
                        path: '/schedules',
                        target: '[data-tour="schedules-card"]',
                        module: 'schedules',
                    },
                ),
                step(
                    'scheduled-approvals',
                    'Scheduled work still has boundaries',
                    'The normal capability and approval rules still apply. Review requests in Approvals; the guide never enables a schedule, runs a job or approves an action.',
                    'approvals',
                    {
                        path: '/approvals',
                        target: '[data-tour="approval-requests"]',
                        module: 'approvals',
                    },
                ),
            ],
        },
        {
            id: 'improvements',
            title: 'The Improvements board',
            description: 'Find reports, follow progress and contribute useful details.',
            steps: [
                step(
                    'board',
                    'Find an improvement',
                    'The board tracks bugs, ideas and their status. Search first so you can add useful detail to an existing report rather than filing a duplicate.',
                    'improvements',
                    {
                        path: '/issues',
                        target: '[data-tour="issue-views"]',
                        module: 'issues',
                    },
                ),
                step(
                    'report',
                    'Describe a useful report',
                    'Explain what you tried, what happened and what you expected. Include a small reproduction when possible. You choose whether to file; this guide never submits a report.',
                    'improvements',
                    {
                        path: '/issues',
                        target: '[data-tour="issue-create"]',
                        module: 'issues',
                    },
                ),
                step(
                    'follow',
                    'Follow the work',
                    'Open an item to read its discussion, dependencies and recorded history. A status or a vote is not proof that a change has shipped.',
                    'improvements',
                    {
                        path: '/issues',
                        target: '[data-slot="issue-card"]',
                        module: 'issues',
                    },
                ),
            ],
        },
    ];
    if (isAdmin(workspace.user)) {
        guides.push({
            id: 'administration',
            title: 'Admin guide',
            description: 'Socios, service accounts, connections, settings and Learning.',
            steps: [
                step(
                    'admin-socios',
                    'Manage socios deliberately',
                    'Review instructions, access and sharing. A private socio’s conversation access remains separate from administrative settings access.',
                    'admin/socios',
                    {
                        path: '/admin/dots',
                        target: '[data-slot="admin-dots"]',
                        module: 'dots',
                    },
                ),
                step(
                    'service-accounts',
                    'Scope service accounts',
                    'Give integrations only the access they need. Treat issued keys as secrets and revoke keys that are no longer used.',
                    'admin/service-accounts',
                    {
                        path: '/settings/people?tab=service-accounts',
                        target: '[data-slot="service-accounts"]',
                    },
                ),
                step(
                    'admin-connections',
                    'Understand connected agents',
                    'A connected agent acts for the person who approved it, within its grant. Review connection and revocation behavior; never share another person’s credential.',
                    'admin/connected-agents',
                    {
                        path: '/settings/connected-agents',
                        target: '[data-slot="connected-agents"]',
                    },
                ),
                step(
                    'admin-settings',
                    'Review workspace settings',
                    'Workspace settings change how the team uses Socio. Read the effect of each setting and save only a change you intend.',
                    'admin/settings',
                    {
                        path: '/settings/workspace',
                        target: '[data-slot="workspace-permissions"]',
                    },
                ),
                step(
                    'learning',
                    'Review before publishing',
                    'Learning proposals are reviewed before they become shared skills. Read the proposal and evidence; this guide never accepts or publishes one.',
                    'admin/learning',
                    {
                        path: '/learning',
                        target: '[data-slot="learning-page"]',
                        module: 'learning',
                    },
                ),
            ],
        });
    }
    if (isOperator(workspace.user)) {
        guides.push({
            id: 'operations',
            title: 'Running Socio',
            description: 'Deployment, secrets, upgrades, backups and storage.',
            steps: [
                step(
                    'deployment',
                    'Know the deployment boundary',
                    'Platform shows the configuration admins may manage. Infrastructure deployment belongs to the reviewed operational workflow, not a tour action.',
                    'operate/deployment',
                    {
                        path: '/settings/operator',
                        target: '[data-tour="workspace-view"]',
                        module: 'operator',
                    },
                ),
                step(
                    'secrets',
                    'Handle secrets outside the guide',
                    'Use the documented secret-management workflow. Do not put credentials into chat messages, shared pages, screenshots or tour state.',
                    'operate/secrets',
                    {
                        path: '/settings/operator',
                        target: '[data-tour="workspace-view"]',
                        module: 'operator',
                    },
                ),
                step(
                    'upgrades',
                    'Verify an upgrade',
                    'Review the exact release, compatibility and health gates. An accepted update request is not a verified deployment.',
                    'operate/upgrades',
                    {
                        path: '/settings/operator',
                        target: '[data-tour="workspace-view"]',
                        module: 'operator',
                    },
                ),
                step(
                    'backups',
                    'Prove backup and restore readiness',
                    'Check the documented database and userdata backup procedure and its offsite and restore evidence before a risky change.',
                    'operate/backups',
                    {
                        path: '/settings/operator',
                        target: '[data-tour="workspace-view"]',
                        module: 'operator',
                    },
                ),
                step(
                    'storage',
                    'Preserve the data boundary',
                    'Understand the configured storage driver, volumes and ownership. Follow the storage guide before moving persistent data.',
                    'operate/storage',
                    {
                        path: '/settings/operator',
                        target: '[data-tour="workspace-view"]',
                        module: 'operator',
                    },
                ),
            ],
        });
    }
    return guides
        .map((guide) => ({
            ...guide,
            steps: guide.steps.filter((s) => !s.module || modules.some((m) => m.id === s.module && canUse(m, context))),
        }))
        .filter((g) => g.steps.length > 0 && (g.id !== 'goals-schedules' || configured));
}
