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
    it('takes a run target (daemon) or a Hug target (responder)', () => {
        expect(ArtifactsUploadQuery.parse({ run_id: 'r', phase: 'p', name: 'lld.md' })).toMatchObject({ run_id: 'r', phase: 'p' });
        expect(ArtifactsUploadQuery.parse({ hug_id: 'h', requested_input: 'contract', name: 'MSA.pdf' })).toMatchObject({ hug_id: 'h' });
    });

    it('refuses both targets, neither, half a run target, and a missing name', () => {
        expect(() => ArtifactsUploadQuery.parse({ run_id: 'r', phase: 'p', hug_id: 'h', requested_input: 'c', name: 'n' })).toThrow();
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
