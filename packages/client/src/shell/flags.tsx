import { Sparkles } from 'lucide-react';
import { useContext } from 'react';

import type { ClientFlags, FlagKey } from '@socio/shared/flags';

import { ShellContext } from './shell-context';

import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

/**
 * Feature flags as the server evaluated them for this person (CB-169),
 * from the shell's `/api/workspace`. For what to show only: the server
 * checks each flag itself, so a client that shows more gets nothing more.
 * Undefined outside the shell.
 */
export const useFlags = (): ClientFlags | undefined => useContext(ShellContext)?.workspace?.flags;

/** Whether a flag is on for this person (off until the shell has loaded). */
export const useFlag = (key: FlagKey) => !!useFlags()?.on.includes(key);

/** The "Early access" mark on a flagged feature, its release notes and Settings. */
export function EarlyAccessBadge({ className }: { className?: string }) {
    return (
        <Badge variant="outline" data-slot="early-access-badge" className={cn('gap-1 text-[11px]', className)}>
            <Sparkles aria-hidden />
            Early access
        </Badge>
    );
}
