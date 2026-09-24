import type { Router, RequestHandler } from 'express';
import { SettingsController } from '../../controllers/hub_settings_controller.js';

export function register_settings_routes(router: Router, auth: RequestHandler): void {
    router.post('/settings/get', auth, SettingsController.get);
    router.post('/settings/get_by_key', auth, SettingsController.get_by_key);
    router.post('/settings/set', auth, SettingsController.set);
    router.post('/settings/remove', auth, SettingsController.remove);
}
