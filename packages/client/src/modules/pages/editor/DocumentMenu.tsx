import { MoreHorizontal } from 'lucide-react';
import { useRef } from 'react';

import { useTranslation } from '@socio/i18n/react';

import { PageIconButton } from '../page-chrome';

import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

/**
 * The page's ⋯ menu. A chosen item runs once the menu has closed and given
 * focus back to ⋯, so what it opens (the move picker, the delete confirm)
 * takes the focus from there, and gives it back to ⋯ when it closes.
 */
export function DocumentMenu({ items }: { items: { label: string; action: () => void }[] }) {
    const { t } = useTranslation(['pages']);
    const chosen = useRef<() => void>(undefined);
    const trigger = useRef<HTMLButtonElement>(null);
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <PageIconButton ref={trigger} aria-label={t('pages:document.menu.label')}>
                    <MoreHorizontal className="size-5" />
                </PageIconButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent
                align="end"
                aria-label={t('pages:document.menu.label')}
                className="w-55 rounded-[10px] p-1.5 shadow-[0_8px_25px_rgb(0_0_0/0.09)]"
                onCloseAutoFocus={(event) => {
                    event.preventDefault();
                    trigger.current?.focus();
                    const action = chosen.current;
                    chosen.current = undefined;
                    action?.();
                }}
            >
                {items.map((item) => (
                    <DropdownMenuItem
                        key={item.label}
                        className="rounded-md px-3 py-[11px] text-xs max-[700px]:min-h-11"
                        onSelect={() => {
                            chosen.current = item.action;
                        }}
                    >
                        {item.label}
                    </DropdownMenuItem>
                ))}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
