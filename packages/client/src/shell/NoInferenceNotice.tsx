import { PlugZap } from 'lucide-react';

import { useTranslation } from '@socio/i18n/react';
import { NO_INFERENCE_MESSAGES, type ModelChoice, type ModelOptions } from '@socio/shared/inference';

import { modelAvailability } from '../modules/chat/ModelSelect';

import { useShell } from './shell-context';

import { Button } from '@/components/ui/button';

/**
 * The chat's state when no model is available to the signed-in user:
 * connect a subscription in Account → Inference when an operator allows
 * one, else ask an operator. Turns sent anyway end with the same message.
 */
export function NoInferenceNotice({ choice, options }: { choice?: ModelChoice | null; options?: ModelOptions }) {
    const { t } = useTranslation(['shell']);
    const { workspace, openTarget } = useShell();
    const inference = workspace.setup.inference;
    if (modelAvailability(choice, options, inference?.available) !== false) {
        return null;
    }
    return (
        <div
            role="status"
            data-slot="no-inference"
            className="mx-auto my-3 flex w-full max-w-2xl items-start gap-3 rounded-lg border border-amber-300/60 bg-amber-50 px-4 py-3 text-sm text-amber-950 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100"
        >
            <PlugZap className="mt-0.5 size-5 shrink-0" aria-hidden />
            <div className="grid flex-1 gap-2">
                <p>
                    {choice
                        ? NO_INFERENCE_MESSAGES.choice
                        : inference?.byoAllowed
                          ? NO_INFERENCE_MESSAGES.connect
                          : NO_INFERENCE_MESSAGES.operator}
                </p>
                {inference?.byoAllowed && (
                    <div>
                        <Button size="sm" variant="outline" onClick={() => openTarget({ path: '/settings/inference' })}>
                            {t('shell:no-inference.open')}
                        </Button>
                    </div>
                )}
            </div>
        </div>
    );
}
