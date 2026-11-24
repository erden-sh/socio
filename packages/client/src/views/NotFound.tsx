import type { ReactNode } from 'react';
import { Link } from 'react-router';

import { plainHover } from '../lib/plain-button';
import { Mascot } from '../locals/Mascot';

import { cn } from '@/lib/utils';

/** Unknown URLs, and links to a Dot, chat or Space this user can't see. */
export function NotFound({ what = 'Page' }: { what?: string }) {
    return (
        <EmptyPage role="status" title={<>{what} not found.</>}>
            <p>It may have been removed, or it isn&apos;t shared with you.</p>
            <Link className={emptyAction} to="/">
                Back to your socios
            </Link>
        </EmptyPage>
    );
}

/** The quiet link or button under an empty page's message. */
export const emptyAction = cn(
    'gap-[5px] border-0 bg-transparent p-0 text-[10px] text-[#9296a7] dark:text-[#9da1b2]',
    plainHover,
);

/**
 * A page with nothing to show (NotFound, RouteError): the mascot, a
 * heading and a line or two, in the page frame.
 */
export function EmptyPage({
    role,
    title,
    children,
}: {
    role: 'status' | 'alert';
    title: ReactNode;
    children: ReactNode;
}) {
    return (
        <main className="main-content">
            <div
                className="mx-auto my-15 max-w-110 text-center max-[700px]:mt-7.5 [&_p]:text-[12px] [&_p]:leading-[1.9] [&_p]:text-[#999ba5] dark:[&_p]:text-[#9fa1ab]"
                role={role}
            >
                <Mascot className="size-35 opacity-85" />
                <h2 className="text-[22px]">{title}</h2>
                {children}
            </div>
        </main>
    );
}
