import { useTranslation } from '@socio/i18n/react';
import { LEARNING_INPUT_CHARS, LEARNING_LABELS, type LearningLabel } from '@socio/shared/classify';

import { onDemand } from '../../i18n/on-demand';

import { ClassifyUseCard } from './ClassifyUseCard';

/**
 * Operations → Settings → Learning triage (CB-200): Learning's `learning`
 * use of the classification seam (`ClassifyUseCard`). Its labels are set
 * in Learning, on each container's Triage list. Its words load on demand,
 * below the fold of Settings (`operations.labeling`).
 */
function LearningTriageCard() {
    const { t } = useTranslation(['operations.labeling']);
    return (
        <ClassifyUseCard
            use="learning"
            title={t('operations.labeling:learning.title')}
            slot="learning-triage"
            intro={t('operations.labeling:learning.intro', { chars: LEARNING_INPUT_CHARS })}
            switchTitle={t('operations.labeling:learning.switch')}
            switchHelp={t('operations.labeling:learning.switch-help')}
            labelName={(label) =>
                label === '(unsure)'
                    ? t('operations.labeling:unsure')
                    : (LEARNING_LABELS as readonly string[]).includes(label)
                      ? t(`operations.labeling:learning.labels.${label as LearningLabel}`)
                      : label
            }
        />
    );
}

export const LearningTriageSettings = onDemand(['operations.labeling'], LearningTriageCard);
