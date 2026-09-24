import { randomUUID } from 'node:crypto';

export type Builder_job_status = 'queued' | 'running' | 'done' | 'error';

export type Builder_job_stage =
	| 'queued'
	| 'designing'
	| 'filling_roles'
	| 'validating'
	| 'done'
	| 'error';

export interface Builder_job_record {
	id: string;
	status: Builder_job_status;
	stage: Builder_job_stage;
	result?: unknown;
	error?: { code: string; message: string };
	created_at: number;
	updated_at: number;
}

const TTL_MS = 15 * 60 * 1000;
const jobs = new Map<string, Builder_job_record>();

function prune(now = Date.now()): void {
	for (const [id, job] of jobs) {
		if (now - job.created_at > TTL_MS) jobs.delete(id);
	}
}

export function create_builder_job(): Builder_job_record {
	prune();
	const now = Date.now();
	const job: Builder_job_record = {
		id: randomUUID(),
		status: 'queued',
		stage: 'queued',
		created_at: now,
		updated_at: now,
	};
	jobs.set(job.id, job);
	return job;
}

export function get_builder_job(job_id: string): Builder_job_record | null {
	prune();
	return jobs.get(job_id) ?? null;
}

export function update_builder_job(
	job_id: string,
	patch: Partial<Pick<Builder_job_record, 'status' | 'stage' | 'result' | 'error'>>,
): Builder_job_record | null {
	const job = jobs.get(job_id);
	if (!job) return null;
	Object.assign(job, patch, { updated_at: Date.now() });
	return job;
}
