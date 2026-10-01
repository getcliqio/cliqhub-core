/**
 * StoredArtifactRepository — CRUD operations for the stored_artifacts table.
 *
 * Thin data-access layer over the Sequelize model. The storage service
 * orchestrates R2 + this repository; callers should not use this directly.
 */

import { StoredArtifact } from '../models/stored_artifact.model.js';
import type { StoredArtifactAttributes, StoredArtifactModel } from '../models/stored_artifact.model.js';
import { BaseRepository } from './base_repository.js';

/** Fields required to create a stored artifact row. */
export type StoredArtifactCreate = StoredArtifactAttributes;

export class StoredArtifactRepository extends BaseRepository<StoredArtifactModel> {
    protected readonly model = StoredArtifact;

    /** Insert a new artifact metadata row. */
    async create(attrs: StoredArtifactCreate): Promise<StoredArtifactModel> {
        return StoredArtifact.create(attrs);
    }

    /** Find a single artifact by primary key. Returns null when not found. */
    async find_by_id(artifact_id: string): Promise<StoredArtifactModel | null> {
        return StoredArtifact.findByPk(artifact_id);
    }

    /** List artifacts for a run, optionally filtered by phase. Ordered by created_at ASC. */
    async find_by_run(run_id: string, phase?: string): Promise<StoredArtifactModel[]> {
        const where: Record<string, string> = { run_id };
        if (phase) where.phase = phase;

        return StoredArtifact.findAll({
            where,
            order: [['created_at', 'ASC']],
        });
    }

    /** Delete an artifact row by primary key. Returns count deleted. */
    async delete_by_id(artifact_id: string): Promise<number> {
        return StoredArtifact.destroy({ where: { id: artifact_id } });
    }
}
