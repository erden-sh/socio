import { Lock } from 'lucide-react';

import { cn } from '@/lib/utils';

/** What a private Space covers (CB-181), the words every control uses. */
export const PRIVATE_SPACE_COVERS =
    'its pages and their history, page chats, search results, apps, datasets and files shared with it, and its memory';

/**
 * A private Space's lock (CB-181): only its people (and workspace admins)
 * see it. Named for screen readers; a tooltip says the same.
 */
export function PrivateSpaceIcon({ className }: { className?: string }) {
    return (
        <Lock
            role="img"
            aria-label="Private Space"
            data-slot="private-space"
            className={cn('shrink-0 opacity-70', className)}
        >
            <title>Private: only this Space’s people see it</title>
        </Lock>
    );
}
