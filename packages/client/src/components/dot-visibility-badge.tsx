import type { Dot } from '@socio/shared/types';

import { Badge } from '@/components/ui/badge';

/**
 * A small "Personal" badge for a private socio — one with an owner —
 * shown wherever a socio appears as a title or menu item (CB-269) so
 * people can tell it apart from a tenant-wide, company socio. A company
 * socio (no owner) is the unmarked default and renders nothing here: the
 * absence of the badge is the distinguishing signal.
 *
 * Keep the `data-slot="dot-visibility-badge"` stable: the help-center
 * and dot-home tests assert on it.
 */
export function DotVisibilityBadge({ dot, className }: { dot: Pick<Dot, 'ownerId'>; className?: string }) {
    if (!dot.ownerId) {
        return null;
    }
    return (
        <Badge
            variant="secondary"
            className={className}
            data-slot="dot-visibility-badge"
            title="Only its owner sees and chats with this socio."
        >
            Personal
        </Badge>
    );
}
