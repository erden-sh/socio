import { LEARNING_INPUT_CHARS, LEARNING_LABEL_NAMES, type LearningLabel } from '@socio/shared/classify';
import { formatNumber } from '@socio/shared/locale';

import { ClassifyUseCard } from './ClassifyUseCard';

/**
 * Operations → Settings → Learning triage (CB-200): Learning's `learning`
 * use of the classification seam (`ClassifyUseCard`). Its labels are set
 * in Learning, on each container's Triage list.
 */
export function LearningTriageSettings() {
    return (
        <ClassifyUseCard
            use="learning"
            title="Learning triage"
            slot="learning-triage"
            intro={`Which finished conversations Learning analyses: the workspace’s model reads each new conversation’s title and what people asked in it, never the replies, scrubbed of contact details and secrets and cut to ${formatNumber(LEARNING_INPUT_CHARS)} characters, and says whether it shows a procedure the team would repeat. Conversations it is sure are one-off stay out of the analysis, so fewer transcripts leave the store. It also checks each proposal for a repeat of a rejected or published skill and for private details, after Learning’s own checks, and starts an analysis when one intent (from Session intent) recurs in five sessions of Learning’s new conversations. Its answers count only once it has passed an evaluation against labels admins set in Learning; a sure “private” drops a proposal even before that.`}
            switchTitle="Triage Learning’s conversations"
            switchHelp="Off by default: Learning then works as before. Each conversation is asked about once each time it finishes; each proposal costs one or two calls."
            labelName={(label) =>
                label === '(unsure)' ? 'Unsure' : (LEARNING_LABEL_NAMES[label as LearningLabel] ?? label)
            }
        />
    );
}
