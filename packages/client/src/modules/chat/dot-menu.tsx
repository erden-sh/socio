import { Archive, History, MessageSquarePlus, Pencil, Settings, Sparkles } from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';

import { useTranslation } from '@socio/i18n/react';
import type { Dot } from '@socio/shared/types';

import { useOnDemand } from '../../i18n/on-demand';
import { api } from '../../lib/api';
import { useShell } from '../../shell/shell-context';

import { ConfirmDelete } from '@/components/confirm-delete';
import {
    DropdownMenu,
    DropdownMenuCheckboxItem,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';

/** A Dot's name, as the server takes it (`dotSchema`). */
export const MAX_DOT_NAME = 40;

type DotPatch = Partial<Pick<Dot, 'name' | 'researchAllowed' | 'memoryAllowed' | 'issuesAllowed'>>;

/**
 * Saves one or two of a Dot's settings: the server takes the whole set,
 * so the rest go back as they are. False when it refused (its reason
 * toasts).
 */
function useSaveDot() {
    const { t } = useTranslation(['chat.menu']);
    const shell = useShell();
    return async (dot: Dot, patch: DotPatch) => {
        const next = { ...dot, ...patch };
        try {
            await api(`/dots/${encodeURIComponent(dot.id)}`, 'PUT', {
                // Instructions are the Soul's, edited on its page (CB-179).
                name: next.name,
                researchAllowed: next.researchAllowed,
                memoryAllowed: next.memoryAllowed,
                issuesAllowed: next.issuesAllowed ?? false,
                learningContainerId: next.learningContainerId ?? null,
                skillDeliveryEnabled: next.skillDeliveryEnabled ?? false,
                spaceIds: next.spaceIds,
                spaceId: next.spaceId,
                inference: next.inference ?? null,
            });
            await shell.refresh();
            return true;
        } catch (cause) {
            toast.error(cause instanceof Error ? cause.message : t('chat.menu:dot.errors.save'));
            return false;
        }
    };
}

/**
 * The Dot's name as a text box, in place of its sidebar row: Enter or
 * leaving it saves, Escape keeps the old name, and so does an empty box.
 */
export function DotNameInput({ dot, onDone }: { dot: Dot; onDone: () => void }) {
    const { t } = useTranslation(['chat.menu']);
    const save = useSaveDot();
    const done = useRef(false);
    const finish = (value?: string) => {
        if (done.current) {
            return;
        }
        done.current = true;
        onDone();
        const name = value?.trim().slice(0, MAX_DOT_NAME);
        if (name && name !== dot.name) {
            void save(dot, { name });
        }
    };
    return (
        <Input
            aria-label={t('chat.menu:dot.name-input')}
            data-slot="dot-name-input"
            defaultValue={dot.name}
            maxLength={MAX_DOT_NAME}
            autoFocus
            onFocus={(event) => event.currentTarget.select()}
            onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) {
                    return;
                }
                if (event.key === 'Enter') {
                    event.preventDefault();
                    finish(event.currentTarget.value);
                } else if (event.key === 'Escape') {
                    event.preventDefault();
                    event.stopPropagation();
                    finish();
                }
            }}
            onBlur={(event) => finish(event.currentTarget.value)}
            className="h-8 px-2 text-sm md:text-sm"
        />
    );
}

/**
 * The ⋯ menu of one Dot in the sidebar, for its owner and admins: new
 * chat, rename, its everyday permissions, its audit (admins), archive,
 * then every setting. `open` is controlled so a right-click opens it too.
 * Its items wait for chat.menu, which the sidebar asks for as it mounts
 * (only chat routes inline it).
 */
export function DotMenu({
    dot,
    admin,
    trigger,
    open,
    onOpenChange,
    onRename,
    onSettings,
    onLeave,
}: {
    dot: Dot;
    admin: boolean;
    trigger: ReactNode;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onRename: () => void;
    onSettings: () => void;
    /** Before navigating (closes the mobile sheet). */
    onLeave: () => void;
}) {
    const { t } = useTranslation(['chat.menu']);
    const ready = useOnDemand(['chat.menu']);
    const shell = useShell();
    const navigate = useNavigate();
    const save = useSaveDot();
    const [confirming, setConfirming] = useState(false);
    const renaming = useRef(false);
    const go = (path: string) => {
        onLeave();
        void navigate(path);
    };
    const toggle = (patch: DotPatch) => void save(dot, patch);
    const archive = async () => {
        try {
            await api(`/dots/${encodeURIComponent(dot.id)}/archive`, 'POST');
            toast(t('chat.menu:dot.archived', { name: dot.name }), {
                action: {
                    label: t('chat.menu:undo'),
                    onClick: () =>
                        void api(`/dots/${encodeURIComponent(dot.id)}/unarchive`, 'POST')
                            .then(() => shell.refresh())
                            .catch(() => toast.error(t('chat.menu:dot.errors.unarchive'))),
                },
            });
            setConfirming(false);
            await shell.refresh();
        } catch (cause) {
            toast.error(cause instanceof Error ? cause.message : t('chat.menu:dot.errors.archive'));
        }
    };
    return (
        <>
            <DropdownMenu open={open} onOpenChange={onOpenChange}>
                <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
                <DropdownMenuContent
                    align="start"
                    className="w-60"
                    data-slot="dot-menu"
                    // Rename moves focus into the name box, not back to ⋯.
                    onCloseAutoFocus={(event) => {
                        if (renaming.current) {
                            event.preventDefault();
                        }
                        renaming.current = false;
                    }}
                >
                    {ready && (
                        <>
                            <DropdownMenuItem onSelect={() => go(`/dots/${encodeURIComponent(dot.id)}/new`)}>
                                <MessageSquarePlus /> {t('chat.menu:new-chat')}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                                onSelect={() => {
                                    renaming.current = true;
                                    onRename();
                                }}
                            >
                                <Pencil /> {t('chat.menu:rename')}
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                                {t('chat.menu:dot.allowed')}
                            </DropdownMenuLabel>
                            <DropdownMenuCheckboxItem
                                checked={dot.researchAllowed}
                                onSelect={(event) => event.preventDefault()}
                                onCheckedChange={(checked) => toggle({ researchAllowed: checked })}
                            >
                                {t('chat.menu:dot.research')}
                            </DropdownMenuCheckboxItem>
                            <DropdownMenuCheckboxItem
                                checked={dot.memoryAllowed}
                                onSelect={(event) => event.preventDefault()}
                                onCheckedChange={(checked) => toggle({ memoryAllowed: checked })}
                            >
                                {t('chat.menu:dot.memory')}
                            </DropdownMenuCheckboxItem>
                            {admin && (
                                <DropdownMenuCheckboxItem
                                    checked={!!dot.issuesAllowed}
                                    onSelect={(event) => event.preventDefault()}
                                    onCheckedChange={(checked) => toggle({ issuesAllowed: checked })}
                                >
                                    {t('chat.menu:dot.issues')}
                                </DropdownMenuCheckboxItem>
                            )}
                            <DropdownMenuSeparator />
                            {admin && (
                                <DropdownMenuItem onSelect={() => go(`/admin/dots/${encodeURIComponent(dot.id)}`)}>
                                    <History /> {t('chat.menu:dot.activity')}
                                </DropdownMenuItem>
                            )}
                            <DropdownMenuItem onSelect={() => go(`/dots/${encodeURIComponent(dot.id)}/soul`)}>
                                <Sparkles /> {t('chat.menu:dot.soul')}
                            </DropdownMenuItem>
                            <DropdownMenuItem onSelect={() => setConfirming(true)}>
                                <Archive /> {t('chat.menu:dot.archive')}
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem onSelect={onSettings}>
                                <Settings /> {t('chat.menu:dot.settings')}
                            </DropdownMenuItem>
                        </>
                    )}
                </DropdownMenuContent>
            </DropdownMenu>
            {confirming && (
                <ConfirmDelete
                    title={t('chat.menu:dot.archive-dialog.title', { name: dot.name })}
                    slot="confirm-archive-dot"
                    action={t('chat.menu:archive')}
                    onClose={() => setConfirming(false)}
                    onConfirm={archive}
                >
                    {t('chat.menu:dot.archive-dialog.body')}
                </ConfirmDelete>
            )}
        </>
    );
}
