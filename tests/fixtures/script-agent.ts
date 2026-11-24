import { AbstractAgent, EventType, type BaseEvent, type RunAgentInput } from '@ag-ui/client';
import { Observable } from 'rxjs';

/**
 * Answers with `reply`; with `hold`, streams the start and waits for abort;
 * with `failure`, ends with that RUN_ERROR instead of finishing.
 */
export class ScriptAgent extends AbstractAgent {
    aborted = false;
    private release?: () => void;
    constructor(
        private reply: string,
        private hold = false,
        private failure?: BaseEvent,
    ) {
        super({});
    }
    run(input: RunAgentInput): Observable<BaseEvent> {
        return new Observable<BaseEvent>((subscriber) => {
            const id = `answer-${input.runId}`;
            subscriber.next({
                type: EventType.RUN_STARTED,
                threadId: input.threadId,
                runId: input.runId,
            } as BaseEvent);
            subscriber.next({
                type: EventType.TEXT_MESSAGE_START,
                messageId: id,
                role: 'assistant',
            } as BaseEvent);
            subscriber.next({
                type: EventType.TEXT_MESSAGE_CONTENT,
                messageId: id,
                delta: this.reply,
            } as BaseEvent);
            const finish = () => {
                subscriber.next({
                    type: EventType.TEXT_MESSAGE_END,
                    messageId: id,
                } as BaseEvent);
                subscriber.next(
                    this.failure ??
                        ({
                            type: EventType.RUN_FINISHED,
                            threadId: input.threadId,
                            runId: input.runId,
                        } as BaseEvent),
                );
                subscriber.complete();
            };
            if (!this.hold) {
                finish();
            } else if (this.aborted) {
                subscriber.complete();
            } else {
                this.release = () => subscriber.complete();
            }
        });
    }
    abortRun() {
        this.aborted = true;
        this.release?.();
    }
}
