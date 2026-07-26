import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const bridgeDir = dirname(dirname(fileURLToPath(import.meta.url)));
process.chdir(bridgeDir);

const bundlePath = 'dist/broker-bridge.cjs';
const fuse = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
const hostBinary = process.env.NODE_SEA_BINARY || process.execPath;
const outputPath = process.platform === 'win32' ? 'dist/broker-bridge.exe' : 'dist/broker-bridge';

if (!existsSync(bundlePath)) {
  console.error('dist/broker-bridge.cjs not found; run npm run bundle first');
  process.exit(1);
}

if (!readFileSync(hostBinary).includes(Buffer.from(fuse))) {
  console.error(`Cannot package SEA with ${hostBinary}: shared-libnode builds cannot host a SEA blob. Use NODE_SEA_BINARY=/path/to/official/node.`);
  process.exit(1);
}

writeFileSync('dist/sea-config.json', JSON.stringify({
  main: bundlePath,
  output: 'dist/sea-prep.blob',
  disableExperimentalSEAWarning: true,
}));
execFileSync(hostBinary, ['--experimental-sea-config', 'dist/sea-config.json'], { stdio: 'inherit' });

copyFileSync(hostBinary, outputPath);
chmodSync(outputPath, 0o755);
if (process.platform === 'darwin') {
  execFileSync('codesign', ['--remove-signature', outputPath], { stdio: 'inherit' });
}

const postjectArgs = [outputPath, 'NODE_SEA_BLOB', 'dist/sea-prep.blob', '--sentinel-fuse', fuse];
if (process.platform === 'darwin') postjectArgs.push('--macho-segment-name', 'NODE_SEA');
execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['postject', ...postjectArgs], { stdio: 'inherit' });
chmodSync(outputPath, 0o755);
console.log(outputPath);
