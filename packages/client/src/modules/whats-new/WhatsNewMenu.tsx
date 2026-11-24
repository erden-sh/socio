import { ArrowRight } from 'lucide-react';
import { useContext } from 'react';
import { Link } from 'react-router';

import { FLAGS } from '@socio/shared/flags';
import { isAdmin } from '@socio/shared/roles';

import { ShellContext } from '../../shell/shell-context';

import { PluginReleaseCards } from './PluginReleaseCard';
import { ReleaseFeed } from './ReleaseFeed';
import { usePluginReleaseNotes } from './use-plugin-release-notes';
import { useWhatsNew } from './use-whats-new';

/** The quiet "All releases" link under the cards. */
export const allReleasesLink =
    'inline-flex items-center gap-1 rounded text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50';

/**
 * What's new in the header (CB-166), opened from the Help menu (CB-308):
 * a card per installed plugin the person may open (CB-527), the releases,
 * more loading as they scroll, then All releases and, for
 * admins, Settings → Early access. The caller's popover gives it its frame
 * and marks the newest as seen when it opens; `titleId` labels it.
 */
export function WhatsNewPanel({ titleId, onClose }: { titleId: string; onClose: () => void }) {
    const { releases, loading } = useWhatsNew();
    const { plugins } = usePluginReleaseNotes();
    // CB-503: admins decide early access for the workspace, on Settings →
    // Early access; no one turns it on for themselves, so only they get the link.
    const admin = isAdmin(useContext(ShellContext)?.workspace?.user);
    const earlyAccess = FLAGS.filter((flag) => flag.stage === 'early-access').length;
    return (
        <>
            <h2 id={titleId} className="border-b px-3 py-2.5 text-sm font-medium">
                What’s new
            </h2>
            <div
                data-slot="whats-new-list"
                className="max-h-[min(26rem,calc(var(--radix-popover-content-available-height)-6rem))] overflow-y-auto overscroll-contain p-2"
            >
                {/* CB-527: a card per plugin the person may open, before the
                    workspace's releases, which keep loading as they scroll. */}
                <PluginReleaseCards className="mb-2" />
                {releases.length || loading ? (
                    <ReleaseFeed onOpen={onClose} />
                ) : (
                    !plugins.length && (
                        <p className="px-1 py-2 text-sm text-muted-foreground">No release notes to show right now.</p>
                    )
                )}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 border-t px-3 py-2">
                <Link to="/releases" className={allReleasesLink} onClick={onClose}>
                    All releases
                    <ArrowRight className="size-3.5" />
                </Link>
                {admin && earlyAccess > 0 && (
                    <Link
                        to="/settings/early-access"
                        data-slot="whats-new-early-access"
                        className={allReleasesLink}
                        onClick={onClose}
                    >
                        Early access ({earlyAccess})
                        <ArrowRight className="size-3.5" />
                    </Link>
                )}
            </div>
        </>
    );
}
