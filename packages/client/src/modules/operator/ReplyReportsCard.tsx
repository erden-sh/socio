import { useCallback, useContext, useEffect, useId, useState } from 'react';

import type { Account } from '@socio/shared/auth';
import { REPLY_REPORTS_SETTING, type ReplyReportsAdminView } from '@socio/shared/chat/reply-reports';
import { formatNumber } from '@socio/shared/locale';
import type { User } from '@socio/shared/types';

import { api } from '../../lib/api';
import { LocalTime } from '../../lib/local-time';
import { CurrentUser, useIsAdmin } from '../../shell/current-user';
import { ShellContext } from '../../shell/shell-context';

import {
    AlertDialog,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';

const dateTime = (value: number) => new Date(value).toLocaleString();

/** `GET /api/cloud/reply-reports` (admins), for this card and the Cloud connection card. */
export const loadReplyReports = () => api<ReplyReportsAdminView>('/cloud/reply-reports');

/** Who turned sharing on: "you", else their name from the people list, else their id. */
function useAdminName(id: string | undefined) {
    const me = useContext(CurrentUser);
    const [names, setNames] = useState<Map<string, string>>();
    useEffect(() => {
        if (!id || id === me?.id) {
            return;
        }
        const controller = new AbortController();
        api<{ accounts?: Account[]; unlinked?: User[] }>('/accounts', 'GET', undefined, controller.signal)
            .then((list) =>
                setNames(
                    new Map([
                        ...(list.accounts ?? []).map((account) => [account.userId, account.name] as const),
                        ...(list.unlinked ?? []).map((user) => [user.id, user.name] as const),
                    ]),
                ),
            )
            .catch(() => {
                // Mock sign-in has no people list: the id stands in.
            });
        return () => controller.abort();
    }, [id, me?.id]);
    if (!id) {
        return undefined;
    }
    return id === me?.id ? 'you' : (names?.get(id) ?? id);
}

/**
 * The Platform page's "Share AI reply reports with Ingenio" card (CB-382,
 * docs/specs/REPLY-REPORTS.md §6), for admins: shown while this server can
 * share (the cloud connection grants `reports:write`), or while sharing is
 * on, so it can always be turned off. Turning it on first shows what
 * leaves and asks to confirm; it says who turned it on and when, and the
 * reports waiting to go and those that never will.
 */
export function ReplyReportsCard() {
    const admin = useIsAdmin();
    const refreshShell = useContext(ShellContext)?.refresh;
    const [view, setView] = useState<ReplyReportsAdminView>();
    const [confirming, setConfirming] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const switchId = useId();
    const load = useCallback(
        () =>
            loadReplyReports()
                .then(setView)
                .catch(() => setView(undefined)),
        [],
    );
    useEffect(() => {
        if (admin) {
            void load();
        }
    }, [admin, load]);
    const by = useAdminName(view?.sharing ? view.by : undefined);
    if (!admin || !view || (!view.available && !view.sharing)) {
        return null;
    }
    const save = async (sharing: boolean) => {
        setBusy(true);
        setError('');
        try {
            setView(await api<ReplyReportsAdminView>('/cloud/reply-reports', 'PUT', { sharing }));
            // Everyone's thumbs-down follows the workspace payload.
            void refreshShell?.();
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Could not save.');
            void load();
        } finally {
            setBusy(false);
        }
    };
    return (
        <Card className="mt-6" data-slot="reply-reports">
            <CardHeader>
                <CardTitle>{REPLY_REPORTS_SETTING.label}</CardTitle>
                <CardDescription>{REPLY_REPORTS_SETTING.body}</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3 text-sm">
                <div className="flex items-center gap-2">
                    {/* Not disabled while saving: that would take the keyboard's focus. */}
                    <Switch
                        id={switchId}
                        checked={view.sharing}
                        disabled={!view.sharing && !view.available}
                        aria-busy={busy}
                        onCheckedChange={(checked) => {
                            if (busy) {
                                return;
                            }
                            if (checked) {
                                setConfirming(true);
                            } else {
                                void save(false);
                            }
                        }}
                    />
                    <label htmlFor={switchId}>{REPLY_REPORTS_SETTING.label}</label>
                </div>
                {view.sharing && !view.available && (
                    <p className="text-muted-foreground" data-slot="reply-reports-paused">
                        The cloud connection can’t send reports now, so they wait or aren’t made until it can.
                    </p>
                )}
                {error && (
                    <p className="rounded-lg bg-destructive/10 p-3 text-destructive" role="alert">
                        {error}
                    </p>
                )}
                <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
                    {view.sharing && view.since && (
                        <>
                            <dt className="text-muted-foreground">Turned on</dt>
                            <dd data-slot="reply-reports-since">
                                {by ? `By ${by}, ` : ''}
                                <LocalTime value={view.since} format={dateTime} />
                            </dd>
                        </>
                    )}
                    <dt className="text-muted-foreground">Waiting to send</dt>
                    <dd data-slot="reply-reports-queued">{formatNumber(view.queued)}</dd>
                    <dt className="text-muted-foreground">Couldn’t be sent</dt>
                    <dd data-slot="reply-reports-failed">{formatNumber(view.failed)}</dd>
                </dl>
            </CardContent>
            {confirming && (
                <AlertDialog open onOpenChange={(open) => !open && setConfirming(false)}>
                    <AlertDialogContent data-slot="reply-reports-consent">
                        <AlertDialogHeader>
                            <AlertDialogTitle>Share AI reply reports with Ingenio?</AlertDialogTitle>
                            <AlertDialogDescription>{REPLY_REPORTS_SETTING.body}</AlertDialogDescription>
                        </AlertDialogHeader>
                        <p className="text-sm text-muted-foreground">
                            Each person confirms every report before it goes.
                        </p>
                        <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <Button
                                data-slot="reply-reports-turn-on"
                                onClick={() => {
                                    setConfirming(false);
                                    void save(true);
                                }}
                            >
                                Turn on sharing
                            </Button>
                        </AlertDialogFooter>
                    </AlertDialogContent>
                </AlertDialog>
            )}
        </Card>
    );
}
