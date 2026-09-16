<p align="center">
  <img src="brand/banner.png" width="380" alt="ReaLingo" />
</p>

<p align="center"><b>Realtime speech translation</b> — a desktop simultaneous interpreter built on Qwen3.5-LiveTranslate</p>

<p align="center">
  <a href="https://github.com/noSugarK/ReaLingo/actions/workflows/build.yml"><img alt="build" src="https://img.shields.io/github/actions/workflow/status/noSugarK/ReaLingo/build.yml?style=flat-square&label=build" /></a>
  <a href="https://github.com/noSugarK/ReaLingo/releases/latest"><img alt="release" src="https://img.shields.io/github/v/release/noSugarK/ReaLingo?style=flat-square&color=0a84ff" /></a>
  <a href="https://github.com/noSugarK/ReaLingo/releases"><img alt="downloads" src="https://img.shields.io/github/downloads/noSugarK/ReaLingo/total?style=flat-square&color=5e5ce6" /></a>
  <a href="https://github.com/noSugarK/ReaLingo/stargazers"><img alt="stars" src="https://img.shields.io/github/stars/noSugarK/ReaLingo?style=flat-square&color=bf5af2" /></a>
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/github/license/noSugarK/ReaLingo?style=flat-square" /></a>
  <a href="#platform-support"><img alt="platform" src="https://img.shields.io/badge/Windows%20%7C%20macOS%20%7C%20Linux-8a8f98?style=flat-square" /></a>
</p>

<p align="center"><a href="https://nosugark.github.io/ReaLingo/">Website</a> · <a href="README.md">简体中文</a> · <b>English</b></p>

Rust core on Tauri 2, Vue 3 front end, Apple liquid-glass interface.

## Download

Grab the installer for your platform from the
[latest release](https://github.com/noSugarK/ReaLingo/releases/latest):
`.msi` for Windows, `.dmg` for macOS (universal — Intel and Apple Silicon), `.deb` for Linux.

## Features

- **Three audio sources**: microphone / system audio / a local audio file
  (Windows, macOS and Ubuntu can all capture system audio directly)
- **60 languages**, with automatic source detection; switchable to the older Qwen3 model (18 languages)
- **Standalone subtitle overlay**: always on top, bilingual / translation only / source only,
  with adjustable background opacity, font size, colours, outline and alignment. A long
  sentence either grows the window taller (bottom edge pinned) or stays on one line that
  scrolls to the newest words — your pick. Lock it to make clicks pass straight through to
  the video underneath. While unlocked, right-click the overlay to change what it shows,
  its alignment, long-sentence behaviour, click-through or to hide it — no trip back to the
  main window
- **System tray**: "Minimize to tray" hides the main window while translation and the overlay
  keep running. Left-click the tray icon to bring the window back; right-click for start/stop,
  overlay on/off, subtitle content, click-through and quit.
  Windows 11 hides new tray icons under `^` by default — drag it onto the taskbar to pin it
- **Interface in Chinese or English**, light / dark / follow system
- Export transcripts as TXT or SRT
- **History**: off by default. Flip the switch above the stream and the run is saved to its
  own file; browse, search, export and delete past runs from the History panel. One JSONL
  file per run under `app-data/history/`, appended as you go
- Built-in `rt://raw` event inspector (the `< >` button in the title bar) for protocol debugging

## Configuration

Open the gear icon in the top-right after first launch:

| Setting | Notes |
|---|---|
| API Key | [Model Studio console → API-KEY](https://bailian.console.alibabacloud.com/?tab=model#/api-key) (China regions: [bailian.console.aliyun.com](https://bailian.console.aliyun.com/?tab=model#/api-key)); the settings page has a direct link too. Kept in the OS credential store — see below |
| Model | `qwen3.5-livetranslate-flash-realtime` (60 languages, default) or `qwen3-livetranslate-flash-realtime` (18). Switching to the older model narrows the language pickers to what it supports, and a language it cannot handle falls back automatically |
| Hotwords | **Optional.** One `source=translation` per line, so proper nouns come out the way you want them (`人工智能=Artificial Intelligence`). Up to 1000; sent with the session, so edits apply the next time you start |
| Region | China (Beijing) / Singapore |
| Workspace ID | **Optional.** Leave blank for the shared endpoint `dashscope[-intl].aliyuncs.com`; filling it in uses your workspace's dedicated domain `{id}.cn-beijing.maas.aliyuncs.com` (better performance). Find it on the workspace detail page |

The settings panel shows the exact WebSocket endpoint it will dial, live.

**Where the API key lives**: in the OS credential store — Windows Credential Manager (DPAPI),
macOS Keychain, Linux Secret Service. The OS derives the encryption key from your login, so no
readable copy sits on disk; `settings.json` keeps everything else. A key left in the config file
by an older build is moved across on first launch and cleared from the file.

Encrypting it ourselves would be pointless: the app has to decrypt unattended, so the key would
ship inside the binary — and this is an open-source repo, `strings` finds it. That is obfuscation,
not encryption, and it buys false confidence. The credential store defends against the config file
leaking (synced to a cloud drive, sitting in a backup, pasted into an issue, a disk walking away).
It does not defend against malware running as you — that can just call the API itself.

On Linux with no Secret Service running (headless, or a minimal distro) it falls back to plain
text in the config file, and the settings page says so rather than pretending otherwise.

## Platform support

| | Microphone | System audio | Notes |
|---|---|---|---|
| Windows 10/11 | ✅ | ✅ | WASAPI loopback, nothing to configure |
| macOS 14.4+ | ✅ | ✅ | Core Audio process tap; macOS asks for permission on first use |
| macOS 12–14.3 | ✅ | ❌ | Process taps are a 14.4 API |
| Ubuntu 22.04+ | ✅ | ✅ | Goes around ALSA and asks PulseAudio / PipeWire for monitor sources (below) |

<details>
<summary><b>Platform details: Linux system audio, macOS permissions, Linux tray</b></summary>

**System audio on Ubuntu**: ALSA has neither a loopback flag nor any knowledge of the
PulseAudio/PipeWire *monitor* sources — and a monitor is exactly the "record what this output
is playing" device you pick in pavucontrol. So system audio on Linux does not go through cpal;
it talks to the sound server directly (`src-tauri/src/pulse.rs`):

- `pactl list sources` lists every source; the ones carrying `Monitor of Sink` go straight
  into the device picker
- `parec` records one and writes raw PCM to stdout. Asking it for s16le/16000/mono has the
  sound server do the downmix and resampling, so samples land in the exact shape the uplink
  wants and skip our own pipeline

Both tools speak the PulseAudio protocol, which PipeWire also serves (`pipewire-pulse`), so
one path covers both. They come from `pulseaudio-utils`, now in the `.deb` `depends`.

Only when **no sound server answers** (a headless box) does the old story apply: no system
audio entries, and the app tells you to point ReaLingo at your output's Monitor in
pavucontrol's Recording tab.

**macOS permissions**: microphone and system audio are two separate TCC permissions, backed by
`NSMicrophoneUsageDescription` and `NSAudioCaptureUsageDescription` in `src-tauri/Info.plist`.
When the latter is missing macOS **does not raise an error** — it just hands back buffers full
of silence. The prompt also only appears for a properly signed binary.

**Linux tray**: AppIndicator has no left-click event, so clicking the tray icon will not restore
the window on Ubuntu. Use "Show window" in the right-click menu.

</details>

## Development

```bash
npm install
npm run tauri dev
```

<details>
<summary><b>Building, releasing and icon generation (rarely needed)</b></summary>

Build prerequisites per platform:

```bash
# Ubuntu
sudo apt install libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf \
                 libasound2-dev libssl-dev build-essential curl wget file

# macOS
xcode-select --install

# Windows: Visual Studio Build Tools (Desktop C++) + WebView2 (bundled with Win11)
```

Inspecting the running UI (`tools/cdp.mjs`) — useful because WebView2 gives you no DevTools;
it evaluates JavaScript inside the real app instead of leaving you to guess:

```bash
# launch with a remote debugging port
WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 npm run tauri dev
# then, in another terminal
node tools/cdp.mjs --list                 # list debuggable pages
node tools/cdp.mjs probe.js               # evaluate in the main window
node tools/cdp.mjs probe.js subtitle      # evaluate in the subtitle overlay
```

macOS and Linux bundles cannot be cross-compiled from Windows, so
`.github/workflows/build.yml` (**build & release**) produces all three on GitHub Actions:

| Trigger | Result |
|---|---|
| Manual run from the Actions tab | One workflow artifact per platform |
| Pushing a `v*` tag | The same, plus a GitHub release with the installers attached |

Releasing goes draft → each platform uploads → **published only once all three succeed**, so a
failure on any platform leaves the release as a draft rather than shipping half a set. A tag
that disagrees with `version` in `tauri.conf.json` fails the run, so the binaries can never
claim the wrong version.

The version lives in exactly one place: `[package] version` in `src-tauri/Cargo.toml`.
`tauri.conf.json` omits the `version` field so Tauri falls back to Cargo.toml, and
`package.json` is `private` and carries none. CI checks the tag against that one place.

```bash
# after bumping version in src-tauri/Cargo.toml
git tag v0.2.1 && git push origin v0.2.1
```

Packaging locally:

```bash
npm run tauri build
```

Tests (resampling and endpoint construction):

```bash
cd src-tauri && cargo test
```

Icons: the source is `brand/ReaLingo.png` (the full logo, wordmark included). The app icon uses
only the graphic above the wordmark — "ReaLingo" turns to mush at 32×32 — mounted on a white
rounded plate, because keying the white background out leaves fringes on the antialiased edges.
Re-run after changing the logo:

```bash
node tools/make-icon.mjs brand/ReaLingo.png app-icon.png 1024
npx tauri icon app-icon.png
```

The in-app titlebar logo does not use that path: the white plate is for OS icon grids, and
inside the UI it reads as a white card stuck on the header — glaringly so in dark mode. It
comes from `make-banner.mjs` in `--mark` mode: graphic only, transparent background.

```bash
node tools/make-banner.mjs brand/ReaLingo.png src/assets/mark.png 256 --mark
```

The horizontal lockup at the top of this file is produced by `make-banner.mjs`, which re-lays
the stacked logo as graphic-left / wordmark-right and removes the white background *by
connectivity* — flood-filling from the border rather than keying on colour, because keying
would also erase the white A and 文 inside the bubbles and leave black holes on a dark page.
`make-anim.mjs` then adds a looping specular sweep:

```bash
node tools/make-banner.mjs brand/ReaLingo.png brand/banner.png 160
node tools/make-anim.mjs brand/banner.png brand/banner-animated.png
```

Background removal uses **two different rules**, because no single one gets both halves right:
the white A and 文 inside the bubbles are *content*, kept by connectivity (flood fill from the
border), while the counters in R, e, a and o are *background* that merely happens to be
enclosed — connectivity would leave them as white blobs, so that half is keyed by colour.
Both halves get a *gradual* alpha from un-matting rather than a yes/no mask: a binary mask
leaves the antialiased rim opaque and near-white, which shows as a halo on a dark page.

The README uses the static banner (117 KB) by default. The animated build
`brand/banner-animated.png` (478 KB) is in the repo too — swap `banner.png` for
`banner-animated.png` in the header to use it. It is APNG rather than GIF: GIF's 256-colour
palette bands the gradient wordmark and its 1-bit transparency leaves white fringes on dark
backgrounds. APNG keeps full colour and alpha, the extension is still `.png`, and anything
that cannot animate it shows frame one — the static logo.

</details>

## Architecture


<details>
<summary><b>Data flow, why the WebSocket lives in Rust, resampling</b></summary>

```
microphone ──┐
system audio ┤→ downmix to mono → windowed-sinc resample to 16 kHz → i16 → 100 ms chunks ─┐
audio file ──┘   (cpal / symphonia)                                                       │
                                                                                          ▼
                front end ←── rt://event ── event parsing ←── WebSocket ←── base64 + append
                  (Vue)                      (realtime.rs)
```

- **The WebSocket lives in Rust**: the endpoint authenticates with an `Authorization` request
  header, and the browser `WebSocket` constructor cannot set headers. Keeping the API key out of
  the webview is a welcome side effect.
- **System audio** is the same call on all three platforms — an input stream on an *output*
  device — with each backend doing something different: Windows adds
  `AUDCLNT_STREAMFLAGS_LOOPBACK`, macOS creates a Core Audio process tap, Linux has no
  equivalent (see the module comment in `src-tauri/src/audio.rs`).
- **Resampling** is a direct windowed sinc with the cutoff pinned to the lower of the two
  Nyquist frequencies, so any ratio is anti-aliased (48000/16000 = 3, 44100/16000 = 2.75625).

</details>

## Known limits

| Not supported | Why / when it would be added |
|---|---|
| Spoken translation output (TTS) | Currently `modalities: ["text"]`. Add `"audio"` plus a Web Audio playback queue |
| Video files (extracting the audio track from mp4/mkv) | Needs an ffmpeg sidecar, +40–80 MB to the installer |
| Two-way translation (speak Chinese → English, speak English → Chinese) | See below |
| Automatic reconnection | You restart manually after an error — a dropped simultaneous-interpreting session is something the user should know about |

## Why two-way translation is not implemented


<details>
<summary><b>Measured result: translation.language is immutable per session</b></summary>

The obvious approach is to watch `language` on the transcript events and, when the speaker
switches to the target language, send another `session.update` flipping `translation.language`.
**Tested against the live endpoint with `examples/probe.rs` — it does not work:**

```
-> {"type":"session.update","session":{...,"translation":{"language":"en"},...}}
← {"type":"error","error":{"code":"invalid_value",
   "message":"Session update error: session already started or finished or failed."}}
← close  (the server drops the connection)
```

`translation.language` is **session-scoped and immutable**. The "started" in that message refers
to the session having begun receiving audio, not to the current turn, so waiting for a sentence
to finish gets rejected just the same — and it does not merely fail, it tears down the running
session.

The workable design is **two lanes**: fan the same audio out to two parallel sessions (A→B and
B→A) and take whichever one is not translating into the language being spoken. The cost is
double the input audio tokens (7 → 14 per second) and double the output. It will be built when
conversational two-way interpreting is actually needed.

</details>

## License

[MIT](LICENSE)
