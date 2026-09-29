// Spawns the real Parley server (server/index.ts, unmodified) on a scratch
// port, pointed at a fake Gemini upstream via the redirect-upstream preload.
// The child is stopped by its own PID only — never by pattern — so a
// production process with a similar command line is never touched.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = /** @type {import('node:net').AddressInfo} */ (srv.address());
      srv.close(() => resolve(port));
    });
  });
}

/**
 * @param {object} opts
 * @param {string} opts.upstreamUrl  ws:// URL of the fake Gemini
 * @param {number} [opts.port]
 * @param {Record<string,string>} [opts.env]
 */
export async function startParley({ upstreamUrl, port, env = {} }) {
  const listenPort = port ?? (await freePort());
  const dataDir = mkdtempSync(path.join(tmpdir(), 'parley-harness-'));
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', '--import', './test/harness/redirect-upstream.mjs', 'server/index.ts'],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        GOOGLE_API_KEY: 'harness-fake-key',
        PORT: String(listenPort),
        WARMUP: '0',
        DATA_DIR: dataDir,
        PARLEY_FAKE_UPSTREAM: upstreamUrl,
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const logs = [];
  child.stdout.on('data', (d) => logs.push(d.toString()));
  child.stderr.on('data', (d) => logs.push(d.toString()));

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${logs.join('')}`)), 15000);
    const onData = (d) => {
      if (d.toString().includes('listening')) {
        clearTimeout(timer);
        child.stdout.off('data', onData);
        resolve(undefined);
      }
    };
    child.stdout.on('data', onData);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited early (${code}):\n${logs.join('')}`));
    });
  });

  return {
    port: listenPort,
    pid: child.pid,
    url: `http://127.0.0.1:${listenPort}`,
    wsUrl: `ws://127.0.0.1:${listenPort}/live`,
    logs,
    async stop() {
      if (child.exitCode === null) {
        process.kill(/** @type {number} */ (child.pid), 'SIGKILL');
        await new Promise((resolve) => child.once('exit', resolve));
      }
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
