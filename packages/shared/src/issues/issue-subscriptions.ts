import type { IssueStatus } from './issue-types.js';

export const ISSUE_WATCH_STATES = ['watching', 'ready', 'triggered', 'cancelled'] as const;
export type IssueWatchState = (typeof ISSUE_WATCH_STATES)[number];
export interface IssueWatchView {
    id: string;
    issues: string[];
    targetStatus: IssueStatus;
    state: IssueWatchState;
    createdAt: string;
    triggeredAt: string | null;
    cancelledAt: string | null;
    cancelReason: 'unsubscribed' | 'issue_unavailable' | 'person_unavailable' | null;
}
export interface IssueWatchList {
    items: IssueWatchView[];
    next: number | null;
}
