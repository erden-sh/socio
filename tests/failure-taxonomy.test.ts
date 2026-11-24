import { describe, expect, it } from 'vitest';

import {
    FAILURE_CATEGORIES,
    FAILURE_CATEGORY_HINTS,
    FAILURE_CATEGORY_LABELS,
    FAILURE_RULES,
    failureCategory,
    isFailure,
    TAXONOMY_VERSION,
    type FailureCategory,
    type FailureInput,
} from '@socio/shared/failure-taxonomy';

// The failure taxonomy's rules (CB-164, CB-189): every code the system
// produces lands in the design table's category, first match wins.

type Row = [label: string, input: FailureInput, category: FailureCategory | null, rule: string];

const turn = (input: Omit<FailureInput, 'level'>): FailureInput => ({
    level: 'turn',
    ...input,
});
const failed = (code: string | null, extra: Partial<FailureInput> = {}) =>
    turn({ status: 'failed', endReason: 'error', code, ...extra });
const tool = (name: string, outcome: string, code?: string): FailureInput => ({
    level: 'tool',
    tool: name,
    outcome,
    code,
});

const ROWS: Row[] = [
    // Not failures.
    ['a running turn', turn({ status: 'running' }), null, 'running'],
    ['a completed turn', turn({ status: 'finished', endReason: 'completed' }), null, 'ok'],
    [
        'a turn that recovered from a round error',
        turn({ status: 'finished', endReason: 'completed', code: 'http_503' }),
        null,
        'ok',
    ],
    ['a turn waiting for an approval', turn({ status: 'finished', endReason: 'interrupted' }), null, 'ok'],
    ['a turn from before traces', turn({ status: 'finished' }), null, 'ok'],
    ['a tool that worked', tool('read_page', 'ok'), null, 'ok'],
    ['an approved request', { level: 'approval', status: 'approved' }, null, 'ok'],

    // 1. Stopped.
    ['a person stopped it', turn({ status: 'stopped', endReason: 'stopped' }), 'stopped', 'stopped'],
    [
        'an operator’s force stop',
        turn({ status: 'interrupted', code: 'operator_stopped' }),
        'stopped',
        'operator_stopped',
    ],
    ['paused, or the socio’s permissions changed', failed('stopped'), 'stopped', 'stopped'],
    [
        'a round cut off by Stop',
        turn({ status: 'finished', endReason: 'error', stop: 'cancelled' }),
        'stopped',
        'round_cancelled',
    ],

    // 2. Permissions and approvals.
    ...(
        ['denied', 'forbidden', 'not_allowed', 'permission', 'blocked', 'host_stopped', 'http_401', 'http_403'] as const
    ).map((code): Row => [`a tool refused: ${code}`, tool('http_get', 'refused', code), 'permissions', 'refused']),
    ['a thrown permission error', tool('files_write', 'refused', 'PermissionDeniedError'), 'permissions', 'refused'],
    ['a refusal with no code', tool('computer_click', 'refused'), 'permissions', 'refused_other'],
    ['a denied approval', { level: 'approval', status: 'denied', code: 'web' }, 'permissions', 'approval_denied'],
    ['an expired approval', { level: 'approval', status: 'expired' }, 'permissions', 'approval_expired'],
    ['auto-review said no', { level: 'approval', status: 'failed', code: 'not_allowed' }, 'permissions', 'refused'],

    // 3. Quotas and limits.
    ...(
        [
            'http_429',
            'rate_limited',
            'usage_limit',
            'insufficient_quota',
            'billing_hard_limit_reached',
            'chatgpt_usage_limit',
            'chatgpt_quota_exceeded',
            'chatgpt_rate_limited',
            'time_limit',
            'output_limit',
        ] as const
    ).map((code): Row => [`a turn: ${code}`, failed(code), 'quotas', 'quota_code']),
    ...(['round_cap', 'time_limit', 'output_limit'] as const).map((reason): Row => [
        `a turn that ended at its ${reason}`,
        turn({ status: 'finished', endReason: reason }),
        'quotas',
        'limit_end',
    ]),
    [
        'a time limit that cut a round',
        failed('time_limit', { endReason: 'time_limit', stop: 'cancelled' }),
        'quotas',
        'limit_end',
    ],
    ['a tool rate limited by a site', tool('http_get', 'refused', 'rate_limited'), 'quotas', 'quota_code'],
    ['a search provider’s rate limit', tool('search_web', 'error', 'SearchRateLimitedError'), 'quotas', 'quota_code'],
    ['a tool call cut by the output limit', tool('write_page', 'error', 'output_limit'), 'quotas', 'quota_code'],

    // 4. Not available or not set up.
    ...(['no_inference', 'no_inference_operator', 'no_inference_choice'] as const).map((code): Row => [
        `a turn: ${code}`,
        failed(code),
        'not_available',
        'no_inference',
    ]),
    ...(
        [
            'model_config',
            'chatgpt_not_connected',
            'chatgpt_needs_relogin',
            'chatgpt_not_entitled',
            'chatgpt_login_unavailable',
        ] as const
    ).map((code): Row => [`a turn: ${code}`, failed(code), 'not_available', 'not_set_up']),
    [
        'the browser identity isn’t set up',
        tool('http_get', 'refused', 'browser_identity'),
        'not_available',
        'not_set_up',
    ],
    ['no computer configured', tool('computer_snapshot', 'error', 'not_configured'), 'not_available', 'not_set_up'],
    ['the computer is unavailable', tool('computer_snapshot', 'error', 'unavailable'), 'not_available', 'not_set_up'],
    ['storage isn’t there', tool('save_file', 'error', 'StorageUnavailableError'), 'not_available', 'not_set_up'],
    ['our own service is down', tool('query_dataset', 'error', 'http_503'), 'not_available', 'own_503'],
    ['a model key that is refused', failed('http_401'), 'not_available', 'model_config_http'],

    // 5. Model provider.
    ...(
        [
            'model_unavailable',
            'model_rejected',
            'chatgpt_unavailable',
            'chatgpt_model_unavailable',
            'chatgpt_context_too_long',
            'chatgpt_rejected',
            'chatgpt_unsupported',
            'chatgpt_forbidden',
        ] as const
    ).map((code): Row => [`a turn: ${code}`, failed(code), 'model_provider', 'provider_code']),
    [
        'no model could carry on',
        turn({ status: 'finished', endReason: 'model_unavailable' }),
        'model_provider',
        'provider_code',
    ],
    [
        'an answer the provider filtered',
        turn({
            status: 'finished',
            endReason: 'completed',
            stop: 'content_filter',
        }),
        'model_provider',
        'content_filter',
    ],
    ['a provider’s 5xx with no RUN_ERROR', failed('http_502'), 'model_provider', 'model_http'],
    [
        'a failure after the fallback',
        failed('failed', { fallback: true, detail: true }),
        'model_provider',
        'after_fallback',
    ],

    // 6. Other external services.
    ...(['failed', 'timeout', 'http_502', 'http_503'] as const).map((code): Row => [
        `a web read: ${code}`,
        tool('http_json', 'error', code),
        'external_service',
        'web',
    ]),
    ['a web read that timed out', tool('search_web', 'timeout', 'TimeoutError'), 'external_service', 'web'],
    ['a site refused a web read', tool('http_get', 'refused', 'site_refused'), 'external_service', 'web'],
    [
        'a site refused the computer’s browser',
        tool('computer_browser_open', 'refused', 'site_refused'),
        'external_service',
        'site_refused',
    ],
    ['a notification not delivered', { level: 'delivery', status: 'failed' }, 'external_service', 'outside_work'],
    ['an off-site backup that failed', { level: 'backup', status: 'failed' }, 'external_service', 'outside_work'],

    // 7. Invalid input.
    [
        'arguments the tool couldn’t read',
        tool('write_page', 'error', 'unreadable_arguments'),
        'invalid_input',
        'invalid_code',
    ],
    ['two unreadable tool requests', failed('tool_call'), 'invalid_input', 'invalid_code'],
    ['a web address that isn’t one', tool('http_get', 'error', 'invalid'), 'invalid_input', 'invalid_code'],
    ...(['http_400', 'http_404', 'http_409', 'http_422'] as const).map((code): Row => [
        `a domain error: ${code}`,
        tool('read_page', 'error', code),
        'invalid_input',
        'http_4xx',
    ]),

    // 8. Runtime error.
    [
        'the server stopped mid-turn',
        turn({ status: 'interrupted', endReason: 'interrupted' }),
        'runtime_error',
        'interrupted',
    ],
    [
        'the server stopped a turn after its fallback',
        turn({ status: 'interrupted', endReason: 'interrupted', fallback: true }),
        'runtime_error',
        'interrupted',
    ],
    ['a bare failed turn', failed('failed'), 'runtime_error', 'failed'],
    ['a failed turn with no code', failed(null), 'runtime_error', 'failed'],
    ['a thrown error in a turn', failed('TypeError'), 'runtime_error', 'thrown'],
    ['a thrown error in a tool', tool('run_query', 'error', 'RangeError'), 'runtime_error', 'thrown'],
    ['a nonzero exit code', tool('computer_shell', 'error', 'exit_code'), 'runtime_error', 'tool_failed'],
    ['a tool that reported failed', tool('run_job', 'error', 'failed'), 'runtime_error', 'tool_failed'],
    ['a tool of ours that timed out', tool('run_query', 'timeout', 'TimeoutError'), 'runtime_error', 'own_timeout'],
    ['a domain 500', tool('read_page', 'error', 'http_500'), 'runtime_error', 'http_5xx'],
    ['a job run that failed', { level: 'job', status: 'failed' }, 'runtime_error', 'work_failed'],
    ['a job run that timed out', { level: 'job', status: 'timed_out' }, 'runtime_error', 'own_timeout'],
    ['an app killed for memory', { level: 'app', status: 'failed', code: 'oom' }, 'runtime_error', 'work_failed'],

    // 9. Unclassified.
    ['an uncoded tool error', tool('create_task', 'error', 'tool_error'), 'unclassified', 'generic_code'],
    ['ok:false with no reason', tool('create_task', 'error', 'not_ok'), 'unclassified', 'generic_code'],
    ['a RUN_ERROR with no code', failed('run_error'), 'unclassified', 'generic_code'],
    ['a bare failed with an operator detail', failed('failed', { detail: true }), 'unclassified', 'failed_with_detail'],
    ['a code no rule knows', failed('incomplete-stream'), 'unclassified', 'unmatched'],
    ['a tool code no rule knows', tool('create_task', 'error', 'weird_thing'), 'unclassified', 'unmatched'],
];

describe('failureCategory', () => {
    it.each(ROWS)('%s', (_label, input, category, rule) => {
        const found = failureCategory(input);
        expect(found).toEqual({
            category,
            ruleId: rule,
            ambiguous: rule === 'generic_code' || rule === 'failed_with_detail',
        });
    });

    it('covers every category and every rule', () => {
        const categories = new Set(ROWS.map(([, , category]) => category));
        for (const category of FAILURE_CATEGORIES) {
            expect(categories.has(category), category).toBe(true);
        }
        const rules = new Set(ROWS.map(([, , , rule]) => rule));
        expect(FAILURE_RULES.map((rule) => rule.id).filter((id) => !rules.has(id))).toEqual([]);
        // Rule ids are unique: a drill-down names one.
        expect(new Set(FAILURE_RULES.map((rule) => rule.id)).size).toBe(FAILURE_RULES.length);
    });

    it('has a version, labels and hints, and Stopped is not a failure', () => {
        expect(Number.isInteger(TAXONOMY_VERSION)).toBe(true);
        for (const category of FAILURE_CATEGORIES) {
            expect(FAILURE_CATEGORY_LABELS[category]).toBeTruthy();
            expect(FAILURE_CATEGORY_HINTS[category]).toBeTruthy();
        }
        expect(isFailure('stopped')).toBe(false);
        expect(isFailure(null)).toBe(false);
        expect(isFailure('unclassified')).toBe(true);
    });

    it('reads codes with stray space, and ignores what it isn’t given', () => {
        expect(failureCategory(failed(' chatgpt_usage_limit '))).toMatchObject({
            category: 'quotas',
        });
        expect(failureCategory({ level: 'tool' })).toMatchObject({
            category: 'unclassified',
            ruleId: 'unmatched',
        });
    });
});
