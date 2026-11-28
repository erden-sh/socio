import { useTranslation } from '@socio/i18n/react';
import { FAILURE_CATEGORIES, type FailureCategory } from '@socio/shared/failure-taxonomy';

import { onDemand } from '../../i18n/on-demand';

import { ClassifyUseCard } from './ClassifyUseCard';

/**
 * Operations → Settings → Failure labels (CB-198): the `failures` use of
 * the classification seam (`ClassifyUseCard`). Its words load on demand,
 * below the fold of Settings (`operations.labeling`).
 */
function FailureLabelCard() {
    const { t } = useTranslation(['operations.labeling']);
    return (
        <ClassifyUseCard
            use="failures"
            title={t('operations.labeling:failures.title')}
            slot="failure-label"
            intro={t('operations.labeling:failures.intro', {
                unclassified: t('operations.labeling:failures.categories.unclassified'),
            })}
            switchTitle={t('operations.labeling:failures.switch')}
            switchHelp={t('operations.labeling:failures.switch-help')}
            labelName={(label) =>
                (FAILURE_CATEGORIES as readonly string[]).includes(label)
                    ? t(`operations.labeling:failures.categories.${label as FailureCategory}`)
                    : label
            }
        />
    );
}

export const FailureLabelSettings = onDemand(['operations.labeling'], FailureLabelCard);
