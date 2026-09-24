/**
 * Canonical input field specification — shared between daemon, SDK, Hub,
 * and frontend.
 *
 * Used for both team-level inputs (declared in `team.yml inputs:`) and
 * HUG review inputs (declared in `phases[].review.inputs`).
 *
 * Backward compatible: inputs with only `name` and `required` default
 * to `type: 'text'`.
 */
export interface InputFieldSpec {
    /** Input name — used as the key in `{{inputs.<name>}}` templates. */
    name: string;
    /** Display label. Defaults to `name` if omitted. */
    label?: string;
    /** Field type. Defaults to `'text'` if omitted. */
    type?: InputFieldType;
    /** Whether the input is required. Defaults to false. */
    required?: boolean;
    /** Description / help text shown below the field. */
    help?: string;
    /** Human-readable description (legacy alias for `help`). */
    description?: string;
    /** Default value. */
    default?: unknown;
    /** Available options for `select` type. */
    choices?: string[];
    /** Placeholder text for text-like inputs. */
    placeholder?: string;
}

/**
 * All supported input field types.
 *
 * - `text`: single-line text input
 * - `textarea`: multi-line text input
 * - `number`: numeric input
 * - `boolean`: checkbox / toggle
 * - `select`: dropdown from `choices`
 * - `channel`: user/channel picker (multi-select, values are string[])
 */
export type InputFieldType =
    | 'text'
    | 'textarea'
    | 'number'
    | 'boolean'
    | 'select'
    | 'channel';

/** All valid type strings for runtime validation. */
export const INPUT_FIELD_TYPES: ReadonlySet<string> = new Set([
    'text', 'textarea', 'number', 'boolean', 'select', 'channel',
]);

/**
 * Coerce a raw object (from YAML parse or wire) into a validated
 * `InputFieldSpec`. Returns null if the object is not a valid spec.
 */
export function coerce_input_field_spec(raw: unknown): InputFieldSpec | null {
    if (!raw || typeof raw !== 'object') return null;
    const obj = raw as Record<string, unknown>;

    const name = typeof obj['name'] === 'string' ? obj['name'].trim() : '';
    if (!name) return null;

    const raw_type = typeof obj['type'] === 'string' ? obj['type'].trim() : 'text';
    const type: InputFieldType = INPUT_FIELD_TYPES.has(raw_type)
        ? (raw_type as InputFieldType)
        : 'text';

    const choices = Array.isArray(obj['choices'])
        ? (obj['choices'] as unknown[]).filter((c): c is string => typeof c === 'string')
        : undefined;

    const spec: InputFieldSpec = { name, type };

    if (typeof obj['label'] === 'string') spec.label = obj['label'];
    if (typeof obj['required'] === 'boolean') spec.required = obj['required'];
    if (typeof obj['help'] === 'string') spec.help = obj['help'];
    if (typeof obj['description'] === 'string') spec.description = obj['description'];
    if (obj['default'] !== undefined) spec.default = obj['default'];
    if (choices && choices.length > 0) spec.choices = choices;
    if (typeof obj['placeholder'] === 'string') spec.placeholder = obj['placeholder'];

    return spec;
}

/**
 * Coerce an array of raw objects into validated `InputFieldSpec[]`.
 * Invalid entries are silently dropped.
 */
export function coerce_input_field_specs(raw: unknown): InputFieldSpec[] {
    if (!Array.isArray(raw)) return [];
    return raw
        .map(coerce_input_field_spec)
        .filter((s): s is InputFieldSpec => s !== null);
}
