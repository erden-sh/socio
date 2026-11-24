import type { FilterAccount } from './types';

/**
 * Avatar filter adapted from lramos33/big-calendar (MIT),
 * src/calendar/components/header/user-select.tsx.
 * Copyright (c) 2025 Leonardo Ramos.
 * The calendar's user filter is a single-select avatar menu.
 */
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

export function AvatarFilter({
    accounts,
    value,
    onChange,
    label = 'Account',
}: {
    accounts: FilterAccount[];
    value: string;
    onChange: (id: string) => void;
    label?: string;
}) {
    const shown = accounts.slice(0, 3);
    const extra = accounts.length - shown.length;
    return (
        <Select value={value} onValueChange={onChange}>
            <SelectTrigger className="w-44" aria-label={label}>
                <SelectValue placeholder={label} />
            </SelectTrigger>
            <SelectContent align="end">
                <SelectItem value="all">
                    <span className="flex items-center gap-1.5">
                        <span className="flex -space-x-1.5">
                            {shown.map((account) => (
                                <AccountAvatar key={account.id} account={account} />
                            ))}
                        </span>
                        {extra > 0 ? `+${extra}` : 'All'}
                    </span>
                </SelectItem>
                {accounts.map((account) => (
                    <SelectItem key={account.id} value={account.id}>
                        <span className="flex items-center gap-2">
                            <AccountAvatar account={account} />
                            <span className="truncate">{account.label}</span>
                        </span>
                    </SelectItem>
                ))}
            </SelectContent>
        </Select>
    );
}

function AccountAvatar({ account }: { account: FilterAccount }) {
    return (
        <Avatar className="size-6 border border-background">
            <AvatarFallback className="text-[10px] font-semibold text-white" style={{ background: account.color }}>
                {account.initial}
            </AvatarFallback>
        </Avatar>
    );
}

export function AvatarChoices({
    accounts,
    value,
    onChange,
    label = 'Account',
}: {
    accounts: FilterAccount[];
    value: string;
    onChange: (id: string) => void;
    label?: string;
}) {
    return (
        <div className="flex flex-wrap items-center gap-1.5" role="radiogroup" aria-label={label}>
            {accounts.map((account) => {
                const selected = value === account.id;
                return (
                    <button
                        key={account.id}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        title={account.label}
                        onClick={() => onChange(account.id)}
                        className="rounded-full ring-offset-background focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                        style={
                            selected
                                ? {
                                      boxShadow: `0 0 0 2px var(--background), 0 0 0 4px ${account.color}`,
                                  }
                                : undefined
                        }
                    >
                        <AccountAvatar account={account} />
                    </button>
                );
            })}
        </div>
    );
}
