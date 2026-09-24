/**
 * Sequelize handle for core_api services — same connection as Hub control-plane store.
 */

import type { Sequelize } from 'sequelize';

import { get_control_plane_store } from '../db/control_plane_store.js';

export function get_sequelize(): Sequelize {
    return get_control_plane_store().sequelize;
}
