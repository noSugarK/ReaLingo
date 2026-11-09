// Prepare ReaLingo's generated Tauri Android project for CI builds and signing.
// Run from the repository root after `tauri android init`; safe to run repeatedly.
//
// Modeled on LittleLobby's proven equivalent, cut down to what ReaLingo actually needs:
// no cleartext (all endpoints are wss://), no orientation lock, no QR camera.
import { appendFileSync, copyFileSync, existsSync, readFileSync, writeFileSync, mkdirSync, cpSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const tauri = join(dirname(fileURLToPath(import.meta.url)), '../src-tauri');
const read = (file) => readFileSync(file, 'utf8');
const write = (file, text) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); };

/** Set (or replace) one attribute on the first opening tag named `tag`. */
function setAttr(xml, tag, name, value) {
  return xml.replace(new RegExp(`<${tag}\\b[^>]*?(?=/?>)`), (open) => {
    const attr = new RegExp(`\\s${name}="[^"]*"`);
    return attr.test(open) ? open.replace(attr, ` ${name}="${value}"`) : `${open} ${name}="${value}"`;
  });
}

// With no production keystore in CI secrets, the release build signs with the template's
// debug key and appends .debug to the application id — an installable test APK that can
// never be mistaken for (or upgrade-conflict with) a published one.
const SIGNING = `
// ReaLingo CI signing
if (System.getenv("ANDROID_KEYSTORE_PATH") != null) {
    android {
        signingConfigs {
            maybeCreate("release").apply {
                storeFile = file(System.getenv("ANDROID_KEYSTORE_PATH"))
                storePassword = System.getenv("ANDROID_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("ANDROID_SIGNING_ALIAS")
                keyPassword = System.getenv("ANDROID_KEY_PASSWORD")
            }
        }
        buildTypes.getByName("release").signingConfig = signingConfigs.getByName("release")
    }
} else {
    android {
        buildTypes.getByName("release").apply {
            signingConfig = signingConfigs.getByName("debug")
            applicationIdSuffix = ".debug"
        }
    }
}
`;
const SIGNING_MARKER = '// ReaLingo CI signing';

export function androidVersionCode(version) {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta|rc)\.([1-9]\d?))?$/);
  if (!match) throw new Error('Android requires a numeric major.minor.patch version, optionally with -alpha.N, -beta.N or -rc.N');
  const [major, minor, patch] = match.slice(1, 4).map(Number);
  if (minor >= 1000 || patch >= 1000) throw new Error('Android numeric minor and patch versions must be below 1000');
  // Reserve ordered prerelease slots and put stable last. All codes stay above the
  // historical 1.0 / 1000000 template and the previous 0.7.x release encoding.
  const stage = match[4] ? { alpha: 0, beta: 100, rc: 200 }[match[4]] + Number(match[5]) : 999;
  const code = 1_000_000 + (major * 1_000_000 + minor * 1000 + patch) * 1000 + stage;
  if (!Number.isSafeInteger(code) || code > 2_100_000_000) throw new Error('Android versionCode exceeds the platform limit');
  return code;
}

export function prepareAndroid(app = 'src-tauri/gen/android/app') {
  // A hand-maintained activity override lives in the repo next to the template; without
  // one, Tauri's generated MainActivity stands (it needs no changes to boot the app).
  const custom = join(tauri, 'android/MainActivity.kt');
  if (existsSync(custom)) {
    const pkg = 'com/nosugark/realingo';
    const activity = join(app, 'src/main/java', pkg, 'MainActivity.kt');
    mkdirSync(dirname(activity), { recursive: true });
    copyFileSync(custom, activity);
  }
  const service = join(tauri, 'android/SubtitleService.kt');
  if (!existsSync(service)) throw new Error('prepare-android: SubtitleService.kt is missing');
  const serviceTarget = join(app, 'src/main/java/com/nosugark/realingo/SubtitleService.kt');
  mkdirSync(dirname(serviceTarget), { recursive: true });
  copyFileSync(service, serviceTarget);

  // Fail the build rather than silently shipping the template's launcher artwork.
  const icons = join(tauri, 'icons/android');
  if (!existsSync(join(icons, 'mipmap-xxxhdpi/ic_launcher.png'))) {
    throw new Error('prepare-android: missing Android launcher artwork; run npm run icons:android');
  }
  cpSync(icons, join(app, 'src/main/res'), { recursive: true });

  // Gradle's default 10-second download timeout is too short for CI network stalls.
  const wrapper = join(app, '../gradle/wrapper/gradle-wrapper.properties');
  const properties = read(wrapper).split(/\r?\n/).filter((line) => line && !line.startsWith('networkTimeout='));
  writeFileSync(wrapper, [...properties, 'networkTimeout=120000', ''].join('\n'));

  // Plugin classpaths use settings.pluginManagement, not build.gradle repositories.
  // Resolve Kotlin's Maven artifacts directly before the plugin portal's redirects.
  const localMaven = process.env.REALINGO_MAVEN_REPO
    ? `        maven { url = uri("${pathToFileURL(process.env.REALINGO_MAVEN_REPO).href}") }\n` : '';
  const pluginRepositories = `// ReaLingo plugin repositories\npluginManagement {\n    repositories {\n${localMaven}        mavenCentral()\n        google()\n        gradlePluginPortal()\n    }\n}\n\n`;
  for (const file of [join(app, '../settings.gradle'), join(app, '../buildSrc/settings.gradle.kts')]) {
    const original = existsSync(file) ? read(file) : '';
    if (!original.startsWith(pluginRepositories)) {
      if (/\bpluginManagement\s*\{/.test(original)) throw new Error(`prepare-android: inspect existing pluginManagement in ${file}`);
      write(file, pluginRepositories + original);
    }
  }
  if (localMaven) {
    for (const file of ['../build.gradle.kts', 'build.gradle.kts', '../buildSrc/build.gradle.kts'].map(name => join(app, name))) {
      if (!existsSync(file)) continue;
      const original = read(file);
      if (!original.includes(localMaven.trim())) writeFileSync(file, original.replace(/\brepositories\s*\{/g, opening => `${opening}\n${localMaven}`));
    }
  }

  const manifest = join(app, 'src/main/AndroidManifest.xml');
  let xml = read(manifest);
  // INTERNET ships in the template; RECORD_AUDIO is ours to add — without it the
  // permission is never even promptable and cpal/AAudio enumerates nothing.
  for (const name of ['android.permission.INTERNET', 'android.permission.RECORD_AUDIO',
    'android.permission.SYSTEM_ALERT_WINDOW', 'android.permission.FOREGROUND_SERVICE',
    'android.permission.FOREGROUND_SERVICE_MICROPHONE', 'android.permission.FOREGROUND_SERVICE_MEDIA_PROJECTION',
    'android.permission.FOREGROUND_SERVICE_SPECIAL_USE', 'android.permission.POST_NOTIFICATIONS']) {
    if (!xml.includes(`<uses-permission android:name="${name}"`)) xml = xml.replace(/<application\b/, `<uses-permission android:name="${name}" />\n    $&`);
  }
  xml = setAttr(xml, 'application', 'android:icon', '@mipmap/ic_launcher');
  xml = setAttr(xml, 'application', 'android:roundIcon', '@mipmap/ic_launcher_round');
  xml = setAttr(xml, 'application', 'android:label', '@string/app_name');
  if (!xml.includes('android:name="com.nosugark.realingo.SubtitleService"')) {
    xml = xml.replace('</application>', `<service android:name="com.nosugark.realingo.SubtitleService" android:exported="false" android:stopWithTask="true" android:foregroundServiceType="microphone|mediaProjection|specialUse">
        <property android:name="android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE" android:value="User-initiated live speech translation with floating subtitles" />
      </service>\n    </application>`);
  }
  writeFileSync(manifest, xml);

  for (const [folder, title] of Object.entries({ values: 'ReaLingo', 'values-zh': 'ReaLingo' })) {
    const strings = join(app, 'src/main/res', folder, 'strings.xml');
    const text = existsSync(strings) ? read(strings) : '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n</resources>\n';
    const label = `<string name="app_name">${title}</string>`;
    write(strings, /<string name="app_name">[^<]*<\/string>/.test(text)
      ? text.replace(/<string name="app_name">[^<]*<\/string>/, label)
      : text.replace('</resources>', `    ${label}\n</resources>`));
  }

  const gradle = join(app, 'build.gradle.kts');
  // Strip any previously appended signing block before patching, so a re-run neither
  // stacks two blocks nor (as it did when the tail was captured up front and written back
  // last) clobbers the minSdk patch below. The signing block is appended from the file's
  // final on-disk state, after every patch has landed.
  writeFileSync(gradle, read(gradle).split(SIGNING_MARKER)[0].trimEnd());

  // AAudio (cpal's Android capture backend) links against libaaudio.so, which the NDK
  // sysroot only exposes from API 26. The API level the *linker* targets comes from
  // tauri.conf.json's bundle.android.minSdkVersion (default 24), which is why patching
  // the generated Gradle files alone never changed the wrapper name — `android24-clang`
  // still could not resolve `-laaudio`. The Gradle-side declaration is what drives the
  // manifest's minSdkVersion, and must not sit below it.
  //
  // The load-bearing value lives in tauri.conf.json, not here: assert it survived rather
  // than trusting a patch that cannot see it.
  const MIN_SDK = 26;
  const config = JSON.parse(read(join(tauri, 'tauri.conf.json')));
  const configured = config.bundle?.android?.minSdkVersion;
  if (configured !== MIN_SDK) {
    throw new Error(`prepare-android: tauri.conf.json bundle.android.minSdkVersion is ${JSON.stringify(configured)}, expected ${MIN_SDK}. The linker would target API 24 and fail to resolve -laaudio.`);
  }

  // Tauri merges this platform config for local builds as well as CI builds. Never edit
  // the desktop config in place: a later desktop build would otherwise lose its overlay.
  const android = JSON.parse(read(join(tauri, 'tauri.android.conf.json')));
  if (android.app?.windows?.length !== 1 || android.app.windows[0].label !== 'main') {
    throw new Error('prepare-android: Android must declare exactly one main window');
  }
  const version = read(join(tauri, 'Cargo.toml')).match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  if (!version) throw new Error('prepare-android: Cargo package version is missing');
  android.version = version;
  android.bundle = { ...android.bundle, android: { ...android.bundle?.android, versionCode: androidVersionCode(version) } };
  writeFileSync(join(tauri, 'tauri.android.conf.json'), `${JSON.stringify(android, null, 2)}\n`);
  const versionProps = join(app, 'tauri.properties');
  const otherProps = (existsSync(versionProps) ? read(versionProps) : '').split(/\r?\n/)
    .filter((line) => line && !/^tauri\.android\.version(?:Name|Code)\s*=/.test(line));
  writeFileSync(versionProps, [...otherProps, `tauri.android.versionName=${version}`,
    `tauri.android.versionCode=${androidVersionCode(version)}`, ''].join('\n'));

  const sites = [
    // build.gradle.kts: a literal `minSdk = 24`.
    { file: gradle, pattern: /\bminSdk(\s*)=\s*\d+/g, replace: (m, space) => `minSdk${space}= ${MIN_SDK}` },
    // gradle.properties at either level: `minSdkVersion = 24`, optionally namespaced
    // (`tauri.android.minSdkVersion`) — template layout has varied across CLI versions.
    ...[join(app, '../gradle.properties'), join(app, 'gradle.properties')].map((file) => ({
      file,
      pattern: /^([\w.]*minSdkVersion\s*=\s*)\d+/gm,
      replace: (_m, head) => `${head}${MIN_SDK}`,
    })),
  ];

  // `android init` renders the Gradle files from the config, so what it rendered is the
  // only proof the field name above is one the CLI actually honours — a wrong name would
  // be ignored by serde, leave the default 24 in place, and the assert above (which reads
  // our own JSON back) would happily pass. Record the rendered values before patching,
  // because patching overwrites exactly that evidence.
  const rendered = [];
  for (const site of sites) {
    if (!existsSync(site.file)) continue;
    rendered.push(...[...read(site.file).matchAll(/minSdk(?:Version)?\s*=\s*(\d+)/g)].map((m) => Number(m[1])));
  }
  if (rendered.length && !rendered.some((value) => value === MIN_SDK)) {
    // Non-fatal: this is a heuristic and a template that expresses the value only through
    // a property lookup would legitimately render a stale fallback. Say it loudly so a
    // config rename shows up in the log next to the linker error, instead of being
    // silently patched away.
    const note = `prepare-android: warning — the generated template rendered minSdk ${rendered.join(', ')} despite bundle.android.minSdkVersion = ${MIN_SDK}. If the link step below still picks aarch64-linux-android24-clang, that config key is not being honoured (renamed or misspelled).`;
    console.error(note);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `⚠️ ${note}\n`);
  }

  for (const site of sites) {
    if (!existsSync(site.file)) continue;
    const before = read(site.file);
    const after = before.replace(site.pattern, site.replace);
    if (after !== before) writeFileSync(site.file, after);
  }

  // The manifest's minSdkVersion comes from Gradle. If a future template expresses it in a
  // shape neither pattern above matches, the APK would advertise support for API < 26 and
  // crash on load where libaaudio.so is absent — silent, and only on old devices. Scan
  // broadly for any straggler instead of assuming the patch covered everything.
  for (const file of [gradle, join(app, '../gradle.properties'), join(app, 'gradle.properties')]) {
    if (!existsSync(file)) continue;
    for (const match of read(file).matchAll(/minSdk(?:Version)?\s*=\s*(\d+)/g)) {
      if (Number(match[1]) < MIN_SDK) {
        throw new Error(`prepare-android: ${file} still declares minSdk ${match[1]} after patching, below ${MIN_SDK}. The APK would install on devices without libaaudio.so. Inspect the generated android template.`);
      }
    }
  }

  writeFileSync(gradle, `${read(gradle).trimEnd()}\n${SIGNING}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) prepareAndroid();
