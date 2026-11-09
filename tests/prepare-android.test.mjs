// Runs the real prepare-android.mjs against a throwaway android tree in a temp dir
// (the script anchors its src-tauri lookups to its own location, so copying it into
// tmp/repo makes it read and write only tmp files). What it must guarantee every CI
// build: the subtitle window is gone from the config Tauri compiles against — mobile
// instantiates every declared window and the overlay used to bury the phone shell —
// minSdk lands on 26 everywhere, MainActivity is copied to the package path, and the
// RECORD_AUDIO permission reaches the manifest.
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { androidVersionCode } from '../scripts/prepare-android.mjs';

const repo = new URL('..', import.meta.url);
const read = (file) => readFileSync(file, 'utf8');

function fakeTree(t) {
  const root = mkdtempSync(join(tmpdir(), 'prepare-android-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // Same relative layout the script expects: scripts, src-tauri, gen/android.
  mkdirSync(join(root, 'scripts'), { recursive: true });
  cpSync(new URL('scripts/prepare-android.mjs', repo), join(root, 'scripts/prepare-android.mjs'));
  mkdirSync(join(root, 'src-tauri'), { recursive: true });
  cpSync(new URL('src-tauri/Cargo.toml', repo), join(root, 'src-tauri/Cargo.toml'));
  cpSync(new URL('src-tauri/tauri.conf.json', repo), join(root, 'src-tauri/tauri.conf.json'));
  cpSync(new URL('src-tauri/tauri.android.conf.json', repo), join(root, 'src-tauri/tauri.android.conf.json'));
  cpSync(new URL('src-tauri/icons/android', repo), join(root, 'src-tauri/icons/android'), { recursive: true });
  mkdirSync(join(root, 'src-tauri/android'), { recursive: true });
  cpSync(new URL('src-tauri/android/MainActivity.kt', repo), join(root, 'src-tauri/android/MainActivity.kt'));
  cpSync(new URL('src-tauri/android/SubtitleService.kt', repo), join(root, 'src-tauri/android/SubtitleService.kt'));

  const app = join(root, 'src-tauri/gen/android/app');
  mkdirSync(join(app, 'src/main/java'), { recursive: true });
  mkdirSync(join(root, 'src-tauri/gen/android/gradle/wrapper'), { recursive: true });
  writeFileSync(join(root, 'src-tauri/gen/android/gradle/wrapper/gradle-wrapper.properties'), 'distributionUrl=https://services.gradle.org/distributions/gradle-8.14.3-bin.zip\n');
  writeFileSync(join(app, 'build.gradle.kts'), 'android {\n    defaultConfig {\n        minSdk = 24\n    }\n}\n');
  writeFileSync(join(root, 'src-tauri/gen/android/gradle.properties'), 'minSdkVersion = 24\n');
  writeFileSync(join(root, 'src-tauri/gen/android/settings.gradle'), "include ':app'\n");
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
    const mod = await import(pathToFileURL(join(root, 'scripts/prepare-android.mjs')).href + '?once=' + Math.random());
    await mod.prepareAndroid('src-tauri/gen/android/app');
  } finally {
    process.chdir(cwd);
  }
}

test('prepare-android keeps desktop config intact and packages one Android window', async (t) => {
  const { root, app } = fakeTree(t);
  const before = read(join(root, 'src-tauri/tauri.conf.json'));
  await run(root, app);

  assert.equal(read(join(root, 'src-tauri/tauri.conf.json')), before);
  const config = JSON.parse(read(join(root, 'src-tauri/tauri.android.conf.json')));
  const labels = config.app.windows.map((w) => w.label);
  assert.ok(!labels.includes('subtitle'), `subtitle survived into the mobile build: ${labels}`);
  assert.ok(labels.includes('main'), 'the main window must stay');
  const version = read(new URL('src-tauri/Cargo.toml', repo)).match(/^version = "([^"]+)"/m)[1];
  assert.equal(config.version, version);
  assert.equal(config.bundle.android.versionCode, androidVersionCode(version));
  assert.match(read(join(app, 'tauri.properties')), new RegExp(`tauri.android.versionName=${version}`));
  // The rest of the config is not collateral damage.
  assert.equal(JSON.parse(before).bundle.android.minSdkVersion, 26);

  const gradle = read(join(app, 'build.gradle.kts'));
  assert.match(gradle, /minSdk = 26/);
  assert.doesNotMatch(gradle, /minSdk = 24/);
  assert.ok(gradle.includes('// ReaLingo CI signing'), 'signing block appended');

  assert.match(read(join(root, 'src-tauri/gen/android/gradle.properties')), /minSdkVersion = 26/);
  for (const file of ['settings.gradle', 'buildSrc/settings.gradle.kts']) {
    const repositories = read(join(app, '..', file));
    assert.ok(repositories.indexOf('mavenCentral()') < repositories.indexOf('gradlePluginPortal()'));
    assert.match(repositories, /^\/\/ ReaLingo plugin repositories\npluginManagement/);
  }

  const manifest = read(join(app, 'src/main/AndroidManifest.xml'));
  assert.ok(manifest.includes('android.permission.RECORD_AUDIO'), 'mic permission must reach the manifest');
  assert.match(manifest, /android:roundIcon="@mipmap\/ic_launcher_round"/);
  assert.match(manifest, /android.permission.SYSTEM_ALERT_WINDOW/);
  assert.match(manifest, /android.permission.FOREGROUND_SERVICE_MEDIA_PROJECTION/);
  assert.match(manifest, /android:foregroundServiceType="microphone\|mediaProjection\|specialUse"/);
  assert.equal(read(join(app, 'src/main/java/com/nosugark/realingo/SubtitleService.kt')), read(new URL('src-tauri/android/SubtitleService.kt', repo)));
  for (const density of ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi']) {
    for (const icon of ['ic_launcher.png', 'ic_launcher_round.png', 'ic_launcher_foreground.png']) {
      assert.deepEqual(readFileSync(join(app, 'src/main/res', `mipmap-${density}`, icon)),
        readFileSync(join(root, 'src-tauri/icons/android', `mipmap-${density}`, icon)));
    }
  }

  const copied = read(join(app, 'src/main/java/com/nosugark/realingo/MainActivity.kt'));
  assert.equal(copied, read(new URL('src-tauri/android/MainActivity.kt', repo)), 'the bridge must be copied verbatim');
});

test('Android update codes advance past the old template and increase with each patch', () => {
  assert.ok(androidVersionCode('0.7.2') > 1_000_000);
  assert.ok(androidVersionCode('0.7.3') > androidVersionCode('0.7.2'));
  const releases = ['0.7.3', '0.8.0-alpha.1', '0.8.0-alpha.2', '0.8.0-beta.1', '0.8.0-beta.2', '0.8.0-rc.1', '0.8.0', '0.8.1-alpha.1'];
  const codes = releases.map(androidVersionCode);
  assert.ok(codes[0] > 1_007_003, 'updates must advance past historical 0.7.x codes');
  for (let i = 1; i < codes.length; i++) assert.ok(codes[i] > codes[i - 1], `${releases[i]} must be upgradeable`);
  for (const invalid of ['0.8.0-beta.0', '0.8.0-beta.100', '0.8.0-preview.1', '0.1000.0', '9999.0.0']) {
    assert.throws(() => androidVersionCode(invalid));
  }
  assert.throws(() => androidVersionCode('bad'), /numeric/);
});

test('CI local Maven repository is first for plugin and compiler dependencies and stays idempotent', async t => {
  const { root, app } = fakeTree(t);
  const previous = process.env.REALINGO_MAVEN_REPO;
  process.env.REALINGO_MAVEN_REPO = join(root, 'maven');
  try {
    mkdirSync(join(app, '../buildSrc'), { recursive: true });
    writeFileSync(join(app, '../buildSrc/build.gradle.kts'), 'repositories { mavenCentral() }\n');
    writeFileSync(join(app, 'build.gradle.kts'), read(join(app, 'build.gradle.kts')) + '\nrepositories { google() }\n');
    await run(root, app);
    await run(root, app);
    const url = pathToFileURL(process.env.REALINGO_MAVEN_REPO).href;
    for (const file of ['../settings.gradle', '../buildSrc/settings.gradle.kts', '../buildSrc/build.gradle.kts', 'build.gradle.kts']) {
      const text = read(join(app, file));
      assert.equal(text.split(url).length - 1, 1, 'the local Maven repository is added once');
      assert.match(text, /repositories\s*\{\s*maven \{ url = uri/);
    }
  } finally {
    if (previous === undefined) delete process.env.REALINGO_MAVEN_REPO;
    else process.env.REALINGO_MAVEN_REPO = previous;
  }
});

test('prepare-android is idempotent (safe to re-run)', async (t) => {
  const { root, app } = fakeTree(t);
  await run(root, app);
  const first = read(join(app, 'build.gradle.kts'));
  const settings = read(join(app, '../settings.gradle'));
  await run(root, app);
  assert.equal(read(join(app, 'build.gradle.kts')), first, 're-running must not stack signing blocks or re-splice windows');
  assert.equal(read(join(app, '../settings.gradle')), settings, 'plugin repositories must not be duplicated');
  const config = JSON.parse(read(join(root, 'src-tauri/tauri.conf.json')));
  assert.equal(config.app.windows.filter((w) => w.label === 'main').length, 1);
});

test('missing artwork fails the build instead of shipping the default icon', async (t) => {
  const { root, app } = fakeTree(t);
  rmSync(join(root, 'src-tauri/icons/android'), { recursive: true });
  await assert.rejects(run(root, app), /missing Android launcher artwork/);
});

test('multiple Android windows fail the build', async (t) => {
  const { root, app } = fakeTree(t);
  writeFileSync(join(root, 'src-tauri/tauri.android.conf.json'), JSON.stringify({ app: { windows: [{ label: 'main' }, { label: 'subtitle' }] } }));
  await assert.rejects(run(root, app), /exactly one main window/);
});
