import { useHydrated } from './client-only';

/** A time the same on the server and in every browser: `2026-10-09 15:04 UTC`. */
export const utcTime = (value: number) => `${new Date(value).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

/**
 * A time in the reader's own words (`format`: relative, or in their locale
 * and zone). The server can't know those, so it renders the UTC time, and
 * so does the browser while the page hydrates; then it switches.
 */
export function LocalTime({
    value,
    format,
    className,
    title,
}: {
    value: number;
    format: (value: number) => string;
    className?: string;
    /** A tooltip in the reader's words too (after hydration). */
    title?: (value: number) => string;
}) {
    const hydrated = useHydrated();
    return (
        <time
            dateTime={new Date(value).toISOString()}
            className={className}
            title={hydrated && title ? title(value) : undefined}
        >
            {hydrated ? format(value) : utcTime(value)}
        </time>
    );
}
