import { Sparkles } from 'lucide-react';
import { Link } from 'react-router';

import type { Dot } from '@socio/shared/types';

/**
 * In a socio's settings: its Soul (CB-179), which holds its instructions,
 * with the version in use and a link to the Soul page, where it is read,
 * edited and restored.
 */
export function SoulLink({ dot, onOpen }: { dot: Dot; onOpen: () => void }) {
    return (
        <div
            data-slot="dot-settings-soul"
            className="mt-[23px] grid gap-1.5 rounded-[9px] border p-3 text-xs leading-[1.6]"
        >
            <span className="flex items-center gap-2 font-medium">
                <Sparkles className="size-3.5 text-muted-foreground" aria-hidden />
                Soul{dot.soul ? ` · version ${dot.soul.version}` : ''}
            </span>
            <p className="line-clamp-2 text-muted-foreground">{dot.instructions}</p>
            <Link
                to={`/dots/${encodeURIComponent(dot.id)}/soul`}
                onClick={onOpen}
                className="w-fit underline underline-offset-2"
            >
                Role, voice and history on its Soul page
            </Link>
        </div>
    );
}
