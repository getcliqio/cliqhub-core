/**
 * Unit tests for stored artifacts Zod schemas — validates accept/reject
 * boundaries for the artifacts endpoint inputs.
 */

import { describe, it, expect } from 'vitest';
import {
    ArtifactsDownloadInput,
    ArtifactsUploadQuery,
    ArtifactsGetInput,
    ArtifactsGetByIdInput,
    ArtifactsDeleteInput,
} from '../../../src/schemas/artifacts_schemas.js';

describe('ArtifactsUploadQuery', () => {
    it('takes a run target (the daemon\'s run artifact)', () => {
        expect(ArtifactsUploadQuery.parse({ run_id: 'r', phase: 'p', name: 'lld.md' })).toMatchObject({ run_id: 'r', phase: 'p' });
    });

    it('refuses a Hug target (people answer in getHugs), no target, half a run target, and a missing name', () => {
        expect(() => ArtifactsUploadQuery.parse({ hug_id: 'h', requested_input: 'contract', name: 'MSA.pdf' })).toThrow();
        expect(() => ArtifactsUploadQuery.parse({ name: 'n' })).toThrow();
        expect(() => ArtifactsUploadQuery.parse({ run_id: 'r', name: 'n' })).toThrow();
        expect(() => ArtifactsUploadQuery.parse({ run_id: 'r', phase: 'p' })).toThrow();
    });
});

describe('ArtifactsDownloadInput', () => {
    it('takes an artifact id', () => {
        expect(ArtifactsDownloadInput.parse({ artifact_id: 'a' })).toEqual({ artifact_id: 'a' });
        expect(() => ArtifactsDownloadInput.parse({})).toThrow();
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
