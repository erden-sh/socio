import { Archive, History, MessageSquarePlus, Pencil, Settings, Sparkles } from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';

import type { Dot } from '@socio/shared/types';

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
            toast.error(cause instanceof Error ? cause.message : 'Could not save the socio.');
            return false;
        }
    };
}

/**
 * The Dot's name as a text box, in place of its sidebar row: Enter or
 * leaving it saves, Escape keeps the old name, and so does an empty box.
 */
export function DotNameInput({ dot, onDone }: { dot: Dot; onDone: () => void }) {
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
            aria-label="Socio name"
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
            toast(`${dot.name} archived`, {
                action: {
                    label: 'Undo',
                    onClick: () =>
                        void api(`/dots/${encodeURIComponent(dot.id)}/unarchive`, 'POST')
                            .then(() => shell.refresh())
                            .catch(() => toast.error('Could not unarchive the socio.')),
                },
            });
            setConfirming(false);
            await shell.refresh();
        } catch (cause) {
            toast.error(cause instanceof Error ? cause.message : 'Could not archive the socio.');
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
                    <DropdownMenuItem onSelect={() => go(`/dots/${encodeURIComponent(dot.id)}/new`)}>
                        <MessageSquarePlus /> New chat
                    </DropdownMenuItem>
                    <DropdownMenuItem
                        onSelect={() => {
                            renaming.current = true;
                            onRename();
                        }}
                    >
                        <Pencil /> Rename
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Allowed</DropdownMenuLabel>
                    <DropdownMenuCheckboxItem
                        checked={dot.researchAllowed}
                        onSelect={(event) => event.preventDefault()}
                        onCheckedChange={(checked) => toggle({ researchAllowed: checked })}
                    >
                        Public-page research
                    </DropdownMenuCheckboxItem>
                    <DropdownMenuCheckboxItem
                        checked={dot.memoryAllowed}
                        onSelect={(event) => event.preventDefault()}
                        onCheckedChange={(checked) => toggle({ memoryAllowed: checked })}
                    >
                        Use saved memories
                    </DropdownMenuCheckboxItem>
                    {admin && (
                        <DropdownMenuCheckboxItem
                            checked={!!dot.issuesAllowed}
                            onSelect={(event) => event.preventDefault()}
                            onCheckedChange={(checked) => toggle({ issuesAllowed: checked })}
                        >
                            File to the Improvements board
                        </DropdownMenuCheckboxItem>
                    )}
                    <DropdownMenuSeparator />
                    {admin && (
                        <DropdownMenuItem onSelect={() => go(`/admin/dots/${encodeURIComponent(dot.id)}`)}>
                            <History /> Activity
                        </DropdownMenuItem>
                    )}
                    <DropdownMenuItem onSelect={() => go(`/dots/${encodeURIComponent(dot.id)}/soul`)}>
                        <Sparkles /> Soul
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => setConfirming(true)}>
                        <Archive /> Archive…
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={onSettings}>
                        <Settings /> All settings…
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
            {confirming && (
                <ConfirmDelete
                    title={`Archive ${dot.name}?`}
                    slot="confirm-archive-dot"
                    action="Archive"
                    onClose={() => setConfirming(false)}
                    onConfirm={archive}
                >
                    It leaves every list and stops working: its schedules and goals pause. Its chats, filings and
                    history are kept, and nothing is deleted. You can unarchive it from any of its chats.
                </ConfirmDelete>
            )}
        </>
    );
}
