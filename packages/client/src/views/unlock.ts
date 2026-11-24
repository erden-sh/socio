/**
 * A screen of its own with the mascot, outside the shell: sign-in, the
 * shell's loading screen and AppError. Its paragraphs are small and gray,
 * the error line's too.
 */
export const unlock =
    'mx-auto my-[10vh] max-w-95 p-[25px] text-center [&_form]:flex [&_form]:flex-col [&_form]:gap-3 [&_h1]:text-[28px] [&_p]:text-[12px] [&_p]:text-[#999dab] dark:[&_p]:text-[#9da1af]';

/** An error line on an `unlock` screen. */
export const unlockError =
    'flex items-center justify-between gap-2.5 rounded-[8px] bg-[#faeee8] p-3 leading-[1.8] dark:bg-[#2b2623]';

/** Its main buttons (the accounts, Sign in, Continue). */
export const primary = 'border-[#7689d3] bg-[#7689d3] text-[12px] text-white enabled:hover:bg-[#6177c5]';

/** Its column of account buttons, each a name with a role beside it. */
export const accounts =
    'my-4.5 flex flex-col gap-2.5 [&_button]:flex [&_button]:items-center [&_button]:justify-between [&_small]:text-[10px] [&_small]:opacity-70';
