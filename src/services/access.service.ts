/**
 * Hub AuthZ helpers — realm (machines). Who may see a team is `auth/access.ts`.
 * Identity comes from the caller JWT; membership is looked up in DB.
 */

import { ApiError } from '../lib/api_error.js';
import { RealmService } from './realm.service.js';
import { get_logger } from '../lib/log.js';

const log = get_logger('svc.access');

export class AccessService {
	static async list_daemon_ids_for_user(user_id: string): Promise<string[]> {
		log.debug('list_daemon_ids_for_user', { user_id });
		return RealmService.list_daemon_ids_for_user(user_id);
	}

	static async assert_realm_access(user_id: string, daemon_id: string): Promise<void> {
		log.debug('assert_realm_access', { user_id, daemon_id });
		await RealmService.assert_user_can_access_daemon(user_id, daemon_id);
	}

	/** Runs / logs / status on a daemon — realm only. */
	static async assert_can_observe_daemon(user_id: string, daemon_id: string): Promise<void> {
		log.debug('assert_can_observe_daemon', { user_id, daemon_id });
		await AccessService.assert_realm_access(user_id, daemon_id);
	}

	/**
	 * Observe a Hub run: if assigned to a daemon, require realm membership.
	 * Runs with no daemon_id are Hub-only rows (no machine ACL).
	 */
	static async assert_can_observe_run(
		user_id: string,
		run: { daemon_id?: string | null },
	): Promise<void> {
		log.debug('assert_can_observe_run', { user_id, daemon_id: run.daemon_id });
		if (!run.daemon_id) return;
		await AccessService.assert_can_observe_daemon(user_id, run.daemon_id);
	}
}
