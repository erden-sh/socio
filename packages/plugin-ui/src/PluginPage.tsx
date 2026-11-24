import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

/** Full-height frame for a plugin page. Pair it with `plugin.css`. */
export function PluginPage({ children, className }: { children: ReactNode; className?: string }) {
    return <div className={cn('flex h-full min-h-0 bg-background text-foreground', className)}>{children}</div>;
}
