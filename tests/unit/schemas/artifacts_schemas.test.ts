/**
 * Unit tests for stored artifacts Zod schemas — validates accept/reject
 * boundaries for all four endpoint input schemas.
 */

import { describe, it, expect } from 'vitest';
import {
    ArtifactsSubmitInput,
    ArtifactsGetInput,
    ArtifactsGetByIdInput,
    ArtifactsDeleteInput,
} from '../../../src/schemas/artifacts_schemas.js';

describe('ArtifactsSubmitInput', () => {
    const valid = { run_id: 'run-1', phase: 'analyst', name: 'report.md', content: 'hello' };

    it('accepts minimal valid input', () => {
        expect(ArtifactsSubmitInput.parse(valid)).toMatchObject(valid);
    });

    it('accepts optional fields', () => {
        const full = { ...valid, mime_type: 'text/markdown', description: 'Weekly report', encoding: 'base64' as const };
        expect(ArtifactsSubmitInput.parse(full)).toMatchObject(full);
    });

    it('rejects empty run_id', () => {
        expect(() => ArtifactsSubmitInput.parse({ ...valid, run_id: '' })).toThrow();
    });

    it('rejects missing content', () => {
        expect(() => ArtifactsSubmitInput.parse({ run_id: 'r', phase: 'p', name: 'n' })).toThrow();
    });

    it('rejects invalid encoding', () => {
        expect(() => ArtifactsSubmitInput.parse({ ...valid, encoding: 'gzip' })).toThrow();
    });
});

describe('ArtifactsGetInput', () => {
    it('accepts run_id only', () => {
        expect(ArtifactsGetInput.parse({ run_id: 'run-1' })).toMatchObject({ run_id: 'run-1' });
    });

    it('accepts run_id + phase', () => {
        expect(ArtifactsGetInput.parse({ run_id: 'run-1', phase: 'builder' })).toMatchObject({ phase: 'builder' });
    });

    it('rejects empty object', () => {
        expect(() => ArtifactsGetInput.parse({})).toThrow();
    });
});

describe('ArtifactsGetByIdInput', () => {
    it('accepts artifact_id', () => {
        expect(ArtifactsGetByIdInput.parse({ artifact_id: 'art-001' })).toMatchObject({ artifact_id: 'art-001' });
    });

    it('rejects empty artifact_id', () => {
        expect(() => ArtifactsGetByIdInput.parse({ artifact_id: '' })).toThrow();
    });

    it('rejects missing artifact_id', () => {
        expect(() => ArtifactsGetByIdInput.parse({})).toThrow();
    });
});

describe('ArtifactsDeleteInput', () => {
    it('accepts artifact_id', () => {
        expect(ArtifactsDeleteInput.parse({ artifact_id: 'art-001' })).toMatchObject({ artifact_id: 'art-001' });
    });

    it('rejects missing artifact_id', () => {
        expect(() => ArtifactsDeleteInput.parse({})).toThrow();
    });
});
