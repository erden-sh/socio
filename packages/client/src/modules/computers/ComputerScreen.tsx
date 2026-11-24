import { ArrowUpRight } from 'lucide-react';
import { useEffect, useState } from 'react';
import { z } from 'zod';

import { api } from '../../lib/api';

const screenSchema = z.object({
    base64: z
        .string()
        .regex(/^[A-Za-z0-9+/=]+$/)
        .max(4_000_000),
    url: z.string(),
});

const note = 'm-0 px-3.5 py-3 text-[12px]';

/**
 * The Dot's browser as it is now, refreshed every 3 s while the tab is
 * shown: under the steps of the turn that last used it (CB-72), while
 * that turn's trace is open. The button opens the computer panel.
 */
export function ComputerScreen({
    dotId,
    dotName,
    onExpand,
}: {
    dotId: string;
    dotName: string;
    onExpand?: () => void;
}) {
    const [screen, setScreen] = useState<z.infer<typeof screenSchema>>();
    const [screenError, setScreenError] = useState('');
    useEffect(() => {
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout>;
        setScreen(undefined);
        setScreenError('');
        const refresh = async () => {
            if (!document.hidden) {
                try {
                    const value = await api<unknown>(
                        `/dots/${encodeURIComponent(dotId)}/computer/actions`,
                        'POST',
                        { action: 'screenshot', input: {} },
                        controller.signal,
                    );
                    const next = screenSchema.parse(value);
                    if (!controller.signal.aborted) {
                        setScreen(next);
                        setScreenError('');
                    }
                } catch (cause) {
                    if (!controller.signal.aborted) {
                        setScreen(undefined);
                        setScreenError(cause instanceof Error ? cause.message : 'Computer preview unavailable.');
                    }
                }
            }
            if (!controller.signal.aborted) {
                timer = setTimeout(() => void refresh(), 3000);
            }
        };
        void refresh();
        return () => {
            controller.abort();
            clearTimeout(timer);
        };
    }, [dotId]);
    return (
        <section
            className="mt-2 w-full flex-none overflow-hidden rounded-[14px] border border-[#e4e5e7] bg-white text-[#34373d] dark:border-[#343435] dark:bg-card dark:text-[#d6dae2]"
            aria-label={`${dotName} computer: current browser view`}
        >
            <div className="border-t border-t-[#e9eaec] bg-[#f6f7f8] dark:border-t-[#303031] dark:bg-[#232324]">
                <div className="flex items-center gap-[7px] px-3.5 py-2.5 text-[11px] text-[#67736e] dark:text-[#a1aea8]">
                    <span className="size-1.5 rounded-[50%] bg-[#648979]" />
                    {dotName}’s computer · Current browser view
                    {onExpand && (
                        <button
                            className="ml-auto grid size-7 cursor-pointer place-items-center rounded-[7px] border-0 bg-transparent text-inherit enabled:hover:bg-[#f2f3f5] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#6875bd] dark:enabled:hover:bg-[#252627] dark:focus-visible:outline-[#909fea]"
                            type="button"
                            aria-label={`Expand ${dotName} computer`}
                            onClick={onExpand}
                        >
                            <ArrowUpRight size={16} />
                        </button>
                    )}
                </div>
                {screen && (
                    <img
                        className="block max-h-85 w-full bg-white object-contain object-top dark:bg-card"
                        src={`data:image/png;base64,${screen.base64}`}
                        alt={`Current browser view from ${dotName}'s computer`}
                    />
                )}
                {screenError ? (
                    <p className={note} role="status">
                        {screenError}
                    </p>
                ) : (
                    !screen && (
                        <p className={note} role="status">
                            Connecting to computer…
                        </p>
                    )
                )}
                {screen && (
                    <div className="truncate border-t border-t-[#e9eaec] px-3.5 py-[9px] text-[11px] text-[#70757c] dark:border-t-[#303031] dark:text-[#a2a7af]">
                        {screen.url}
                    </div>
                )}
            </div>
        </section>
    );
}
