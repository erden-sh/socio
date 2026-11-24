import { Check, Copy } from 'lucide-react';
import { useState } from 'react';

import { LocalTime } from '../../lib/local-time';

import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

const dateLabel = (value: number) =>
    new Date(value).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
    });

/**
 * The person's own subscription link (.ics) for a calendar app. Socio
 * shows the link once, when it is made; making another replaces it.
 */
export function FeedDialog({
    feed,
    onCreate,
    onRemove,
    onClose,
}: {
    feed: { active: boolean; createdAt?: string };
    onCreate: () => Promise<string>;
    onRemove: () => Promise<void>;
    onClose: () => void;
}) {
    const [url, setUrl] = useState<string>();
    const [busy, setBusy] = useState(false);
    const [copied, setCopied] = useState(false);
    const [error, setError] = useState<string>();
    const run = async (work: () => Promise<void>) => {
        setBusy(true);
        setError(undefined);
        try {
            await work();
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : 'Could not do that.');
        } finally {
            setBusy(false);
        }
    };
    const created = feed.createdAt ? Date.parse(feed.createdAt) : NaN;
    return (
        <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
            <DialogContent className="sm:max-w-lg" data-slot="calendar-feed-dialog">
                <DialogHeader>
                    <DialogTitle>Subscribe in a calendar app</DialogTitle>
                    <DialogDescription>
                        A private link to the events you can see here, for Google Calendar, Apple Calendar or Outlook.
                        Anyone with the link can read those events, so keep it to yourself.
                    </DialogDescription>
                </DialogHeader>
                {url ? (
                    <div className="grid gap-2">
                        <p className="text-sm">Copy it now: Socio shows it only this once.</p>
                        <div className="flex gap-2">
                            <Input
                                readOnly
                                value={url}
                                aria-label="Subscription link"
                                onFocus={(input) => input.target.select()}
                            />
                            <Button
                                type="button"
                                variant="outline"
                                size="icon"
                                aria-label={copied ? 'Copied' : 'Copy the link'}
                                onClick={() =>
                                    void navigator.clipboard
                                        ?.writeText(url)
                                        .then(() => setCopied(true))
                                        .catch(() => setError('Copy did not work. Select it.'))
                                }
                            >
                                {copied ? <Check /> : <Copy />}
                            </Button>
                        </div>
                    </div>
                ) : feed.active ? (
                    <p className="text-sm" data-slot="calendar-feed-active">
                        You have a link
                        {Number.isFinite(created) && (
                            <>
                                {' '}
                                from <LocalTime value={created} format={dateLabel} />
                            </>
                        )}
                        . A new one replaces it, and the old one stops working.
                    </p>
                ) : (
                    <p className="text-sm text-muted-foreground">You have no link yet.</p>
                )}
                {error && (
                    <p className="text-sm text-destructive" role="alert">
                        {error}
                    </p>
                )}
                <DialogFooter className="gap-2">
                    {(feed.active || url) && (
                        <Button
                            type="button"
                            variant="ghost"
                            disabled={busy}
                            onClick={() =>
                                void run(async () => {
                                    await onRemove();
                                    setUrl(undefined);
                                })
                            }
                        >
                            Turn off
                        </Button>
                    )}
                    <Button
                        type="button"
                        variant={url ? 'outline' : 'default'}
                        disabled={busy}
                        onClick={() =>
                            void run(async () => {
                                setCopied(false);
                                setUrl(await onCreate());
                            })
                        }
                    >
                        {feed.active || url ? 'Make a new link' : 'Make a link'}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
