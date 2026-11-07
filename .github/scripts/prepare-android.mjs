// Prepare ReaLingo's generated Tauri Android project for CI builds and signing.
// Run from the repository root after `tauri android init`; safe to run repeatedly.
//
// Modeled on LittleLobby's proven equivalent, cut down to what ReaLingo actually needs:
// no cleartext (all endpoints are wss://), no orientation lock, no QR camera.
import { copyFileSync, existsSync, readFileSync, writeFileSync, mkdirSync, cpSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const tauri = join(dirname(fileURLToPath(import.meta.url)), '../../src-tauri');
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

  // `tauri android icon` output, so the launcher uses real artwork instead of the template.
  const icons = join(tauri, 'icons/android');
  if (existsSync(icons)) cpSync(icons, join(app, 'src/main/res'), { recursive: true });

  // Gradle's default 10-second download timeout is too short for CI network stalls.
  const wrapper = join(app, '../gradle/wrapper/gradle-wrapper.properties');
  const properties = read(wrapper).split(/\r?\n/).filter((line) => line && !line.startsWith('networkTimeout='));
  writeFileSync(wrapper, [...properties, 'networkTimeout=120000', ''].join('\n'));

  const manifest = join(app, 'src/main/AndroidManifest.xml');
  let xml = read(manifest);
  // INTERNET ships in the template; RECORD_AUDIO is ours to add — without it the
  // permission is never even promptable and cpal/AAudio enumerates nothing.
  for (const name of ['android.permission.INTERNET', 'android.permission.RECORD_AUDIO']) {
    if (!xml.includes(`<uses-permission android:name="${name}"`)) xml = xml.replace(/<application\b/, `<uses-permission android:name="${name}" />\n    $&`);
  }
  xml = setAttr(xml, 'application', 'android:icon', '@mipmap/ic_launcher');
  xml = setAttr(xml, 'application', 'android:label', '@string/app_name');
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
  let text = read(gradle);
  text = text.split(SIGNING_MARKER)[0];
  writeFileSync(gradle, `${text.trimEnd()}\n${SIGNING}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) prepareAndroid();
