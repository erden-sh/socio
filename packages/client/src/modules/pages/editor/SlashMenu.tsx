import { useLayoutEffect, useRef } from 'react';

import { Command, CommandEmpty, CommandItem, CommandList } from '@/components/ui/command';

export interface SlashMenuItem {
    title: string;
    description: string;
}

/**
 * The "/" block menu (slash-commands.ts renders it in the suggestion
 * popup). Focus stays in the editor, which moves `index` with the arrow
 * keys; the editor's textbox names the list and its selected block
 * (aria-controls, aria-activedescendant), as a combobox would.
 */
export function SlashMenu({
    items,
    index,
    dom,
    onChoose,
}: {
    items: SlashMenuItem[];
    index: number;
    /** The editor's textbox. */
    dom: HTMLElement;
    onChoose: (item: SlashMenuItem) => void;
}) {
    const root = useRef<HTMLDivElement>(null);
    useLayoutEffect(() => {
        const list = root.current?.querySelector('[role="listbox"]');
        const option = root.current?.querySelector('[role="option"][aria-selected="true"]');
        if (list?.id) {
            dom.setAttribute('aria-controls', list.id);
        }
        if (option?.id) {
            dom.setAttribute('aria-activedescendant', option.id);
        } else {
            dom.removeAttribute('aria-activedescendant');
        }
        option?.scrollIntoView({ block: 'nearest' });
    });
    return (
        <Command
            ref={root}
            shouldFilter={false}
            disablePointerSelection
            value={items[index]?.title ?? ''}
            className="h-auto max-h-86 w-[min(320px,calc(100vw-24px))] overflow-y-auto rounded-[12px] border p-[7px] shadow-[0_10px_35px_rgb(0_0_0/0.13)]"
        >
            <div className="px-2.5 pt-[9px] pb-[7px] text-xs font-semibold tracking-[0.09em] text-muted-foreground">
                INSERT BLOCK
            </div>
            <CommandList label="Insert block" className="max-h-none overflow-visible">
                <CommandEmpty className="p-3 text-left text-[10px]/[1.45] text-muted-foreground">
                    No matching blocks
                </CommandEmpty>
                {items.map((item) => (
                    <CommandItem
                        key={item.title}
                        value={item.title}
                        className="min-h-[51px] cursor-pointer flex-col items-start justify-center gap-0.5 rounded-[7px] px-3 py-[9px] hover:bg-accent/60"
                        // Keep the focus (and the selection) in the editor.
                        onMouseDown={(event) => event.preventDefault()}
                        onSelect={() => onChoose(item)}
                    >
                        <strong className="text-xs font-[550] text-foreground">{item.title}</strong>
                        <span className="text-[10px]/[1.45] text-muted-foreground">{item.description}</span>
                    </CommandItem>
                ))}
            </CommandList>
        </Command>
    );
}
