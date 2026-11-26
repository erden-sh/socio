import { ChevronRight, FileText, Folder } from 'lucide-react';
import { Link } from 'react-router';

import type { HierarchyPage } from '@socio/shared/pages/page-hierarchy';

import { spacePath } from './page-navigation';

import { cn } from '@/lib/utils';

/** The shell's ancestor crumbs are hidden on phones; retain their navigation here. */
export function PageAncestorLinks({ pages }: { pages: HierarchyPage[] }) {
    if (!pages.length) {
        return null;
    }
    return (
        <nav aria-label="Parent pages" className="mb-4 min-w-0 md:hidden">
            <ol className="m-0 flex list-none flex-wrap items-center gap-x-1 p-0 text-xs text-muted-foreground">
                {pages.map((page) => (
                    <li key={page.id} className="flex min-w-0 max-w-full items-center gap-1">
                        <Link
                            className="flex min-h-11 min-w-0 items-center rounded px-1 [overflow-wrap:anywhere] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                            to={spacePath(page.spaceId, page.id)}
                        >
                            {page.title.trim() || 'Untitled page'}
                        </Link>
                        <ChevronRight aria-hidden className="size-3 shrink-0" />
                    </li>
                ))}
            </ol>
        </nav>
    );
}

/** The pages under a page, or inside a folder (CB-426), each folder with its icon. */
export function PageChildLinks({
    pages,
    title = 'Child pages',
    className,
}: {
    pages: Array<HierarchyPage & { folder?: boolean }>;
    title?: string;
    className?: string;
}) {
    if (!pages.length) {
        return null;
    }
    return (
        <nav aria-label={title} className={cn('mt-8 min-w-0 border-t pt-5', className)}>
            <h2 className="mb-2 text-sm font-semibold">{title}</h2>
            <ul className="m-0 list-none divide-y p-0">
                {pages.map((page) => (
                    <li key={page.id}>
                        <Link
                            to={spacePath(page.spaceId, page.id)}
                            className="flex min-h-11 min-w-0 items-center gap-2 rounded px-2 py-2 text-sm hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
                        >
                            {page.folder ? (
                                <Folder aria-hidden className="size-4 shrink-0" />
                            ) : (
                                <FileText aria-hidden className="size-4 shrink-0" />
                            )}
                            <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                                {page.title.trim() || 'Untitled page'}
                            </span>
                            <ChevronRight aria-hidden className="size-4 shrink-0" />
                        </Link>
                    </li>
                ))}
            </ul>
        </nav>
    );
}
