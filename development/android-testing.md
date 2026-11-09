# Android development and crash verification

Run Git pulls and commits through WSL. Android builds need Node 24+, Rust 1.90+, JDK 17,
Android SDK 36 and NDK 28.2.13676358. A browser preview only tests the web UI;
it cannot prove that Android's native Activity, audio backend or plugins start.

## Historical startup failure (fixed)

The release APK reproduced a native abort on both 4 KB and 16 KB Android 15 images:
the first `list_devices` IPC entered cpal's AAudio device enumeration, which called
`ndk_context::android_context()` and panicked with `android context was not initialized`.
The panic crossed the JNI callback, which cannot unwind, and terminated the process.
Tauri 2.11 / Tao 0.35 did not initialize this shared context. The runtime is upgraded to
Tauri 2.12 / Tao 0.37, whose Activity startup initializes it before any audio queries.
The lockfile regression check requires Tao's shared `ndk-context` dependency; the APK
cold-launch tests exercise the actual initialization and first device query.

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
rustup target add aarch64-linux-android
npm run tauri -- android init --ci --skip-targets-install
node scripts/prepare-android.mjs
npm run tauri -- android build --ci --apk --target aarch64
# On an emulator or a disposable test device; this clears the test app's data:
node scripts/smoke-android.mjs /absolute/path/to/app.apk com.nosugark.realingo.debug
```

The default package ID above is for a test-signed release. Pass
`com.nosugark.realingo` for a production-signed APK. The smoke runner clears that
package's data, performs two cold launches, requires rendered WebView controls,
opens About/Settings/Permissions, edits hotwords, resumes from the background and tests microphone
capture and grant/revocation across launches. It also authorizes the native floating
subtitles, moves them over the launcher, and exercises system-audio consent cancellation
and actual AudioPlaybackCapture frames. It saves screenshots, UI XML and logcat in
`android-smoke/` (override with `ANDROID_SMOKE_OUTPUT`). Never use the smoke runner
against an installation containing settings/history you want to keep.

`.github/workflows/android-test.yml` runs on main pushes, PRs, and manual dispatch. It builds release ARM64 and x86_64 APKs, then runs the latter on API 35 with 4 KB pages and API 36 (`google_apis_ps16k`) with 16 KB pages. The API 35 16 KB preview's older WebView is not used. The page size is asserted on the emulator. The API 26
default emulator image has no WebView provider; testing older supported devices requires
an installed, current WebView and remains a separate device check. Both this
workflow and the ARM64 release workflow check APK ZIP alignment and every native
library's ELF load-segment alignment. These are regression gates, not evidence that
a particular vendor device has passed. Remote emulator results are available only
after the workflow actually runs.

## Audio, floating subtitles and settings

The microphone default is AAudio's routing sentinel (`AAudio:-1`), which is valid
even when it is absent from the hardware list. Always check the default before
enumerated devices. The source drawer's test buttons open real capture without an API key.

The APK smoke runner also runs a localhost WebSocket peer through `adb reverse`.
It enters a fake key and local URL on the disposable emulator, starts real microphone
and playback sessions, checks that PCM reaches the peer and translated events reach
the screen, and stops each session. Other scenarios withhold setup confirmation,
reject setup, or keep sending pings after finish. This covers the full app session
path without spending a provider API quota; it does not verify the live provider.
The peer records only frame counts and status in `session-peer.json`, never PCM.

Qwen 3.8 now waits for `session.updated` before sending audio. Socket waits can be
cancelled, setup must be acknowledged within ten seconds, and draining after Stop
has an absolute deadline even if the server keeps sending heartbeats. Phone status
must reflect connecting/connected/stopping rather than displaying Listening for all
three. Settings → Session diagnostics shows actual audio-upload time, input level
and the latest server event/error when a particular device or live API still fails.

System audio requires Android 10+, RECORD_AUDIO permission, and fresh MediaProjection
consent for each session. The system may call this screen sharing, but the service
only reads audio. Apps must permit playback capture; protected media and calls may
remain silent even when authorization and PCM delivery work. The native foreground
service keeps capture active when the Activity is in the background.

The subtitle button opens native overlay settings. Grant “display over other apps”,
then show the window. When unlocked, drag its title or lower-right resize handle.
Locking enables touch-through; return to the app to unlock or hide it. Font sizes,
colors, opacity, alignment, width and wrapping apply immediately. Positions persist
across sessions. The separate fullscreen option stays inside ReaLingo.

Phone settings expose the same Qwen hotwords, region and workspace as desktop.
Hotwords use one `source=translation` per line (up to 1000), are saved automatically,
and apply to the next translation session. Voice selection, stream font sizes and
history are also available. TXT/SRT exports use Android's system document picker,
not desktop filesystem paths.

## Android version and update identity

`Cargo.toml` remains the version source. Preparation writes the full version to Android's `versionName` and updates `versionCode`, including the generated Gradle properties:

```text
base = major * 1000000 + minor * 1000 + patch
stage = alpha.N: N; beta.N: 100 + N; rc.N: 200 + N; stable: 999
versionCode = 1000000 + base * 1000 + stage
```

Prerelease counters range from 1 to 99; minor/patch must be below 1000 and the final code must fit Android's 2,100,000,000 limit. For example, `0.8.0-beta.1` is `9000101` and `0.8.0` is `9000999`. Stable follows the prereleases and advances past historical 0.7.x codes. Both workflows inspect the finished APK with aapt; an in-app version label alone cannot prove the installed package version.

Branch pushes require the four configured signing secrets (`ANDROID_KEYSTORE_BASE64`,
`ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`) and produce
`com.nosugark.realingo`. PRs without secrets can use the `.debug` package. Temporary
debug keys cannot update earlier APKs signed with a different key. A production APK
can update only the same package signed by the same key; an existing `.debug` test
installation has a separate identity. Keep the production keystore stable.

## Release validation and feedback

The published [v0.8.0 release](https://github.com/noSugarK/ReaLingo/releases/tag/v0.8.0) passed:

- [Main CI](https://github.com/noSugarK/ReaLingo/actions/runs/42559374377).
- [Android API 35 / 4 KB and API 36 / 16 KB emulator checks](https://github.com/noSugarK/ReaLingo/actions/runs/42559374379).
- [Windows, macOS universal, Linux DEB/RPM and Android arm64 release builds](https://github.com/noSugarK/ReaLingo/actions/runs/42559402548).

The release workflow publishes only after all platform builds and the same commit's main CI and Android smoke tests succeed. Push the release commit to main before pushing its tag. ARM64 APK compilation and x86_64 emulator results do not establish compatibility with every ARM64/vendor device.

About uses compact repository, author, issue, email and license icons. Their accessible names are part of smoke navigation: the license button exposes `MIT License`. Feedback email is `nosugark@qq.com`.

Android currently persists API keys through the plaintext `settings.json` fallback in the app-private directory; it does not use Android Keystore. Do not share configurations containing keys.

## Capture a device crash without clearing app data

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

This uses the existing `brand/app-icon.png`, generates all Android densities and adaptive
icons, and fixes the CLI's 49px hdpi output to the required 72px. The header uses the
transparent `src/assets/mark.png`; About uses the same app artwork as the launcher.
Missing launcher assets fail preparation instead of silently retaining template icons.

`src-tauri/tauri.android.conf.json` declares only `main`. Tauri automatically merges
it on Android, including local builds; preparation does not remove the desktop subtitle
window from `tauri.conf.json`. Do not close a second Activity after startup as a substitute
for selecting the correct platform configuration.
