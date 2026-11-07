# Android development and crash verification

Run Git pulls and commits through WSL. Android builds need Node 24+, Rust, JDK 17,
Android SDK 36 and NDK 28.2.13676358. A browser preview only tests the web UI;
it cannot prove that Android's native Activity, audio backend or plugins start.

## Local checks

```bash
npm ci
npm test
python3 -B -m unittest discover -s tests -p 'test_*.py'
npm run build
cargo test --locked --manifest-path src-tauri/Cargo.toml --lib
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

Node tests cover permission states (including an open system prompt), Android project
preparation, launcher image dimensions, source selection, native start failures,
stop/closure, transcript/translation pairing, progress and TXT/SRT export.
Rust tests cover audio resampling, protocol payloads, response parsing, history and secrets.
The WASAPI hardware test is deliberately ignored unless explicitly requested.
Python tests check malformed ELF data, missing libraries, 4 KB alignment and segment offsets.

## Build and run an APK

```bash
npm run tauri -- android init --ci --skip-targets-install
node .github/scripts/prepare-android.mjs
npm run tauri -- android build --ci --apk --target aarch64
# On an emulator or a disposable test device; this clears the test app's data:
node .github/scripts/smoke-android.mjs /absolute/path/to/app.apk com.nosugark.realingo.debug
```

The default package ID above is for a test-signed release. Pass
`com.nosugark.realingo` for a production-signed APK. The smoke runner clears that
package's data, performs two cold launches, requires rendered WebView controls,
opens About/Settings/Permissions, resumes from the background and tests microphone
grant/revocation across launches. It saves screenshots, UI XML and logcat in
`android-smoke/` (override with `ANDROID_SMOKE_OUTPUT`). Never use the smoke runner
against an installation containing settings/history you want to keep.

`.github/workflows/android-test.yml` builds release ARM64 and x86_64 APKs and runs the latter on API 26
and API 35 with 16 KB pages. The page size is asserted on the emulator. Both this
workflow and the ARM64 release workflow check APK ZIP alignment and every native
library's ELF load-segment alignment. These are regression gates, not evidence that
a particular vendor device has passed. Remote emulator results are available only
after the workflow actually runs.

## Capture the reported vivo X300 crash without clearing app data

Enable USB debugging, connect the phone and run:

```bash
adb devices
adb shell getprop ro.build.version.release
adb shell getprop ro.build.version.sdk
adb shell getconf PAGE_SIZE
adb logcat -b crash -d > realingo-crash.txt
adb logcat -d > realingo-logcat.txt
```

Open ReaLingo and reproduce the crash before collecting the logs. Record the exact
APK filename/commit and whether it was signed with the production or test key.
`FATAL EXCEPTION`, `Fatal signal`, `Abort message`, `UnsatisfiedLinkError` and Rust
panic messages distinguish Java/bridge, dynamic-loader and Rust failures. Keep logs
local and remove any credentials/transcript content before sharing them.

## Artwork and platform configuration

```bash
npm run icons:android
```

This uses the existing `app-icon.png`, generates all Android densities and adaptive
icons, and fixes the CLI's 49px hdpi output to the required 72px. The header uses the
transparent `src/assets/mark.png`; About uses the same app artwork as the launcher.
Missing launcher assets fail preparation instead of silently retaining template icons.

`src-tauri/tauri.android.conf.json` declares only `main`. Tauri automatically merges
it on Android, including local builds; preparation does not remove the desktop subtitle
window from `tauri.conf.json`. Do not close a second Activity after startup as a substitute
for selecting the correct platform configuration.
