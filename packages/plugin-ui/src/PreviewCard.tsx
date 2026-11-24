import { Heart, MessageCircle, Repeat2, Share } from 'lucide-react';
/**
 * Preview card frame adapted from vercel/react-tweet (MIT),
 * packages/react-tweet/src/twitter-theme (tweet header, body, actions).
 * Copyright (c) Vercel, Inc. The card is a picture. It does not publish.
 */
import type { ReactNode } from 'react';

export function PreviewCard({
    name,
    handle,
    initial,
    time,
    thread,
    children,
}: {
    name: string;
    handle: string;
    initial?: string;
    time: string;
    thread?: boolean;
    children: ReactNode;
}) {
    const mark = initial || name.slice(0, 1).toUpperCase() || '?';
    return (
        <article className="tweet-card" data-theme="x">
            {thread && <span className="tweet-thread" aria-hidden />}
            <div className="tweet-head">
                <div className="tweet-avatar" aria-hidden>
                    {mark}
                </div>
                <div className="min-w-0">
                    <div className="tweet-name">{name}</div>
                    <div className="tweet-handle">{handle}</div>
                </div>
            </div>
            {children}
            <div className="tweet-time">{time}</div>
            <div className="tweet-actions" aria-hidden>
                <span>
                    <MessageCircle />
                </span>
                <span>
                    <Repeat2 />
                </span>
                <span>
                    <Heart />
                </span>
                <span>
                    <Share />
                </span>
            </div>
        </article>
    );
}
