/**
 * The review packet's artifacts: the run's records (in the order produced, string ids)
 * followed by the files earlier phases stored (downloaded on demand).
 */

import { describe, expect, it, vi } from 'vitest';

const { records, files } = vi.hoisted(() => ({ records: vi.fn(), files: vi.fn() }));
vi.mock('../../../src/repositories/run_artifact_repository.js', () => ({
    RunArtifactRepository: class { find_all_q = records; },
}));
vi.mock('../../../src/repositories/stored_artifact_repository.js', () => ({
    StoredArtifactRepository: class { find_by_run = files; },
}));

import { load_artifacts_for_run } from '../../../src/services/review_enrichment.js';

describe('load_artifacts_for_run', () => {
    it('records by created_at (ids are UUIDs) then stored files, each with its source', async () => {
        records.mockResolvedValue([
            { id: '0b8f…-uuid', phase: 'design', kind: 'output', name: 'phase_output', mime_type: null, content: 'designed', sequence: 0 },
        ]);
        files.mockResolvedValue([
            { id: 'a9', phase: 'build', name: 'app.zip', mime_type: 'application/zip', size_bytes: '4096' },
        ]);
        const out = await load_artifacts_for_run('run-1');
        expect(records).toHaveBeenCalledWith({ where: { run_id: 'run-1' }, order: [['created_at', 'ASC']] });
        expect(files).toHaveBeenCalledWith('run-1');
        expect(out).toEqual([
            { id: '0b8f…-uuid', source: 'record', phase: 'design', kind: 'output', name: 'phase_output', mime_type: null, content: 'designed', content_preview: 'designed', sequence: 0 },
            { id: 'file:a9', source: 'file', artifact_id: 'a9', size_bytes: 4096, phase: 'build', kind: 'file', name: 'app.zip', mime_type: 'application/zip', content: '', content_preview: '', sequence: 1_000_000 },
        ]);
    });
});
