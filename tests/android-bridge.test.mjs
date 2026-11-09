// The Kotlin bridge is a second language speaking a protocol the TypeScript side
// assumes. CI compiles neither half against the other, so this asserts the contract at
// the source level: every method perms.ts calls exists in MainActivity.kt with a JSON
// shape on both ends, the package line matches what prepare-android.mjs copies into, and
// the Rust side no longer registers the commands the bridge replaced (perms.ts's
// fallback must therefore *expect* to fail against current APKs).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const kt = readFileSync(new URL('../src-tauri/android/MainActivity.kt', import.meta.url), 'utf8');
const permsTs = readFileSync(new URL('../src/mobile/perms.ts', import.meta.url), 'utf8');
const prepareMjs = readFileSync(new URL('../scripts/prepare-android.mjs', import.meta.url), 'utf8');
const libRs = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');
const conf = JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'));

test('the locked Android runtime initializes the shared NDK context used by cpal', () => {
  const lock = readFileSync(new URL('../src-tauri/Cargo.lock', import.meta.url), 'utf8');
  const tao = lock.split('[[package]]').find((entry) => /^\s*name = "tao"/m.test(entry));
  assert.ok(tao, 'Tao must be present in the resolved runtime');
  assert.match(tao, /"ndk-context"/, 'Tao must initialize ndk-context before the first list_devices IPC');
});

test('the locked Rust runtime and JavaScript API use the same major and minor release', () => {
  const lock = readFileSync(new URL('../src-tauri/Cargo.lock', import.meta.url), 'utf8');
  const runtime = lock.split('[[package]]').find((entry) => /^\s*name = "tauri"/m.test(entry));
  const rust = runtime.match(/version = "([^"]+)"/)[1];
  const npm = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
  const api = npm.packages['node_modules/@tauri-apps/api'].version;
  assert.deepEqual(rust.split('.').slice(0, 2), api.split('.').slice(0, 2));
});

test('every bridge method perms.ts declares exists in Kotlin', () => {
  const iface = permsTs.match(/interface Droid \{([\s\S]*?)\n\}/)[1];
  const names = [...iface.matchAll(/(\w+)\(/g)].map((m) => m[1]);
  assert.ok(names.length >= 9, `expected the full surface, got ${names}`);
  for (const name of names) {
    assert.match(kt, new RegExp(`fun ${name}\\(`), `MainActivity.kt is missing ${name}`);
  }
  assert.match(kt, /addJavascriptInterface\(Bridge\(\), "ReaLingoAndroid"\)/, 'the bridge must register under the name window.ReaLingoAndroid reads');
  assert.match(kt, /@Keep\s+inner class Bridge/, 'release shrinking must preserve the JavaScript entry points');
});

test('micStatus speaks the same JSON shape on both ends', () => {
  assert.match(kt, /return """\{"granted":\$granted,"rationale":\$rationale,"requesting":\$micRequesting\}"""/);
  assert.match(permsTs, /requesting\?: boolean/);
});

test('permission completion and file result serialization use Android APIs', () => {
  assert.match(kt, /onRequestPermissionsResult/);
  assert.match(kt, /requestCode == REQUEST_MIC\) micRequesting = false/);
  assert.match(kt, /JSONObject\(\)\.put\("state", "picked"\)\.put\("path", file.absolutePath\)/);
  assert.doesNotMatch(kt, /WIFI_SERVICE|jsonEscape/);
});

test('pickAudioFile/pickResult agree on the one-slot states', () => {
  const states = (kt.match(/"state":"(\w+)"/g) ?? []).join(" ");
  for (const s of ['idle', 'busy', 'picked', 'cancelled', 'error']) {
    assert.ok(states.includes(`"state":"${s}"`) || kt.includes(`.put("state", "${s}")`), `Kotlin never emits ${s}`);
  }
  // Terminal states the poller must handle explicitly; "busy" is the implicit
  // keep-waiting state, and "idle" only appears in Kotlin's reset paths.
  for (const s of ['picked', 'cancelled', 'error']) {
    assert.ok(permsTs.includes(`s.state === "${s}"`), `perms.ts does not handle ${s}`);
  }
  assert.doesNotMatch(permsTs, /s\.state === "busy"/, 'busy is keep-polling, not a branch');
});

test('package line matches the path prepare-android copies to', () => {
  const pkg = kt.match(/^package ([\w.]+)/m)[1];
  assert.equal(pkg, conf.identifier, 'Kotlin package must equal the app identifier, or the class never loads');
  const dir = pkg.split('.').join('/');
  assert.ok(prepareMjs.includes(`'${dir.split('/').join("', '")}'`) || prepareMjs.includes(dir), `prepare-android.mjs does not copy into ${dir}`);
  assert.match(prepareMjs, /android\/MainActivity\.kt/, 'prepare-android.mjs must source the bridge file');
});

test('no Rust idioms leaked into the Kotlin bridge', () => {
  // First CI pass died on `trimMatches` — Rust's trim_matches carried across. The
  // gradle compiler is the real gate, but these fingerprints are unmistakable.
  for (const idiom of ['trimMatches', 'trim_matches', '.unwrap()', '.expect(', 'map_err', '.to_string()', 'vec![']) {
    assert.ok(!kt.includes(idiom), `MainActivity.kt contains the Rust idiom ${idiom}`);
  }
});

test('the Rust commands the bridge replaced are really gone', () => {
  for (const cmd of ['perm_status', 'perm_request', 'notif_enabled', 'battery_ignored', 'open_app_settings', 'open_battery_settings', 'set_keep_screen_on', 'device_name']) {
    assert.doesNotMatch(libRs, new RegExp(`#\\[tauri::command\\]\\s*fn ${cmd}\\b`), `lib.rs still registers ${cmd}`);
  }
  assert.doesNotMatch(libRs, /mod mobile\b/, 'lib.rs must not reference the deleted modules');
  assert.doesNotMatch(libRs, /\bperm_request,/, 'generate_handler! must not list the phone commands');
});
