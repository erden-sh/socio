import { useLayoutEffect, useRef } from 'react';

import { useTranslation } from '@socio/i18n/react';

/** Line breaks (typed, pasted or dropped) become one space: a title is one line. */
export function singleLine(text: string) {
    return text.replace(/\s*[\r\n\p{Zl}\p{Zp}]+\s*/gu, ' ');
}

/**
 * The page title: one line of text that wraps and grows in height when it is
 * longer than the screen is wide (CB-202). A textarea so that it can wrap;
 * Enter moves to the body, and pasted line breaks are dropped.
 */
export function PageTitleField({
    value,
    onChange,
    className,
}: {
    value: string;
    onChange: (value: string) => void;
    className?: string;
}) {
    const { t } = useTranslation(['pages', 'spaces.nav']);
    const field = useRef<HTMLTextAreaElement>(null);
    // Fit the height to the text, also after a resize (a phone turned around).
    useLayoutEffect(() => {
        const el = field.current;
        if (!el) {
            return;
        }
        const fit = () => {
            el.style.height = 'auto';
            el.style.height = `${el.scrollHeight}px`;
        };
        fit();
        if (typeof ResizeObserver === 'undefined') {
            return;
        }
        let width = el.clientWidth;
        const observer = new ResizeObserver(() => {
            if (el.clientWidth === width) {
                return;
            }
            width = el.clientWidth;
            fit();
        });
        observer.observe(el);
        return () => observer.disconnect();
    }, [value]);
    return (
        <textarea
            ref={field}
            data-slot="page-title"
            className={className}
            aria-label={t('pages:title.label')}
            placeholder={t('spaces.nav:untitled-page')}
            maxLength={160}
            rows={1}
            spellCheck
            value={value}
            onChange={(event) => onChange(singleLine(event.target.value))}
            onKeyDown={(event) => {
                if (event.key !== 'Enter' || event.nativeEvent.isComposing) {
                    return;
                }
                event.preventDefault();
                event.currentTarget.closest('article')?.querySelector<HTMLElement>('[data-page-body]')?.focus();
            }}
        />
    );
}
