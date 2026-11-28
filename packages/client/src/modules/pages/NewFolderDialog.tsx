import { useState } from 'react';

import { useTranslation } from '@socio/i18n/react';

import { onDemand } from '../../i18n/on-demand';

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

/** A page's longest title, which a folder's name is (`pageInput`). */
const NAME_MAX = 160;

/**
 * New folder (CB-426): its name, then `onCreate`, which makes it where the
 * person is (the library's level, or the folder open). A refusal keeps the
 * dialog open with the reason. Its words load on demand (pages.dialogs).
 */
function NewFolderForm({
    open,
    onOpenChange,
    onCreate,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onCreate: (title: string) => Promise<unknown>;
}) {
    const { t } = useTranslation(['pages.dialogs']);
    const [name, setName] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const title = name.trim();
    const close = (next: boolean) => {
        if (busy) {
            return;
        }
        if (!next) {
            setName('');
            setError('');
        }
        onOpenChange(next);
    };
    const create = async () => {
        if (!title || busy) {
            return;
        }
        setBusy(true);
        setError('');
        try {
            await onCreate(title);
            setBusy(false);
            setName('');
            onOpenChange(false);
        } catch (e) {
            setBusy(false);
            setError(e instanceof Error ? e.message : t('pages.dialogs:folder.failed'));
        }
    };
    return (
        <Dialog open={open} onOpenChange={close}>
            <DialogContent data-slot="new-folder-dialog" className="sm:max-w-md">
                <form
                    className="grid gap-4"
                    onSubmit={(event) => {
                        event.preventDefault();
                        void create();
                    }}
                >
                    <DialogHeader>
                        <DialogTitle>{t('pages.dialogs:folder.title')}</DialogTitle>
                        <DialogDescription>{t('pages.dialogs:folder.description')}</DialogDescription>
                    </DialogHeader>
                    <Input
                        aria-label={t('pages.dialogs:folder.name')}
                        placeholder={t('pages.dialogs:folder.name')}
                        value={name}
                        maxLength={NAME_MAX}
                        onChange={(event) => setName(event.target.value)}
                        autoComplete="off"
                        autoFocus
                    />
                    {error && (
                        <p role="alert" className="m-0 text-sm text-destructive">
                            {error}
                        </p>
                    )}
                    <DialogFooter>
                        <Button type="button" variant="ghost" disabled={busy} onClick={() => close(false)}>
                            {t('pages.dialogs:folder.cancel')}
                        </Button>
                        <Button type="submit" disabled={busy || !title}>
                            {t('pages.dialogs:folder.create')}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

/** New folder (`NewFolderForm`), once its words are in. */
export const NewFolderDialog = onDemand(['pages.dialogs'], NewFolderForm);
