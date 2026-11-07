// Runs the real prepare-android.mjs against a throwaway android tree in a temp dir
// (the script anchors its src-tauri lookups to its own location, so copying it into
// tmp/repo makes it read and write only tmp files). What it must guarantee every CI
// build: the subtitle window is gone from the config Tauri compiles against — mobile
// instantiates every declared window and the overlay used to bury the phone shell —
// minSdk lands on 26 everywhere, MainActivity is copied to the package path, and the
// RECORD_AUDIO permission reaches the manifest.
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const repo = new URL('..', import.meta.url);
const read = (file) => readFileSync(file, 'utf8');

function fakeTree() {
  const root = mkdtempSync(join(tmpdir(), 'prepare-android-'));
  // Same relative layout the script expects: .github/scripts, src-tauri, gen/android.
  mkdirSync(join(root, '.github/scripts'), { recursive: true });
  cpSync(new URL('.github/scripts/prepare-android.mjs', repo), join(root, '.github/scripts/prepare-android.mjs'));
  mkdirSync(join(root, 'src-tauri'), { recursive: true });
  cpSync(new URL('src-tauri/tauri.conf.json', repo), join(root, 'src-tauri/tauri.conf.json'));
  mkdirSync(join(root, 'src-tauri/android'), { recursive: true });
  cpSync(new URL('src-tauri/android/MainActivity.kt', repo), join(root, 'src-tauri/android/MainActivity.kt'));

  const app = join(root, 'src-tauri/gen/android/app');
  mkdirSync(join(app, 'src/main/java'), { recursive: true });
  mkdirSync(join(root, 'src-tauri/gen/android/gradle/wrapper'), { recursive: true });
  writeFileSync(join(root, 'src-tauri/gen/android/gradle/wrapper/gradle-wrapper.properties'), 'distributionUrl=https://services.gradle.org/distributions/gradle-8.14.3-bin.zip\n');
  writeFileSync(join(app, 'build.gradle.kts'), 'android {\n    defaultConfig {\n        minSdk = 24\n    }\n}\n');
  writeFileSync(join(root, 'src-tauri/gen/android/gradle.properties'), 'minSdkVersion = 24\n');
  writeFileSync(join(app, 'src/main/AndroidManifest.xml'), `<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <application android:name=".MainApplication">
        <activity android:name=".MainActivity" />
    </application>
</manifest>
`);
  return { root, app };
}

async function run(root, app) {
  const cwd = process.cwd();
  process.chdir(root);
  try {
    const mod = await import(pathToFileURL(join(root, '.github/scripts/prepare-android.mjs')).href + '?once=' + Math.random());
    await mod.prepareAndroid('src-tauri/gen/android/app');
  } finally {
    process.chdir(cwd);
  }
}

test('prepare-android strips the subtitle window and patches the tree', async () => {
  const { root, app } = fakeTree();
  await run(root, app);

  const config = JSON.parse(read(join(root, 'src-tauri/tauri.conf.json')));
  const labels = config.app.windows.map((w) => w.label);
  assert.ok(!labels.includes('subtitle'), `subtitle survived into the mobile build: ${labels}`);
  assert.ok(labels.includes('main'), 'the main window must stay');
  // The rest of the config is not collateral damage.
  assert.equal(config.bundle.android.minSdkVersion, 26);

  const gradle = read(join(app, 'build.gradle.kts'));
  assert.match(gradle, /minSdk = 26/);
  assert.doesNotMatch(gradle, /minSdk = 24/);
  assert.ok(gradle.includes('// ReaLingo CI signing'), 'signing block appended');

  assert.match(read(join(root, 'src-tauri/gen/android/gradle.properties')), /minSdkVersion = 26/);

  const manifest = read(join(app, 'src/main/AndroidManifest.xml'));
  assert.ok(manifest.includes('android.permission.RECORD_AUDIO'), 'mic permission must reach the manifest');

  const copied = read(join(app, 'src/main/java/com/nosugark/realingo/MainActivity.kt'));
  assert.equal(copied, read(new URL('src-tauri/android/MainActivity.kt', repo)), 'the bridge must be copied verbatim');
});

test('prepare-android is idempotent (safe to re-run)', async () => {
  const { root, app } = fakeTree();
  await run(root, app);
  const first = read(join(app, 'build.gradle.kts'));
  await run(root, app);
  assert.equal(read(join(app, 'build.gradle.kts')), first, 're-running must not stack signing blocks or re-splice windows');
  const config = JSON.parse(read(join(root, 'src-tauri/tauri.conf.json')));
  assert.equal(config.app.windows.filter((w) => w.label === 'main').length, 1);
});
