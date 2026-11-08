// Fetch the wrapper's exact Gradle version through the official asset API.
// The normal services.gradle.org redirect can return 504 before Gradle starts.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export function fetchGradle(wrapper, cache, gh = args => execFileSync('gh', args, { encoding: 'utf8', timeout: 180000 })) {
  const properties = readFileSync(wrapper, 'utf8');
  const archive = properties.match(/^distributionUrl=.*\/(gradle-([\d.]+)-bin\.zip)\s*$/m);
  if (!archive) throw new Error('Unsupported Gradle wrapper distribution URL');
  const [, name, version] = archive;
  const asset = JSON.parse(gh(['api', `repos/gradle/gradle-distributions/releases/tags/v${version}`,
    '--jq', `.assets[] | select(.name == "${name}")`]));
  if (!/^sha256:[a-f0-9]{64}$/.test(asset.digest)) throw new Error('Official Gradle asset has no SHA-256 digest');
  mkdirSync(cache, { recursive: true });
  const file = join(cache, name);
  const valid = () => existsSync(file) && createHash('sha256').update(readFileSync(file)).digest('hex') === asset.digest.slice(7);
  if (!valid()) gh(['release', 'download', `v${version}`, '--repo', 'gradle/gradle-distributions', '--pattern', name, '--dir', cache, '--clobber']);
  if (!valid()) throw new Error('Gradle distribution SHA-256 mismatch');
  writeFileSync(wrapper, properties.replace(/^distributionUrl=.*$/m, `distributionUrl=${pathToFileURL(file).href}`));
  console.log(`Verified official Gradle ${version}; wrapper uses the local distribution`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  fetchGradle('src-tauri/gen/android/gradle/wrapper/gradle-wrapper.properties', join(process.env.RUNNER_TEMP, 'realingo-gradle'));
}
