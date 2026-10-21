// node-pty 1.1 ships its macOS prebuilt spawn-helper without the exec bit, so every spawn fails with
// "posix_spawnp failed". Restore it after install.
const { chmodSync, existsSync } = require('node:fs');
const { dirname, join } = require('node:path');

const root = dirname(require.resolve('node-pty/package.json'));
for (const rel of ['prebuilds/darwin-arm64/spawn-helper', 'prebuilds/darwin-x64/spawn-helper', 'build/Release/spawn-helper']) {
  const p = join(root, rel);
  if (existsSync(p)) {
    chmodSync(p, 0o755);
    console.log(`chmod +x ${p}`);
  }
}
