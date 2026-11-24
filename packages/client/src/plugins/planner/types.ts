import type { PostStatus, ReplyStatus } from '@socio/shared/planner';
import type { ThreadPart } from '@socio/shared/x-post';

export interface PlannedPost {
    id: string;
    status: PostStatus;
    account: string;
    plannedAt: number;
    topic: string;
    notes: string;
    parts: ThreadPart[];
}

export interface ReplyItem {
    id: string;
    sourceUrl: string;
    sourceId: string;
    author: string;
    excerpt: string;
    why: string;
    draft: string;
    status: ReplyStatus;
}

export interface PlannerState {
    posts: PlannedPost[];
    replies: ReplyItem[];
    voice: { notes: string };
    now: number;
}

export type PlannerView = 'week' | 'month' | 'agenda' | 'grid' | 'replies';

export type { BadgeVariant } from '@socio/plugin-ui';

export interface PostDraft {
    id?: string;
    account: string;
    plannedLocal: string;
    status: PostStatus;
    topic: string;
    notes: string;
    parts: { text: string; xId: string }[];
}
