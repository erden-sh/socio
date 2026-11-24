import { useState } from 'react';

import { IssueMarkdown } from '../issues/IssueMarkdown';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/** Longer than this (characters or lines), a purpose starts collapsed. */
const LONG_CHARS = 480;
const LONG_LINES = 8;

/**
 * What a schedule or task is for: its prompt (or goal) as Markdown at the
 * body's type sizes (CB-88), collapsed to a few lines when long.
 */
export function Purpose({ text }: { text: string }) {
    const long = text.length > LONG_CHARS || text.split('\n').length > LONG_LINES;
    const [open, setOpen] = useState(false);
    const collapsed = long && !open;
    return (
        <div className="grid gap-1" data-slot="schedule-purpose">
            <div
                data-collapsed={collapsed || undefined}
                className={cn(
                    collapsed &&
                        'max-h-40 overflow-hidden [mask-image:linear-gradient(to_bottom,black_60%,transparent)]',
                )}
            >
                <IssueMarkdown text={text} />
            </div>
            {long && (
                <Button
                    size="sm"
                    variant="ghost"
                    className="justify-self-start px-2"
                    aria-expanded={open}
                    onClick={() => setOpen(!open)}
                >
                    {open ? 'Show less' : 'Show all'}
                </Button>
            )}
        </div>
    );
}
