// Require a persistent Android signing key for published releases, and check the key alias
// against the keystore up front so a wrong secret fails here instead of after a long Gradle
// build. Branch builds may leave all four secrets unset: prepare-android.mjs then signs
// with the debug key and appends .debug to the application id.
import { execFileSync } from 'node:child_process';
import { appendFileSync, chmodSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const NAMES = ['ANDROID_KEYSTORE_BASE64', 'ANDROID_KEYSTORE_PASSWORD', 'ANDROID_KEY_ALIAS', 'ANDROID_KEY_PASSWORD'];

/** Key aliases in the keystore, from `keytool -list` (lines like "upload, Oct 27, 2026, PrivateKeyEntry,"). */
export function keytoolAliases(path, env) {
  const out = execFileSync('keytool', ['-list', '-keystore', path, '-storepass:env', 'ANDROID_KEYSTORE_PASSWORD'], { encoding: 'utf8', env: { ...process.env, ...env } });
  return out.split(/\r?\n/).map((line) => line.match(/^(.+?),.*,\s*PrivateKeyEntry,\s*$/)?.[1]).filter(Boolean);
}

export function configureSigning(env = process.env, listAliases = keytoolAliases) {
  const present = NAMES.filter((name) => env[name]);
  if (present.length && present.length < NAMES.length) {
    throw new Error('Configure all four ANDROID_KEYSTORE_* / ANDROID_KEY_* secrets, or leave all unset for branch test builds');
  }
  const signed = present.length === NAMES.length;
  if ((env.GITHUB_REF_TYPE === 'tag' || env.ANDROID_REQUIRE_SIGNING === 'true') && !signed) {
    throw new Error('Release APKs require a persistent signing key. Configure all four ANDROID_KEYSTORE_* / ANDROID_KEY_* secrets; temporary test keys cannot support upgrades.');
  }
  if (signed) {
    const base64 = env.ANDROID_KEYSTORE_BASE64.replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw new Error('ANDROID_KEYSTORE_BASE64 is not valid base64');
    const key = Buffer.from(base64, 'base64');
    if (!key.length) throw new Error('Android signing keystore is empty');
    const path = join(env.RUNNER_TEMP, 'realingo-upload.jks');
    writeFileSync(path, key, { mode: 0o600 });
    chmodSync(path, 0o600);
    // Pasted secrets often carry a trailing newline or different letter case; keystore aliases are case-insensitive.
    const aliases = listAliases(path, env);
    const alias = aliases.find((a) => a.toLowerCase() === env.ANDROID_KEY_ALIAS.trim().toLowerCase());
    if (!alias) {
      rmSync(path, { force: true });
      throw new Error(`ANDROID_KEY_ALIAS does not name a key in the keystore. Keys in ANDROID_KEYSTORE_BASE64: ${aliases.join(', ') || '(none)'}. Update the ANDROID_KEY_ALIAS secret to one of them.`);
    }
    appendFileSync(env.GITHUB_ENV, `ANDROID_KEYSTORE_PATH=${path}\nANDROID_SIGNING_ALIAS=${alias}\n`);
  }
  appendFileSync(env.GITHUB_OUTPUT, `signed=${signed}\n`);
  appendFileSync(env.GITHUB_STEP_SUMMARY, signed
    ? 'Android: release build with production signing.\n'
    : 'Android: branch test build with debug signing (.debug id suffix); not publishable.\n');
  return signed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    configureSigning();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
