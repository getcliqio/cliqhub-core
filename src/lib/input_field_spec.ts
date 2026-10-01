/**
 * InputFieldSpecUtil — coerce raw agent manifest input definitions into typed specs.
 *
 * Manifest `inputs` can be an array of spec objects or a plain key→meta map.
 * `InputFieldSpecUtil.coerce` normalises both forms into `InputFieldSpec[]` so
 * downstream code (agent registration, package parsing) works with a single shape.
 */

export interface InputFieldSpec {
    name: string;
    label?: string;
    type?: InputFieldType;
    required?: boolean;
    help?: string;
    description?: string;
    default?: unknown;
    choices?: string[];
    placeholder?: string;
}

export type InputFieldType =
    | 'text'
    | 'textarea'
    | 'number'
    | 'boolean'
    | 'select'
    | 'channel';

export const INPUT_FIELD_TYPES: ReadonlySet<string> = new Set([
    'text', 'textarea', 'number', 'boolean', 'select', 'channel',
]);

export class InputFieldSpecUtil {
    private static coerce_one(raw: unknown): InputFieldSpec | null {
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
     * Normalise a raw manifest `inputs` array into typed {@link InputFieldSpec} objects.
     *
     * Entries with a missing or non-string `name` are silently dropped.
     * Unknown `type` values fall back to `"text"`.
     *
     * @param raw - The raw value of `manifest.inputs` (expected array of objects).
     * @returns Validated array of {@link InputFieldSpec}, empty on malformed input.
     */
    static coerce(raw: unknown): InputFieldSpec[] {
        if (!Array.isArray(raw)) return [];
        return raw
            .map(InputFieldSpecUtil.coerce_one)
            .filter((s): s is InputFieldSpec => s !== null);
    }
}
