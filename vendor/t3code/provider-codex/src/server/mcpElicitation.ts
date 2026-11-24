/**
 * MCP elicitation response builder (CB-326 step 4): maps a T3
 * `ProviderApprovalDecision` to a codex `McpServerElicitationRequestResponse`.
 *
 * This is the `toMcpElicitationResponse` half of T3's
 * `apps/server/src/provider/CodexMcpElicitation.ts` (MIT, pingdotgg/t3code),
 * trimmed to the response builder Socio's adapter needs. The
 * `describeMcpElicitation` half (options for T3's own approval UI) is left
 * out: Socio's runtime card shows the kind label and the agent's message,
 * not a form, so the option set is not built here.
 *
 * On `accept`, the form's default values fill the content; if a required
 * field has no default and no chosen option, the elicitation is declined
 * (the agent is told the user declined) — matching codex's expectation that
 * an accepted elicitation carry the form's required fields. `url`-mode
 * elicitations are always declined (T3 does the same: no URL approval UI).
 */
import type { ProviderApprovalDecision } from '@t3tools/contracts';
import * as Schema from 'effect/Schema';
import type * as EffectCodexSchema from 'effect-codex-app-server/schema';

const NullableMcpElicitationString = Schema.NullOr(Schema.String);

const McpElicitationFormField = Schema.Struct({
  type: Schema.optionalKey(NullableMcpElicitationString),
  title: Schema.optionalKey(NullableMcpElicitationString),
  description: Schema.optionalKey(NullableMcpElicitationString),
  default: Schema.optionalKey(Schema.Json),
  enum: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
  enumNames: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
  oneOf: Schema.optionalKey(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          const: Schema.String,
          title: Schema.optionalKey(NullableMcpElicitationString),
        }),
      ),
    ),
  ),
});
const McpElicitationForm = Schema.Struct({
  properties: Schema.optionalKey(Schema.Record(Schema.String, McpElicitationFormField)),
  required: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
});
const isMcpElicitationForm = Schema.is(McpElicitationForm);

type McpElicitationResponseInput = {
  readonly mode: string;
  readonly requestedSchema?: unknown;
};

function mcpElicitationFormFields(payload: McpElicitationResponseInput) {
  if (payload.mode === 'url' || !isMcpElicitationForm(payload.requestedSchema)) {
    return undefined;
  }
  return payload.requestedSchema;
}

function mcpElicitationFieldOptions(field: typeof McpElicitationFormField.Type) {
  if (field.oneOf) {
    return field.oneOf.map((option) => ({ value: option.const, label: option.title }));
  }
  return (field.enum ?? []).map((value, index) => ({
    value,
    label: field.enumNames?.[index],
  }));
}

/**
 * Maps a T3 approval decision to the codex MCP elicitation response. On
 * `accept`/`acceptForSession`/`acceptAlways` the form's defaults fill the
 * content (and `_meta.persist` records the session/always scope); if a
 * required field can't be filled, the elicitation is declined. `decline` and
 * `cancel` pass through. `url`-mode elicitations are always declined.
 */
export function toMcpElicitationResponse(
  payload: EffectCodexSchema.McpServerElicitationRequestParams,
  decision: ProviderApprovalDecision,
): EffectCodexSchema.McpServerElicitationRequestResponse {
  if (decision === 'decline' || decision === 'cancel') {
    return { action: decision };
  }

  if (payload.mode === 'url') {
    return { action: 'decline' };
  }

  const persist =
    decision === 'acceptForSession'
      ? 'session'
      : decision === 'acceptAlways'
        ? 'always'
        : undefined;
  const form = mcpElicitationFormFields(payload);
  const content: Record<string, Schema.Json> = {};

  for (const [key, field] of Object.entries(form?.properties ?? {})) {
    const options = mcpElicitationFieldOptions(field);
    const chosenOption = options.find((option) =>
      persist
        ? /^(?:session|always|permanent|forever|persistent)$/i.test(option.value.trim())
        : /^(?:once|accept|approve|allow)(?:[_\s-]*(?:once(?:[_\s-]*only)?|this[_\s-]*time))?$/i.test(
            option.value.trim(),
          ),
    );
    if (chosenOption) {
      content[key] = chosenOption.value;
    } else if (field.default !== undefined && field.default !== null) {
      content[key] = field.default;
    }
  }

  if (form?.required?.some((key) => !Object.hasOwn(content, key))) {
    return { action: 'decline' };
  }

  return {
    action: 'accept',
    ...(persist ? { _meta: { persist } } : {}),
    ...(form ? { content } : {}),
  };
}
