import { Bug, CircleDot, ListTodo } from 'lucide-react';

import { issuePath } from '@socio/shared/issues/issue-board';
import { issueKey, type IssueTitle } from '@socio/shared/issues/issue-types';
import { MODULE_IDS } from '@socio/shared/modules';

import { api } from '../../lib/api';
import type { ClientModule, PaletteCommand } from '../types';

import { DotFilings } from './DotFilings';
import { DotRequestNotices } from './DotRequestNotices';
import { FileIssueFromRun } from './FileIssueFromRun';
import { OpenIssuesWidget } from './OpenIssuesWidget';
import { openReport } from './report';
import { ReportIssue, ReportIssueItem, ReportIssueMenuItem } from './ReportIssue';

/** Issues: the team's tracker, a board and a list, with issue detail. */
export const issuesModule: ClientModule = {
    id: MODULE_IDS.issues,
    title: 'Issues',
    description: 'The team’s issue tracker: bugs, ideas and their status.',
    icon: ListTodo,
    tone: 'orange',
    order: 60,
    opens: { path: '/issues' },
    sidebar: 'workspace',
    slots: {
        'header.actions': [ReportIssue, DotRequestNotices],
        'header.menu': [ReportIssueMenuItem],
        'account.items': [ReportIssueItem],
        'run.actions': [FileIssueFromRun],
        'home.widgets': [OpenIssuesWidget],
        'dot.past': [DotFilings],
    },
    commands: () => [
        {
            id: 'issues:new',
            label: 'File an issue',
            group: 'Actions',
            keywords: ['report', 'bug', 'new', 'issue', 'feedback'],
            icon: Bug,
            run: () => openReport(),
        },
    ],
    // Issues by key or title, fetched (titles only) when the palette opens.
    loadCommands: async (_context, signal) => {
        const issues = await api<IssueTitle[]>('/issues/titles', 'GET', undefined, signal);
        return issues.map((issue): PaletteCommand => ({
            id: `issue:${issue.number}`,
            label: issue.title,
            group: 'Issues',
            hint: issueKey(issue.number),
            keywords: [issueKey(issue.number), issue.status.replace('_', ' ')],
            icon: CircleDot,
            searchOnly: true,
            run: ({ navigate }) => navigate(issuePath(issue.number)),
        }));
    },
};
