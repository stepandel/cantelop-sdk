import { execFile } from 'node:child_process';
import { chmod, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

// Registry packages carry every supported binary. Source builds need Go;
// consumers never compile, download, or find a helper through PATH at runtime.
const supported = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'];
const host = `${process.platform}-${process.arch}`;
const targets = process.argv.includes('--all') ? supported : supported.includes(host) ? [host] : [];
const run = promisify(execFile);
for (const target of targets) {
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
}
