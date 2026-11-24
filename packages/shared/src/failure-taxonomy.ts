/**
 * The failure taxonomy (CB-164, CB-189): which of nine categories a
 * failed turn, tool call or other piece of work belongs to, by rules over
 * the short codes the system records (never its messages). Pure: the
 * analytics ETL runs it over every turn and tool call, and runs it again
 * over the stored codes when `TAXONOMY_VERSION` changes, so a rule change
 * needs no rebuild. The first rule that matches wins.
 *
 * What the rules can't tell apart stays `unclassified`, with `ambiguous`
 * set where the code is a generic one ("tool_error", a bare "failed" with
 * an operator detail): those are the rows a classifier may label later.
 */

/** Bump with any change to the rules below: the store re-runs them. */
export const TAXONOMY_VERSION = 1;

export const FAILURE_CATEGORIES = [
    'stopped',
    'permissions',
    'quotas',
    'not_available',
    'model_provider',
    'external_service',
    'invalid_input',
    'runtime_error',
    'unclassified',
] as const;
export type FailureCategory = (typeof FAILURE_CATEGORIES)[number];

/** What admins read for each category. */
export const FAILURE_CATEGORY_LABELS: Record<FailureCategory, string> = {
    stopped: 'Stopped',
    permissions: 'Permissions and approvals',
    quotas: 'Quotas and limits',
    not_available: 'Not available or not set up',
    model_provider: 'Model provider',
    external_service: 'Other external services',
    invalid_input: 'Invalid input',
    runtime_error: 'Runtime error',
    unclassified: 'Unclassified',
};

/** One line on what falls in each category. */
export const FAILURE_CATEGORY_HINTS: Record<FailureCategory, string> = {
    stopped: 'A person or an operator stopped it. Not a failure.',
    permissions: 'A permission, an approval or a site’s rules said no, or an approval expired.',
    quotas: 'A rate limit, a plan’s usage limit, or the turn’s round, time or output limit.',
    not_available:
        'Something isn’t connected or set up: no model, a sign-in that ended, a computer that isn’t configured.',
    model_provider: 'The model was unreachable, busy, refused the request or filtered its answer.',
    external_service: 'A website or another outside service failed or timed out.',
    invalid_input: 'The model sent arguments a tool couldn’t read, or asked for something that doesn’t exist.',
    runtime_error: 'Our own code failed, timed out, or the server stopped mid-turn.',
    unclassified: 'The rules can’t tell from the code alone (a generic error code).',
};

/** What a failure was part of. */
export type FailureLevel = 'turn' | 'tool' | 'approval' | 'job' | 'app' | 'delivery' | 'backup';

/** The raw codes the rules read; what isn't known is left out or null. */
export interface FailureInput {
    level: FailureLevel;
    /** A turn's run status; an approval's, job's or delivery's status. */
    status?: string | null;
    /** A turn's loop end reason (`trace.end.reason`). */
    endReason?: string | null;
    /** The RUN_ERROR code, a round's or a tool's error class, a reason. */
    code?: string | null;
    /** A tool call's outcome: ok, error, refused or timeout. */
    outcome?: string | null;
    /** A tool call's name. */
    tool?: string | null;
    /** How the turn's last model round's output ended. */
    stop?: string | null;
    /** The turn moved to the shared model (CB-140). */
    fallback?: boolean;
    /** The run kept an operator detail (`agent_runs.errorDetail`). */
    detail?: boolean;
}

export interface FailureClass {
    /** Null: not a failure (it finished, or still runs). */
    category: FailureCategory | null;
    /** The rule that matched, for drill-downs and the classifier's queue. */
    ruleId: string;
    /** The code is generic: shown as Unclassified, a classifier may label it. */
    ambiguous: boolean;
}

/** A failure for the dashboard's rates: anything but Stopped. */
export const isFailure = (category: FailureCategory | null | undefined) => !!category && category !== 'stopped';

const set = (...codes: string[]) => new Set(codes);
const PERMISSION_CODES = set(
    'denied',
    'forbidden',
    'not_allowed',
    'permission',
    'blocked',
    'host_stopped',
    'http_401',
    'http_403',
);
const QUOTA_CODES = set(
    'http_429',
    'rate_limited',
    'rate_limit',
    'rate_limit_exceeded',
    'usage_limit',
    'usage_limit_reached',
    'insufficient_quota',
    'billing_hard_limit_reached',
    'chatgpt_usage_limit',
    'chatgpt_quota_exceeded',
    'chatgpt_rate_limited',
    'round_cap',
    'time_limit',
    'output_limit',
    'queue_full',
    // A message's work cycle used its bounds (CB-211).
    'cycle_limit',
    'cycle_tokens',
    'cycle_spend',
    'cycle_handoffs',
    'cycle_rate',
);
const LIMIT_ENDS = set('round_cap', 'time_limit', 'cycle_limit', 'output_limit');
const SETUP_CODES = set(
    'model_config',
    'chatgpt_not_connected',
    'chatgpt_needs_relogin',
    'chatgpt_not_entitled',
    'chatgpt_login_unavailable',
    'browser_identity',
    'not_configured',
    'unavailable',
    'choice_unavailable',
    'draining',
    'not_ready',
);
const PROVIDER_CODES = set(
    'model_unavailable',
    'model_rejected',
    'model_not_found',
    'chatgpt_unavailable',
    'chatgpt_model_unavailable',
    'chatgpt_context_too_long',
    'chatgpt_rejected',
    'chatgpt_unsupported',
    'chatgpt_forbidden',
);
const EXTERNAL_CODES = set('failed', 'timeout', 'site_refused', 'unreachable');
const INVALID_CODES = set(
    'skill_context',
    'unreadable_arguments',
    'tool_call',
    'invalid',
    'bad_request',
    'ZodError',
    'ValidationError',
);
const RUNTIME_TOOL_CODES = set('exit_code', 'failed');
/** Codes that say only that something failed. */
const GENERIC_CODES = set('tool_error', 'run_error', 'Error', 'not_ok');
/** Statuses of work that went through or isn't over. */
const NOT_FAILED = set(
    'ok',
    'running',
    'queued',
    'pending',
    'finished',
    'completed',
    'done',
    'approved',
    'delivered',
    'sent',
    'succeeded',
    'skipped',
);
/** Tools that reach the web: their failures are the sites'. */
const WEB_TOOL = /^(http_|web_|search_web$|fetch_url$|research)/;
const HTTP = /^http_(\d{3})$/;

interface Facts {
    level: FailureLevel;
    status: string;
    endReason: string;
    code: string;
    outcome: string;
    tool: string;
    stop: string;
    fallback: boolean;
    detail: boolean;
    /** The code's HTTP status, if it is one ("http_503"). */
    http: number;
    web: boolean;
}

interface Rule {
    id: string;
    category: FailureCategory | null;
    ambiguous?: true;
    when: (facts: Facts) => boolean;
}

const turn = (f: Facts) => f.level === 'turn';
const tool = (f: Facts) => f.level === 'tool';
const thrown = (code: string) => /^[A-Z]\w*Error$/.test(code) && code !== 'Error';

/**
 * The rules, in order (CB-164's table): first the ones that say it
 * isn't a failure, then one group per category. Exported for the docs
 * and tests; `failureCategory` is how to use them.
 */
export const FAILURE_RULES: readonly Rule[] = [
    // Not failures.
    { id: 'running', category: null, when: (f) => f.status === 'running' },
    {
        id: 'ok',
        category: null,
        when: (f) =>
            tool(f)
                ? f.outcome === 'ok'
                : turn(f)
                  ? f.status === 'finished' &&
                    f.stop !== 'content_filter' &&
                    !LIMIT_ENDS.has(f.endReason) &&
                    f.endReason !== 'model_unavailable' &&
                    f.endReason !== 'error'
                  : NOT_FAILED.has(f.status),
    },

    // 1. Stopped: a person or an operator, not a failure.
    {
        id: 'operator_stopped',
        category: 'stopped',
        when: (f) => f.code === 'operator_stopped',
    },
    {
        id: 'stopped',
        category: 'stopped',
        when: (f) =>
            f.status === 'stopped' || f.status === 'cancelled' || f.code === 'stopped' || f.endReason === 'stopped',
    },
    {
        id: 'round_cancelled',
        category: 'stopped',
        when: (f) => turn(f) && f.stop === 'cancelled' && !f.code && !LIMIT_ENDS.has(f.endReason),
    },

    // 2. Permissions and approvals.
    {
        id: 'approval_denied',
        category: 'permissions',
        when: (f) => f.level === 'approval' && f.status === 'denied',
    },
    {
        id: 'approval_expired',
        category: 'permissions',
        when: (f) => f.level === 'approval' && f.status === 'expired',
    },
    {
        id: 'refused',
        category: 'permissions',
        when: (f) =>
            !turn(f) &&
            (PERMISSION_CODES.has(f.code) ||
                (f.outcome === 'refused' && /denied|forbidden|permission|not_allowed/i.test(f.code))),
    },

    // 3. Quotas and limits.
    {
        id: 'limit_end',
        category: 'quotas',
        when: (f) => turn(f) && LIMIT_ENDS.has(f.endReason),
    },
    {
        id: 'quota_code',
        category: 'quotas',
        when: (f) => QUOTA_CODES.has(f.code) || /rate_?limit/i.test(f.code),
    },

    // 4. Not available or not set up.
    {
        id: 'no_inference',
        category: 'not_available',
        when: (f) => f.code.startsWith('no_inference'),
    },
    {
        id: 'not_set_up',
        category: 'not_available',
        when: (f) => SETUP_CODES.has(f.code) || /^[A-Z]\w*UnavailableError$/.test(f.code),
    },
    {
        id: 'model_config_http',
        category: 'not_available',
        when: (f) => turn(f) && [401, 403, 404].includes(f.http),
    },
    {
        id: 'own_503',
        category: 'not_available',
        when: (f) => !turn(f) && !f.web && f.http === 503,
    },
    // A refusal the codes above don't name: a permission, a site or a person.
    {
        id: 'refused_other',
        category: 'permissions',
        when: (f) => tool(f) && f.outcome === 'refused' && f.code !== 'site_refused',
    },

    // 5. Model provider.
    {
        id: 'provider_code',
        category: 'model_provider',
        when: (f) => PROVIDER_CODES.has(f.code) || f.endReason === 'model_unavailable',
    },
    {
        id: 'content_filter',
        category: 'model_provider',
        when: (f) => turn(f) && f.stop === 'content_filter',
    },
    {
        id: 'model_http',
        category: 'model_provider',
        when: (f) => turn(f) && f.http >= 400,
    },
    {
        id: 'after_fallback',
        category: 'model_provider',
        when: (f) => turn(f) && f.status === 'failed' && f.fallback,
    },

    // 6. Other external services.
    {
        id: 'web',
        category: 'external_service',
        when: (f) =>
            tool(f) &&
            f.web &&
            (EXTERNAL_CODES.has(f.code) ||
                f.http >= 500 ||
                f.outcome === 'timeout' ||
                /timeout|timed_?out/i.test(f.code)),
    },
    {
        id: 'site_refused',
        category: 'external_service',
        when: (f) => f.code === 'site_refused' || f.code === 'unreachable',
    },
    {
        id: 'outside_work',
        category: 'external_service',
        when: (f) => f.level === 'delivery' || f.level === 'backup',
    },

    // 7. Invalid input.
    {
        id: 'invalid_code',
        category: 'invalid_input',
        when: (f) => INVALID_CODES.has(f.code),
    },
    {
        id: 'http_4xx',
        category: 'invalid_input',
        when: (f) => tool(f) && f.http >= 400 && f.http < 500,
    },

    // 8. Runtime error.
    {
        id: 'interrupted',
        category: 'runtime_error',
        when: (f) => turn(f) && f.status === 'interrupted',
    },
    {
        id: 'failed',
        category: 'runtime_error',
        when: (f) => turn(f) && (f.code === 'failed' || (!f.code && f.status === 'failed')) && !f.detail,
    },
    {
        id: 'tool_failed',
        category: 'runtime_error',
        when: (f) => tool(f) && RUNTIME_TOOL_CODES.has(f.code),
    },
    {
        id: 'own_timeout',
        category: 'runtime_error',
        when: (f) =>
            (tool(f) && f.outcome === 'timeout') || f.status === 'timed_out' || /timeout|timed_?out/i.test(f.code),
    },
    {
        id: 'http_5xx',
        category: 'runtime_error',
        when: (f) => !turn(f) && f.http >= 500,
    },
    {
        id: 'thrown',
        category: 'runtime_error',
        when: (f) => thrown(f.code),
    },
    {
        id: 'work_failed',
        category: 'runtime_error',
        when: (f) => (f.level === 'job' || f.level === 'app') && !GENERIC_CODES.has(f.code),
    },

    // 9. Unclassified: generic codes are ambiguous, the rest unmatched.
    {
        id: 'generic_code',
        category: 'unclassified',
        ambiguous: true,
        when: (f) => GENERIC_CODES.has(f.code),
    },
    {
        id: 'failed_with_detail',
        category: 'unclassified',
        ambiguous: true,
        when: (f) => turn(f) && (f.code === 'failed' || !f.code) && f.detail,
    },
    { id: 'unmatched', category: 'unclassified', when: () => true },
];

const word = (value: string | null | undefined) => (typeof value === 'string' ? value.trim() : '');

/** Which category `input` falls in, by the first rule that matches. */
export function failureCategory(input: FailureInput): FailureClass {
    const code = word(input.code);
    const tool = word(input.tool);
    const facts: Facts = {
        level: input.level,
        status: word(input.status),
        endReason: word(input.endReason),
        code,
        outcome: word(input.outcome),
        tool,
        stop: word(input.stop),
        fallback: !!input.fallback,
        detail: !!input.detail,
        http: Number(HTTP.exec(code)?.[1] ?? 0),
        web: WEB_TOOL.test(tool),
    };
    const rule = FAILURE_RULES.find((candidate) => candidate.when(facts))!;
    return {
        category: rule.category,
        ruleId: rule.id,
        ambiguous: !!rule.ambiguous,
    };
}
