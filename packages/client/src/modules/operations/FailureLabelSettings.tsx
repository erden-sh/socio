import { FAILURE_CATEGORY_LABELS } from '@socio/shared/failure-taxonomy';

import { ClassifyUseCard } from './ClassifyUseCard';

/**
 * Operations → Settings → Failure labels (CB-198): the `failures` use of
 * the classification seam (`ClassifyUseCard`).
 */
export function FailureLabelSettings() {
    return (
        <ClassifyUseCard
            use="failures"
            title="Failure labels"
            slot="failure-label"
            intro={
                <>
                    The rules in Reliability can’t sort every failure: a generic error code stays{' '}
                    {FAILURE_CATEGORY_LABELS.unclassified}. With this on, the workspace’s model reads the failure’s
                    error text, scrubbed of contact details and secrets and cut to 300 characters, and suggests a
                    category. Suggestions count only when the model is sure enough and has passed an evaluation against
                    admins’ labels.
                </>
            }
            switchTitle="Suggest labels for Unclassified failures"
            switchHelp="Off by default. Each failure is asked about once; a failed or invalid answer is not retried. Labels you set in Reliability always count."
            labelName={(label) => FAILURE_CATEGORY_LABELS[label as keyof typeof FAILURE_CATEGORY_LABELS] ?? label}
        />
    );
}
