import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { androidVersionCode } from './prepare-android.mjs';

export function verifyBadging(badging, expectedId, version) {
  const line = badging.split('\n').find((value) => value.startsWith('package:')) ?? '';
  const fields = Object.fromEntries([...line.matchAll(/(\w+)='([^']*)'/g)].map((match) => [match[1], match[2]]));
  if (fields.name !== expectedId) throw new Error(`Android application id is ${fields.name}, expected ${expectedId}`);
  if (fields.versionName !== version) throw new Error(`Android system sees version ${fields.versionName}, expected ${version}`);
  if (Number(fields.versionCode) !== androidVersionCode(version)) throw new Error(`Android versionCode is ${fields.versionCode}, expected ${androidVersionCode(version)}`);
  return { packageId: fields.name, versionName: fields.versionName, versionCode: Number(fields.versionCode) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [apk, packageId, aapt] = process.argv.slice(2);
  const version = readFileSync(new URL('../src-tauri/Cargo.toml', import.meta.url), 'utf8').match(/^version\s*=\s*"([^"]+)"/m)[1];
  console.log(JSON.stringify(verifyBadging(execFileSync(aapt, ['dump', 'badging', apk], { encoding: 'utf8' }), packageId, version)));
}
