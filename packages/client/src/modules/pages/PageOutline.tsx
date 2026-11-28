import { FileText, Plus, X } from 'lucide-react';

import { useTranslation } from '@socio/i18n/react';
import type { PageSummary } from '@socio/shared/pages/page-library';

import { PageIconButton } from './page-chrome';

export function PageOutline({
    pages,
    selected,
    onPage,
    onNew,
    onClose,
}: {
    pages: PageSummary[];
    selected: string;
    onPage: (id: string) => void;
    onNew: () => void;
    onClose: () => void;
}) {
    const { t } = useTranslation(['pages']);
    const render = (parentId: string | null, depth = 0): React.ReactNode =>
        pages
            .filter((page) => page.parentId === parentId)
            .map((page) => (
                <li key={page.id}>
                    <button
                        type="button"
                        data-slot="page-outline-item"
                        className="flex min-h-[39px] w-full items-center justify-start gap-2 rounded-[7px] py-[9px] pr-2 text-left text-xs text-muted-foreground outline-none hover:bg-sidebar-accent/70 focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-[current=page]:bg-sidebar-accent aria-[current=page]:text-sidebar-accent-foreground max-[700px]:min-h-11"
                        style={{ paddingLeft: 12 + depth * 12 }}
                        aria-current={selected === page.id ? 'page' : undefined}
                        onClick={() => onPage(page.id)}
                    >
                        <FileText size={14} className="shrink-0" />
                        <span className="truncate">{page.title}</span>
                    </button>
                    {pages.some((child) => child.parentId === page.id) && <ul>{render(page.id, depth + 1)}</ul>}
                </li>
            ));
    return (
        <nav
            data-slot="page-outline"
            className="w-[205px] shrink-0 overflow-auto border-r bg-sidebar px-2 py-3.5 max-[1150px]:w-45 max-[900px]:absolute max-[900px]:inset-y-0 max-[900px]:left-0 max-[900px]:z-25 max-[900px]:w-55 max-[900px]:shadow-[5px_0_20px_rgb(0_0_0/0.04)]"
            aria-label={t('pages:outline.label')}
        >
            <div className="flex items-center px-1 pb-3">
                <strong className="flex-1 pl-2 text-xs text-muted-foreground">{t('pages:outline.heading')}</strong>
                <PageIconButton aria-label={t('pages:outline.new')} onClick={onNew}>
                    <Plus className="size-4" />
                </PageIconButton>
                <PageIconButton aria-label={t('pages:outline.close')} onClick={onClose}>
                    <X className="size-4" />
                </PageIconButton>
            </div>
            <ul>{render(null)}</ul>
        </nav>
    );
}
