import { useTranslation } from '@socio/i18n/react';

/** The editor's place while its chunk or its words load (and on the server). */
export function EditorLoading() {
    const { t } = useTranslation(['pages']);
    return (
        <div data-slot="editor-loading" className="py-[35px] text-sm text-muted-foreground">
            {t('pages:document.editor-loading')}
        </div>
    );
}
