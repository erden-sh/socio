import { X_POST_LIMIT, weightedLength } from '@socio/shared/x-post';

import { cn } from '@/lib/utils';

/** Weighted length against the account limit, as a ring and a number. */
export function CountRing({ text, limit = X_POST_LIMIT }: { text: string; limit?: number }) {
    const count = weightedLength(text);
    const over = count > limit;
    const portion = Math.min(1, count / limit);
    const radius = 14;
    const turn = 2 * Math.PI * radius;
    return (
        <div className="flex items-center gap-2" data-count>
            <svg width="36" height="36" viewBox="0 0 36 36" aria-hidden="true">
                <circle cx="18" cy="18" r={radius} fill="none" stroke="var(--muted)" strokeWidth="3" />
                <circle
                    cx="18"
                    cy="18"
                    r={radius}
                    fill="none"
                    stroke={over ? 'var(--destructive)' : 'var(--brand)'}
                    strokeWidth="3"
                    strokeLinecap="round"
                    strokeDasharray={`${turn * portion} ${turn}`}
                    transform="rotate(-90 18 18)"
                />
            </svg>
            <span className={cn('text-xs tabular-nums text-muted-foreground', over && 'font-medium text-destructive')}>
                <span className="sr-only">Characters </span>
                {count} / {limit}
            </span>
        </div>
    );
}
