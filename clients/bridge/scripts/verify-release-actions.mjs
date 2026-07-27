import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Reviewed immutable revisions; comments next to workflow refs retain human-readable versions.
export const KNOWN_GOOD_REVISIONS = Object.freeze({
  'actions/checkout': 'd23441a48e516b6c34aea4fa41551a30e30af803',
  'actions/setup-node': 'a0853c24544627f65ddf259abe73b1d18a591444',
  'actions/setup-dotnet': '26b0ec14cb23fa6904739307f278c14f94c95bf1',
  'actions/upload-artifact': 'ea165f8d65b6e75b540449e92b4886f43607fa02',
  'actions/download-artifact': '634f93cb2916e3fdff6788551b99b062d0335ce0',
  'actions/attest': '36051bcae73b7c2a8a6945a48cbf80953c6baa35',
});

export function extractUses(yamlText) {
  const uses = [];
  for (const line of yamlText.split(/\r?\n/)) {
    const match = /^\s*(?:-\s*)?uses:\s*(\S+)\s*$/.exec(line);
    if (match) uses.push(match[1]);
  }
  return uses;
}

export function validateWorkflow(yamlText) {
  const failures = [];
  for (const uses of extractUses(yamlText)) {
    const match = /^([^@]+)@(.+)$/.exec(uses);
    const action = match?.[1];
    const ref = match?.[2];
    if (!/^[a-f0-9]{40}$/i.test(ref ?? '')) {
      failures.push(`${uses}: expected an owner/action@40-character-commit`);
      continue;
    }
    const allowed = KNOWN_GOOD_REVISIONS[action];
    if (!allowed || allowed !== ref) {
      failures.push(`${uses}: ${action ?? 'unknown action'} is not the reviewed immutable revision`);
    }
  }
  return failures;
}

export function validateFiles(paths) {
  return paths.flatMap((file) => validateWorkflow(readFileSync(file, 'utf8')).map((failure) => `${file}: ${failure}`));
}

/** Verify that the release definitions publish a complete, verified operator artifact. */
export function validateReleaseContract(bridgeYaml, clientYaml) {
  const requirements = [
    [bridgeYaml, 'release bridge', 'needs: [build, verify-integration]'],
    [bridgeYaml, 'release bridge', 'SHA256SUMS'],
    [bridgeYaml, 'release bridge', 'broker-bridge-LICENSE.txt'],
    [bridgeYaml, 'release bridge', 'broker-bridge-README.md'],
    [bridgeYaml, 'release bridge', 'broker-bridge.cdx.json'],
    [clientYaml, 'release client', 'needs: [build, verify-integration]'],
    [clientYaml, 'release client', 'SHA256SUMS'],
    [clientYaml, 'release client', 'LICENSE.txt'],
    [clientYaml, 'release client', 'README.md'],
    [clientYaml, 'release client', 'broker-client.cdx.json'],
  ];
  return requirements
    .filter(([yaml, , required]) => !yaml.includes(required))
    .map(([, release, required]) => `${release}: missing ${required}`);
}

// This standalone script is never bundled, so a plain ESM entry check is sufficient.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const repositoryRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
  const files = [
    resolve(repositoryRoot, '.github/workflows/release-bridge.yml'),
    resolve(repositoryRoot, '.github/workflows/release-client.yml'),
  ];
  const failures = [
    ...validateFiles(files),
    ...validateReleaseContract(readFileSync(files[0], 'utf8'), readFileSync(files[1], 'utf8')),
  ];
  if (failures.length) {
    console.error(failures.join('\n'));
    process.exitCode = 1;
  }
}
