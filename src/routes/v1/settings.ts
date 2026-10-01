/**
 * Settings routes — Hub key-value settings get, get by key, set, and remove.
 *
 * POST   /v1/settings/get
 * POST   /v1/settings/get_by_key
 * POST   /v1/settings/set
 * POST   /v1/settings/remove
 */
import type { Router } from 'express';
import { SettingsController } from '../../controllers/hub_settings_controller.js';

export function register_settings_routes(router: Router): void {
    router.post('/settings/get', SettingsController.get);
    router.post('/settings/get_by_key', SettingsController.get_by_key);
    router.post('/settings/set', SettingsController.set);
    router.post('/settings/remove', SettingsController.remove);
}
