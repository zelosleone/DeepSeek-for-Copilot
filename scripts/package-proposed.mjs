/**
 * Builds the sideload-only variant with proposed APIs enabled.
 *
 * `enabledApiProposals` cannot live in the committed manifest: vsce refuses to
 * publish any extension declaring it, and the declaration is required for VS Code
 * to grant the API (a user enabling it via argv.json is not enough on its own).
 * So it is injected at package time and removed again, leaving the default
 * `npm run package` output publishable.
 */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const PROPOSALS = ['inlineCompletionsAdditions'];
const MANIFEST = 'package.json';

const original = readFileSync(MANIFEST, 'utf8');
const manifest = JSON.parse(original);
const outFile = `${manifest.name}-${manifest.version}-nes.vsix`;

try {
  writeFileSync(MANIFEST, `${JSON.stringify({ ...manifest, enabledApiProposals: PROPOSALS }, null, 2)}\n`);
  execSync(`npx --no-install vsce package --no-git-tag-version --out ${outFile}`, {
    stdio: 'inherit',
  });
} finally {
  // Always restore, so a failed package cannot leave an unpublishable manifest behind.
  writeFileSync(MANIFEST, original);
}

console.log(`\n${outFile}`);
console.log('Proposed APIs:', PROPOSALS.join(', '));
console.log('\nThis build CANNOT be published to the Marketplace. To run it, add to');
console.log('~/.vscode/argv.json so it survives restarts:');
console.log(`  { "enable-proposed-api": ["${manifest.publisher}.${manifest.name}"] }`);
