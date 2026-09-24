/**
 * Hub AuthZ helpers — realm (machines) + scope (packages).
 * Identity comes from the caller JWT; membership is looked up in DB.
 */

import { ApiError } from '../lib/api_error.js';
import { RealmService } from './realm.service.js';

export class AccessService {
	static async list_daemon_ids_for_user(user_id: string): Promise<string[]> {
		return RealmService.list_daemon_ids_for_user(user_id);
	}

	static async assert_realm_access(user_id: string, daemon_id: string): Promise<void> {
		await RealmService.assert_user_can_access_daemon(user_id, daemon_id);
	}

	/** Scope ACL — caller's accessible scope_ids must include target. */
	static assert_scope_access(accessible_scope_ids: string[], scope_id: string): void {
		if (accessible_scope_ids.includes(scope_id)) return;
		throw ApiError.forbidden(`Scope '${scope_id}' is not accessible to this user`);
	}

	/**
	 * Start/install/view team on a daemon: need realm ∩ scope.
	 */
	static async assert_can_run_team_on_daemon(input: {
		user_id: string;
		daemon_id: string;
		scope_id: string;
		accessible_scope_ids: string[];
	}): Promise<void> {
		AccessService.assert_scope_access(input.accessible_scope_ids, input.scope_id);
		await AccessService.assert_realm_access(input.user_id, input.daemon_id);
	}

	/** Runs / logs / status on a daemon — realm only. */
	static async assert_can_observe_daemon(user_id: string, daemon_id: string): Promise<void> {
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
		if (!run.daemon_id) return;
		await AccessService.assert_can_observe_daemon(user_id, run.daemon_id);
	}
}
