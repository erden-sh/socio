import { Monitor, Moon, Sun, SunMoon, type LucideIcon } from 'lucide-react';
import { DropdownMenu as DropdownMenuPrimitive } from 'radix-ui';
import { useId } from 'react';

import {
    DropdownMenuGroup,
    DropdownMenuLabel,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
} from '@/components/ui/dropdown-menu';
import { themeChoices, useThemeChoice, type ThemeChoice } from '@/shell/theme';

const icons: Record<ThemeChoice, LucideIcon> = {
    light: Sun,
    dark: Moon,
    system: Monitor,
};
const label = (choice: ThemeChoice) => themeChoices.find((item) => item.value === choice)!.label;

/** Light, Dark and System as radio items, the current one checked. */
function ThemeChoices() {
    const { choice, setChoice } = useThemeChoice();
    return (
        <DropdownMenuRadioGroup value={choice} onValueChange={(value) => setChoice(value as ThemeChoice)}>
            {themeChoices.map(({ value, label }) => {
                const Icon = icons[value];
                return (
                    <DropdownMenuRadioItem key={value} value={value}>
                        <Icon />
                        {label}
                    </DropdownMenuRadioItem>
                );
            })}
        </DropdownMenuRadioGroup>
    );
}

/**
 * Light, Dark and System side by side in the header's Help menu
 * (CB-308): a segmented control of radio items, the current one raised.
 * Arrow keys move through them like the menu's other items.
 */
export function ThemeSegments() {
    const { choice, setChoice } = useThemeChoice();
    const labelId = useId();
    return (
        <DropdownMenuGroup>
            <DropdownMenuLabel id={labelId} className="px-2 pt-1 pb-1 text-xs font-normal text-muted-foreground">
                Theme
            </DropdownMenuLabel>
            <DropdownMenuRadioGroup
                aria-labelledby={labelId}
                value={choice}
                onValueChange={(value) => setChoice(value as ThemeChoice)}
                data-slot="theme-segments"
                className="mx-1 mb-1 grid grid-cols-3 gap-0.5 rounded-md bg-muted p-0.5"
            >
                {themeChoices.map(({ value, label }) => {
                    const Icon = icons[value];
                    return (
                        <DropdownMenuPrimitive.RadioItem
                            key={value}
                            value={value}
                            // Picking one keeps the menu open, so the change is seen.
                            onSelect={(event) => event.preventDefault()}
                            className="flex h-7 cursor-default items-center justify-center gap-1.5 rounded-sm text-[13px] text-muted-foreground outline-hidden select-none focus-visible:ring-2 focus-visible:ring-ring data-highlighted:text-foreground data-[state=checked]:bg-popover data-[state=checked]:text-foreground data-[state=checked]:shadow-xs [&_svg]:size-3.5 [&_svg]:shrink-0"
                        >
                            <Icon aria-hidden />
                            {label}
                        </DropdownMenuPrimitive.RadioItem>
                    );
                })}
            </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
    );
}

/** The account menu's Theme submenu, showing the current choice. */
export function ThemeSubmenu() {
    const { choice } = useThemeChoice();
    const Icon = choice === 'system' ? SunMoon : icons[choice];
    return (
        <DropdownMenuSub>
            <DropdownMenuSubTrigger>
                <Icon />
                <span className="flex-1">Theme</span>
                <span className="text-xs text-muted-foreground">{label(choice)}</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="min-w-36">
                <ThemeChoices />
            </DropdownMenuSubContent>
        </DropdownMenuSub>
    );
}
