import type { MouseEventHandler } from 'react';
import { Link } from 'react-router';

import { upstreamIssueLink } from '@socio/shared/updates/upstream';

/** This app's origin; none while rendering on the server. */
export const appOrigin = () => globalThis.location?.origin;

/**
 * An upstream issue key ("CB-157") from the release notes, What's New or an
 * early-access flag (CB-381): a link to Socio's own board, opened in a new
 * tab, or the local issue on that instance itself. Anything that isn't a key
 * shows as plain text.
 */
export function UpstreamIssueLink({
    issue,
    className,
    slot,
    onClick,
    origin = appOrigin(),
}: {
    issue: string;
    className?: string;
    slot?: string;
    onClick?: MouseEventHandler<HTMLAnchorElement>;
    /** For tests; the app's own origin otherwise. */
    origin?: string;
}) {
    const link = upstreamIssueLink(issue, origin);
    if (!link) {
        return (
            <span className={className} data-slot={slot}>
                {issue}
            </span>
        );
    }
    if (link.external) {
        return (
            <a
                href={link.href}
                target="_blank"
                rel="noopener noreferrer"
                className={className}
                data-slot={slot}
                onClick={onClick}
            >
                {issue}
            </a>
        );
    }
    return (
        <Link to={link.href} className={className} data-slot={slot} onClick={onClick}>
            {issue}
        </Link>
    );
}
