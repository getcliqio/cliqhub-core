/**
 * An app served on 127.0.0.1, for supertest.
 *
 * `request(app)` listens on port 0 on every address but connects to 127.0.0.1:<port>. When the kernel hands out a
 * port that another process already holds on 127.0.0.1 only (a local proxy, say), the listen still succeeds and the
 * request reaches that process instead: a stray 407 from a proxy, once in a few thousand requests. Listening on
 * 127.0.0.1 itself means the kernel only hands out a free port there.
 */
import http, { type Server } from 'node:http';

/** Serve `app` on a free 127.0.0.1 port; pass the server to `request()`. */
export async function on_loopback(app: http.RequestListener): Promise<Server> {
    const server = http.createServer(app);
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve());
    });
    return server;
}

export function close_server(server: Server | undefined): Promise<void> {
    return new Promise((resolve) => (server ? server.close(() => resolve()) : resolve()));
}
