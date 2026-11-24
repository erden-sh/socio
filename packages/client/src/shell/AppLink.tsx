import type { ReactNode } from 'react';

import { openAppPath, resolveLink } from '../modules/pages/page-navigation';

/**
 * A Markdown link in chat: an app route opens in the app on a plain click
 * (modified clicks are left to the browser, e.g. Cmd/Ctrl+click for a new
 * tab); an external URL opens in a new tab; anything else is plain text.
 * Old hash links (`/#/spaces/…`) render with their path form.
 */
export function AppLink({
    href,
    children,
    className,
    slot,
    title,
    state,
}: {
    href?: string;
    children?: ReactNode;
    /** For an app route's link (chat's issue cards). */
    className?: string;
    slot?: string;
    title?: string;
    /** Navigation state for the route it opens (an issue from chat: CB-119). */
    state?: unknown;
}) {
    const target = resolveLink(href);
    if (!target) {
        return <span>{children}</span>;
    }
    if (target.kind === 'external') {
        return (
            <a href={target.url} target="_blank" rel="noopener noreferrer">
                {children}
            </a>
        );
    }
    return (
        <a
            href={target.path}
            className={className}
            data-slot={slot}
            title={title}
            onClick={(event) => {
                if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
                    return;
                }
                event.preventDefault();
                openAppPath(target.path, state);
            }}
        >
            {children}
        </a>
    );
}
