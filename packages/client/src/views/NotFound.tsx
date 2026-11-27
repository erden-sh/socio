import type { ReactNode } from 'react';
import { Link } from 'react-router';

import { error as EN_US_ERRORS } from '@socio/i18n/locales/en-US/shell.json';
import { useTranslation } from '@socio/i18n/react';
import { SOURCE_LOCALE } from '@socio/i18n/registry';

import { plainHover } from '../lib/plain-button';
import { Mascot } from '../locals/Mascot';

import { cn } from '@/lib/utils';

const WHAT = { Page: 'page', Space: 'space', Socio: 'socio', Conversation: 'conversation' } as const;

/** Unknown URLs, and links to a Dot, chat or Space this user can't see. */
export function NotFound({ what = 'Page' }: { what?: keyof typeof WHAT }) {
    const { t } = useErrorWords();
    return (
        <EmptyPage role="status" title={t('shell:error.not-found.title', { context: WHAT[what] })}>
            <p>{t('shell:error.not-found.why')}</p>
            <Link className={emptyAction} to="/">
                {t('shell:error.not-found.back')}
            </Link>
        </EmptyPage>
    );
}

/**
 * The error pages' words (`shell:error`, which the root inlines). An
 * error page can render without the root's loader data, and so without any
 * dictionary: then it reads en-US's, which come with the code.
 */
export function useErrorWords() {
    // Never suspends: an error page may render outside the page's own instance.
    const translation = useTranslation(['shell'], { useSuspense: false });
    const { i18n } = translation;
    if (
        !i18n.getResource?.(i18n.language, 'shell', 'error.reload') &&
        !i18n.getResource?.(SOURCE_LOCALE, 'shell', 'error.reload')
    ) {
        i18n.addResourceBundle?.(SOURCE_LOCALE, 'shell', { error: EN_US_ERRORS }, true, false);
    }
    return translation;
}

/** The quiet link or button under an empty page's message. */
export const emptyAction = cn(
    'gap-[5px] border-0 bg-transparent p-0 text-[10px] text-[#9296a7] dark:text-[#9da1b2]',
    plainHover,
);

/**
 * A page with nothing to show (NotFound, RouteError): the mascot, a
 * heading and a line or two, in the page frame.
 */
export function EmptyPage({
    role,
    title,
    children,
}: {
    role: 'status' | 'alert';
    title: ReactNode;
    children: ReactNode;
}) {
    return (
        <main className="main-content">
            <div
                className="mx-auto my-15 max-w-110 text-center max-[700px]:mt-7.5 [&_p]:text-[12px] [&_p]:leading-[1.9] [&_p]:text-[#999ba5] dark:[&_p]:text-[#9fa1ab]"
                role={role}
            >
                <Mascot className="size-35 opacity-85" />
                <h2 className="text-[22px]">{title}</h2>
                {children}
            </div>
        </main>
    );
}
