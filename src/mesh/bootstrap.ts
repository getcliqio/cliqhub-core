import { register_mesh_adapter } from './registry.js';
import { svantic_mesh_adapter } from './adapters/svantic.adapter.js';

let bootstrapped = false;

/** Register built-in mesh adapters once per process. */
export function bootstrap_mesh_adapters(): void {
    if (bootstrapped) return;
    register_mesh_adapter(svantic_mesh_adapter);
    bootstrapped = true;
}

/** Test helper. */
export function reset_mesh_bootstrap(): void {
    bootstrapped = false;
}
