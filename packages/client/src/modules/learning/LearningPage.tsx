import { MODULE_IDS } from '@socio/shared/modules';

import { useShell } from '../../shell/shell-context';
import { WorkspacePage } from '../../views/WorkspacePage';

import { LearningView, type LearningSeed } from './LearningView';

/** `/learning`: Learning for admins, Skills for members. */
export function LearningPage({ initial }: { initial?: LearningSeed } = {}) {
    const { admin } = useShell();
    return (
        <WorkspacePage
            slot="learning-page"
            module={MODULE_IDS.learning}
            title={admin ? 'What your socios are learning.' : 'Skills.'}
            description={
                admin
                    ? 'Proposals come from the team’s finished conversations. Nothing reaches a socio until you publish it.'
                    : 'Procedures your socios have learned, reviewed by an admin.'
            }
        >
            <LearningView initial={initial} />
        </WorkspacePage>
    );
}
