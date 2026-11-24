import type { PostStatus, ReplyStatus } from '@socio/shared/planner';
import type { ThreadPart } from '@socio/shared/x-post';

export interface PlannerPost {
    id: string;
    status: PostStatus;
    account: string;
    plannedAt: number;
    topic: string;
    notes: string;
    parts: ThreadPart[];
}

export interface PlannerReply {
    id: string;
    sourceUrl: string;
    sourceId: string;
    author: string;
    excerpt: string;
    why: string;
    draft: string;
    status: ReplyStatus;
}

export interface PlannerPage {
    view: 'week' | 'month' | 'grid' | 'replies';
    now: number;
    posts: PlannerPost[];
    replies: PlannerReply[];
    voice: string;
    parentOrigin: string;
    editing?: PlannerPost;
    notice?: string;
}

const escape = (text: string) =>
    text.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

/**
 * The planner document. The interface is the Socio client bundle at
 * `/ui/planner.js`; this shell only hands it the plan and the parent origin.
 */
export function renderPlanner(page: PlannerPage) {
    const state = JSON.stringify({
        posts: page.posts,
        replies: page.replies,
        voice: { notes: page.voice },
        now: page.now,
    }).replace(/</g, '\\u003c');
    const view = page.view === 'week' ? '' : `?view=${page.view}`;
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="socio-parent" content="${escape(page.parentOrigin)}"><title>Social strategy</title><link rel="stylesheet" href="/ui/planner.css"></head><body><div id="root"><p>The planner interface did not load.</p></div><script type="application/json" id="planner-state">${state}</script><script type="module" src="/ui/planner.js"></script></body></html><!-- ${view} -->`;
}
