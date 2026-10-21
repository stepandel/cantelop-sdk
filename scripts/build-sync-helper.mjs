import { execFile } from 'node:child_process';
import { chmod, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

// Registry packages carry every supported binary. Source builds need Go;
// consumers never compile, download, or find a helper through PATH at runtime.
export const SYNC_HELPER_TARGETS = Object.freeze(['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64']);
const run = promisify(execFile);

export async function buildSyncHelpers({ all = false } = {}) {
  const host = `${process.platform}-${process.arch}`;
  const targets = all ? SYNC_HELPER_TARGETS : SYNC_HELPER_TARGETS.includes(host) ? [host] : [];
  await Promise.all(targets.map(async target => {
    const [platform, arch] = target.split('-');
    const directory = new URL(`../dist/native/${target}/`, import.meta.url);
    await mkdir(directory, { recursive: true });
    const binary = fileURLToPath(new URL('sync-helper', directory));
    await run('go', ['build', '-mod=readonly', '-trimpath', '-buildvcs=false', '-ldflags=-s -w -buildid=', '-o', binary, '.'], {
      cwd: fileURLToPath(new URL('../native/', import.meta.url)),
      env: { ...process.env, CGO_ENABLED: '0', GOOS: platform, GOARCH: arch === 'x64' ? 'amd64' : arch },
      maxBuffer: 1024 * 1024,
    });
    await chmod(binary, 0o755);
  }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await buildSyncHelpers({ all: process.argv.includes('--all') });
