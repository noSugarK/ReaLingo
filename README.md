<p align="center">
  <img src="brand/banner.png" width="380" alt="ReaLingo" />
</p>

<p align="center"><b>实时语音翻译</b> — 支持阿里云百炼 Qwen、OpenAI、Google Gemini、火山引擎豆包的桌面与 Android 实时同声传译工具</p>

<p align="center">
  <a href="https://github.com/noSugarK/ReaLingo/actions/workflows/build.yml"><img alt="build" src="https://img.shields.io/github/actions/workflow/status/noSugarK/ReaLingo/build.yml?style=flat-square&label=build" /></a>
  <a href="https://github.com/noSugarK/ReaLingo/releases/latest"><img alt="release" src="https://img.shields.io/github/v/release/noSugarK/ReaLingo?style=flat-square&color=0a84ff" /></a>
  <a href="https://github.com/noSugarK/ReaLingo/releases"><img alt="downloads" src="https://img.shields.io/github/downloads/noSugarK/ReaLingo/total?style=flat-square&color=5e5ce6" /></a>
  <a href="https://github.com/noSugarK/ReaLingo/stargazers"><img alt="stars" src="https://img.shields.io/github/stars/noSugarK/ReaLingo?style=flat-square&color=bf5af2" /></a>
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/github/license/noSugarK/ReaLingo?style=flat-square" /></a>
  <a href="#平台支持"><img alt="platform" src="https://img.shields.io/badge/Windows%20%7C%20macOS%20%7C%20Linux%20%7C%20Android-8a8f98?style=flat-square" /></a>
  <a href="https://hub.xerj.org/contributors/noSugarK"><img alt="XERJ Corpus Hub contributor" src="https://hub.xerj.org/contributors/noSugarK/badge.svg" /></a>
</p>

<p align="center"><a href="https://nosugark.github.io/ReaLingo/">项目主页</a> · <b>简体中文</b> · <a href="README.en.md">English</a></p>

Tauri 2 + Rust 内核，Vue 3 前端，苹果液态玻璃风格界面。

## 下载与安装

从 [Releases](https://github.com/noSugarK/ReaLingo/releases/latest) 取对应平台的安装包：
Windows `.exe` / `.msi`、macOS `.dmg`（Intel 与 Apple Silicon 通用）、Linux `.deb` / `.rpm`、Android arm64 `.apk`。
Windows / macOS 安装包没有商业代码签名或 Apple 公证，首次打开按下面放行；Android APK 使用固定发布密钥签名，可覆盖升级同包名的正式版本。

| 系统 | 安装 | 首次打开 |
|---|---|---|
| Windows 10/11 | 双击 `ReaLingo_x.y.z_windows_x86_64-setup.exe`（或 `.msi`） | SmartScreen 提示「Windows 已保护你的电脑」时点 **更多信息 → 仍要运行**；之后从开始菜单打开 |
| macOS 12+ | 打开 `.dmg`，把 ReaLingo 拖进「应用程序」 | 提示「已损坏」或「无法验证开发者」时，终端执行 `xattr -dr com.apple.quarantine /Applications/ReaLingo.app`，或到 **系统设置 → 隐私与安全性** 点 **仍要打开**；随后按提示允许麦克风 / 系统录音 |
| Ubuntu 22.04+ | `sudo apt install ./ReaLingo_x.y.z_linux_x86_64.deb`（用 apt 才会拉依赖） | 从应用菜单打开，或终端运行 `realingo` |
| 兼容的 RPM 发行版 · x86_64 | `sudo dnf install ./ReaLingo_x.y.z_linux_x86_64.rpm` | 需要 WebKitGTK 4.1、Ayatana AppIndicator 和 PulseAudio 工具，目标发行版安装兼容性仍需实测 |
| Android 8.0+ · arm64 | 安装 `ReaLingo_x.y.z_android_arm64.apk`，按提示允许从浏览器或文件管理器安装 | 系统声音采集需 Android 10+；按需授予麦克风、系统声音和悬浮窗权限 |

macOS 升级后系统声音没反应：到 **系统设置 → 隐私与安全性 → 屏幕与系统录音**（以及 **麦克风**）
里删掉 ReaLingo，重开应用再授权一次 —— ad-hoc 签名每个版本都不同，旧的授权可能对不上。

## 功能

- **三种音频来源**：麦克风 / 系统声音 / 本地音频文件（Windows、macOS 14.4+、Ubuntu 和 Android 10+ 可直接采系统声音）
- **五种接口可选**：阿里云百炼 Qwen3.8（60 语种，默认）、Qwen3.5（60 语种）、
  OpenAI `gpt-realtime-translate`（输出 13 种语言）、Google Gemini Live Translate（54 种语言）、
  火山引擎豆包同声传译 2.0（20 种语言，每一对里必须有中文或英文）。
  模型和接入地址都能自己改，兼容同一接口的服务（代理、私有部署）也能接；各家的 API Key 分开保存
- **源语言可自动检测**（Qwen3.5 也可以手动指定；豆包必须手动指定）
- **中英互译**：豆包接口下语言卡片里切到「中英互译」，说中文出英文、说英文出中文，同一场会话里自动切换，
  当前说的是哪一边会亮一个点
- **朗读译文**：语言卡片里打开，由模型直接合成，不另接 TTS。Qwen 有 47 种音色可选，29 种目标语言有语音输出，
  其余只能出文字，开关会变灰；OpenAI 和 Gemini 所有目标语言都能朗读，音色由服务端决定；
  豆包能朗读 8 种目标语言，默认复刻说话人自己的音色，目标是中英时也可选 2 个预置音色。
  录系统声音时，Windows、macOS 和 Android 会把 ReaLingo 自己的朗读排除在采集之外，
  不会被录回去再翻一遍（见「平台支持」）；用麦克风时扬声器的声音会被收回去，请戴耳机
- **桌面独立字幕窗**：默认置顶，双语 / 仅译文 / 仅原文，背景不透明度、字号、字体颜色、描边、
  对齐方式（左 / 中 / 右）可调；长句可选「自动加高」（换行，窗口跟着文字长高，底边不动）
  或「单行滚动」（每行不换行，滚到最新的字，说过的从左边切掉）；
  锁定后鼠标点击穿透（不挡住下面的播放器）；解锁状态下在字幕窗上右键，
  显示内容 / 对齐 / 长句处理 / 点击穿透 / 隐藏都能直接改，不用切回主窗
- **桌面系统托盘**：标题栏「收起到托盘」把主窗藏起来，翻译和字幕窗照常跑；左键托盘图标唤回主窗，
  右键快捷菜单可开始/停止、开关字幕窗、切换显示内容与点击穿透、退出。
  Windows 11 默认把新托盘图标折叠进 `^` 里，想常驻就从溢出区拖到任务栏上
- **界面中英文切换**，浅色 / 深色 / 跟随系统
- 译文导出 TXT / SRT。SRT 的时间轴是这句话在**音频里的位置**（从音频开头算起），
  导出文件的字幕能直接对上原视频：Qwen3.5 和豆包用服务端给的起止时间，OpenAI 用 `elapsed_ms`，
  Gemini 没有时间信息，按文字到达时已送出的音频长度算，会晚一个模型延迟
- **翻译历史**：默认不记录；翻译流右上角的开关打开后，这一场存成一个文件，
  在旁边的「翻译历史」里按场次翻看、搜索、导出、删除。存在 `app-data/history/` 下，
  一场一个 JSONL，追加写，进程被杀最多丢最后一句
- **关于面板**：点标题栏左上角 logo 打开，显示版本、检查更新（比对 GitHub 最新 release）、
  桌面端还显示该版本的新增与修复（按界面语言显示）。双端提供仓库、作者、反馈、邮箱和许可证图标入口；邮件反馈：`nosugark@qq.com`。桌面标题栏 logo 下方显示当前模型，点它直达设置
- 桌面端内置 `rt://raw` 事件查看器（标题栏 `< >` 按钮），用于排查协议字段

## Android 使用

1. 在模型卡片选择接口和模型，在设置中填入对应厂商的 API Key。
2. 选择语言和音频来源：麦克风、系统声音或音频文件，再点「开始翻译」。
3. 麦克风录音需要授权；系统声音需要 Android 10+，每次会话均需同意系统录制提示。部分应用不允许采集，受保护内容和通话可能静音。
4. 跨应用字幕需要「显示在其他应用上层」权限；可拖动、缩放，锁定后触摸穿透。全屏字幕在应用内显示。
5. 朗读可选扬声器、听筒或耳机，音色列表支持搜索；历史记录与 TXT/SRT 导出通过系统文件选择器保存。

权限中心和会话诊断可查看授权及音频上传状态。不同厂商的后台限制仍需在真机上验证。
`.debug` 测试包和正式包是两个独立应用，旧测试包的设置和历史不会自动迁移。

## 接口对比

<details>
<summary><b>展开：语言、朗读、连接地址与价格</b></summary>

| 接口 | 默认模型 | 语言 | 朗读 | 中英互译 | 连接地址 | 鉴权 |
|---|---|---|---|---|---|---|
| Qwen3.8（百炼） | `qwen3.8-livetranslate-flash-realtime` | 60 种，源语言自动检测 | 29 种目标语言，47 种音色 | — | `wss://dashscope.aliyuncs.com/api-ws/v1/realtime`（北京）<br>`wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime`（新加坡） | `Authorization: Bearer` |
| Qwen3.5（百炼） | `qwen3.5-livetranslate-flash-realtime` | 60 种，源语言可指定 | 同上 | — | 同上 | 同上 |
| OpenAI | `gpt-realtime-translate` | 听 70+ 种，输出 13 种 | 全部目标语言，服务端定音色 | — | `wss://api.openai.com/v1/realtime/translations` | `Authorization: Bearer` |
| Gemini（Google） | `gemini-3.5-live-translate-preview` | 54 种 | 全部目标语言，服务端定音色 | — | `wss://generativelanguage.googleapis.com/ws/…BidiGenerateContent` | URL 参数 `key=` |
| 豆包同声传译（火山引擎） | 豆包同声传译 2.0 | 20 种，每对须含中文或英文；源语言必须指定 | 8 种目标语言，复刻说话人或 2 个预置音色 | ✓ | `wss://openspeech.bytedance.com/api/v4/ast/v2/translate` | `X-Api-Key` + `X-Api-Resource-Id` |

**价格**（2026-11 查询各家官方价目，不含促销；以控制台为准）

| 接口 | 官方单价 | 折合每分钟（估算） | 免费额度 |
|---|---|---|---|
| Qwen3.8 | 每百万 token：音频输入 $7.5、文本输出 $20、音频输出 $30（新加坡）；$5.653 / $14.133 / $22.613（北京） | 听 1 分钟约 $0.003（新加坡）；朗读每分钟另约 $0.023 | 北京在[免费额度页](https://bailian.console.aliyun.com/cn-beijing/costing-balance/free-quota?model=livetranslate)手动开通；新加坡开通百炼后自动发放 |
| Qwen3.5 | 新加坡同 Qwen3.8；北京 $5.501 / $13.752 / $22.003 | 同上 | 已停发新用户额度（2026-10-29 起） |
| OpenAI | $0.034 / 分钟（按输入音频时长计） | $0.034 | 无 |
| Gemini | 每百万 token：音频输入 $3.50、音频输出 $21.00（预览价） | 听 $0.0053 + 朗读 $0.0315，官方合计约 $0.0368 | 免费层可用，限额以 [AI Studio](https://aistudio.google.com/rate-limit) 为准 |
| 豆包同声传译 | 每百万 token：输入 ¥80、文本输出 ¥80、音频输出 ¥300（后付费）；预付费资源包折合 ¥40–56 / 百万 token | 听 1 分钟约 ¥0.03；朗读每分钟另约 ¥0.45 | 100 万 token，在[开通管理](https://console.volcengine.com/speech/new/setting/activate)里手动开通同声传译模型后发放 |

「折合每分钟」按官方给的音频 token 折算：Qwen 输入每秒 7 个、输出每秒 12.5 个；豆包输入每秒 6.25 个、输出每秒 25 个；
Gemini 和 OpenAI 直接取官方的每分钟价。译文文本按字数另计，通常远小于音频部分。

价格来源：[百炼模型价格](https://www.alibabacloud.com/help/en/model-studio/model-pricing)、
[OpenAI 价格](https://developers.openai.com/api/docs/pricing)、
[Gemini API 价格](https://aistudio.google.com/docs/pricing)、
[豆包语音计费说明](https://docs.volcengine.com/docs/doubao-voice/billing-instructions?lang=zh)

</details>

## 配置

首次启动后点右上角齿轮（或标题栏 logo 下方的模型名）。设置分「连接 / 翻译 / 高级」三组：

| 项 | 说明 |
|---|---|
| 接口 | 决定按哪种消息格式通信：**Qwen3.5**、**Qwen3.8**（阿里云百炼）、**OpenAI**、**Gemini Live Translate**（Google）、**豆包同声传译**（火山引擎）。两个 Qwen 接口共用百炼的 Key。切换时每个接口记住自己的模型、每家记住自己的自定义地址 |
| API Key | 每家一个；桌面端优先使用系统凭据库，Android 当前使用明文私有配置（见下）。获取：[百炼控制台](https://bailian.console.aliyun.com/cn-beijing/model/settings/api-key)（链接随地域切换）、[OpenAI](https://platform.openai.com/api-keys)、[Google AI Studio](https://aistudio.google.com/apikey)、[豆包语音控制台](https://console.volcengine.com/speech/new/setting/apikeys)，设置页里都有直达链接。豆包的 Key 要先在[开通管理](https://console.volcengine.com/speech/new/setting/activate)里开通「同声传译」才能用 |
| 翻译模型 | 下拉选预设，或选「自定义…」填任意模型 ID。预设：Qwen3.8（60 语种，默认）、Qwen3.5（60 语种）、`gpt-realtime-translate`（输出 13 种语言）、`gemini-3.5-live-translate-preview`（54 种语言）、豆包同声传译 2.0（20 种语言；接口不收模型名，这一项只用于显示）。语言选择器只列当前模型支持的语言，当前选择不在其中会自动回退 |
| 地域 | 仅 Qwen。华北2（北京）/ 新加坡 —— 目前只有这两个地域提供 LiveTranslate 模型 |
| 业务空间 ID | 仅 Qwen，**选填**。留空走公共域名 `dashscope[-intl].aliyuncs.com`；填写后走业务空间专属域名 `{id}.{地域}.maas.aliyuncs.com`。北京的 ID 形如 `llm-…`，新加坡形如 `ws-…` |
| 热词 | 仅 Qwen，**选填**。每行一条「源词=译文」，让模型按你的说法翻专有名词（`人工智能=Artificial Intelligence`）。最多 1000 条，随会话下发，翻译进行中改动要重新开始才生效 |
| 自定义地址 | 「高级」里，**选填**。留空用该接口的默认地址；填写后按原样连接，Qwen / OpenAI 没带 `model` 参数时自动补上，Gemini 和豆包原样使用（模型写在会话配置里 / 不需要模型名） |

「高级」里同时实时显示最终会连接的 WebSocket 地址（Gemini 的 Key 不会出现在这里）。

**API Key 存哪儿**：交给操作系统的凭据库 —— Windows 凭据管理器（DPAPI）、macOS 钥匙串、
Linux Secret Service，密钥由 OS 从你的登录凭据派生，磁盘上不存在可读形式；`settings.json`
里只剩其余配置。旧版本留在配置文件里的 key 首次启动时会自动搬进去并清空原位置。

自己拿 AES 加密没有意义：程序必须无人值守地解密，密钥只能随二进制分发，而这是开源仓库，
`strings` 一下就有 —— 那是混淆不是加密，反而给人虚假的安全感。凭据库真正挡住的是配置文件外泄
（被云盘同步、躺在备份里、贴进 issue、硬盘被拿走）；挡不住以你账号身份运行的恶意程序，
那种情况下它直接调 API 就能取。

上面的系统凭据库说明适用于桌面端。Android 当前没有接入系统密钥库，API Key 保存在应用私有目录的 `settings.json` 中，属于明文回退；Linux 没有可用 Secret Service 时也使用此回退，设置页会提示。不要将包含 Key 的配置文件放进反馈或共享备份。

## 平台支持

| | 麦克风 | 系统声音 | 说明 |
|---|---|---|---|
| Windows 10/11 | ✅ | ✅ | WASAPI loopback，无需额外配置。朗读时改用 process loopback 排除自身（Windows 10 2004+） |
| macOS 14.4+ | ✅ | ✅ | Core Audio process tap；首次使用会弹权限申请。朗读时 tap 把自身进程列为排除 |
| macOS 12–14.3 | ✅ | ❌ | process tap 是 14.4 才有的 API |
| Ubuntu 22.04+ | ✅ | ✅ | 绕开 ALSA，直接向 PulseAudio / PipeWire 要 monitor 源（见下） |
| Android 8 / 9 · arm64 | ✅ | ❌ | 支持麦克风与音频文件；系统声音 API 从 Android 10 起可用 |
| Android 10+ · arm64 | ✅ | ✅ | AudioPlaybackCapture；每次会话需系统授权，排除自身进程音频 |

<details>
<summary><b>平台细节：Linux 系统声音、macOS 权限、Linux 托盘</b></summary>

**Ubuntu 的系统声音**：ALSA 既没有回录标志，也不枚举 PulseAudio/PipeWire 的 monitor 源 ——
monitor 正是「录下这个输出在放什么」的设备，pavucontrol 里能选到的就是它。所以 Linux 的系统声音
不走 cpal，而是直接跟声音服务器说话（`src-tauri/src/audio/pulse.rs`）：

- `pactl list sources` 列出全部源，带 `Monitor of Sink` 的就是 monitor，直接进设备下拉框
- `parec` 录其中一个，raw PCM 走 stdout。直接问它要 s16le / 单声道 / 当前接口要的采样率（16k 或 24k），降混和重采样由声音
  服务器做完，样本到手就是上行要的形状，跳过我们自己那套管线

这俩工具说的是 PulseAudio 协议，PipeWire 也提供（`pipewire-pulse`），一条路覆盖两个声音服务器。
它们来自 `pulseaudio-utils`，已写进 `.deb` 的 `depends`。

只有在**没有声音服务器应答**时（无桌面环境的机器）才回到老办法：设备列表里不给系统声音，
界面提示你自己在 `pavucontrol` →「录制」标签把 ReaLingo 的来源改成输出设备的 Monitor。

**朗读时为什么不会录回去**：朗读在 Rust 里用 cpal 播放（`src-tauri/src/player.rs`），不交给 webview。
排除是按进程算的，而 webview 的声音来自另一个 WebView2 / WebKit 进程。

- Windows（`src-tauri/src/audio/wasapi.rs`）：process loopback 的 `EXCLUDE_TARGET_PROCESS_TREE` 模式，
  录「默认输出设备上除了本进程树以外的所有声音」。它只能录默认设备，而朗读也放在默认设备上，
  所以只有选中的就是默认设备时才走这条路；选了别的设备本来就录不到朗读，仍走普通 loopback
- macOS（`src-tauri/src/audio/tap.rs`）：系统声音一律走自建的 tap，包成私有聚合设备交给 cpal 当普通输入读；
  朗读时把本进程列进排除名单。本进程要先在 Core Audio 里出现才查得到，所以先开播放再开采集。
  不用 cpal 0.17 自带的 tap：它建聚合设备时关了 tap 自动启动，只录到静音；设备 UID 是写死的，
  又不销毁，第二次开始就报 `Illegal operation`。新建的聚合设备要过一小会儿才报得出输入配置，
  所以建好后会等它就绪再交给 cpal

**macOS 签名**：没有 Apple 开发者证书，`.app` 用 ad-hoc 签名（`signingIdentity: "-"`）。
不签的话只有可执行文件带着链接器加的签名，`Info.plist` 和资源没被封进去，系统记不住授过的权限，
麦克风会一直重复申请。hardened runtime 关掉：它只对公证有意义，开着还得另配录音的 entitlement。
下载后首次打开会被 Gatekeeper 拦住，执行 `xattr -dr com.apple.quarantine /Applications/ReaLingo.app`，
或在「系统设置 → 隐私与安全性」里点「仍要打开」。

**macOS 权限**：麦克风和系统声音是两个独立的 TCC 权限，分别对应 `src-tauri/Info.plist` 里的
`NSMicrophoneUsageDescription` 和 `NSAudioCaptureUsageDescription`。后者缺失时 macOS
**不会报错**，只会一直给全静音的音频缓冲区；而且权限弹窗只对已签名的二进制出现。

**Linux 托盘**：AppIndicator 不支持左键单击事件，所以左键唤回主窗在 Ubuntu 上不生效，
用右键菜单里的「显示主窗口」。

</details>

## 开发

需要 Node.js 24+、Rust 1.90+ 和对应平台的构建依赖。Android 另需 JDK 17、SDK 36 与 NDK 28.2.13676358，详见 [Android 开发与测试](development/android-testing.md)。

```bash
npm install
npm run tauri dev
```

<details>
<summary><b>构建、发布与图标生成（平时用不到）</b></summary>

各平台构建依赖：

```bash
# Ubuntu
sudo apt install libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf \
                 libasound2-dev libssl-dev build-essential curl wget file

# macOS
xcode-select --install

# Windows：Visual Studio Build Tools（C++ 桌面开发）+ WebView2（Win11 自带）
```

调试运行中的界面（`scripts/cdp.mjs`）—— WebView2 里看不到 DevTools 时很有用，
可以直接在真实应用的页面里求值，而不是靠猜：

```bash
# 带远程调试端口启动
WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 npm run tauri dev
# 另开一个终端
node scripts/cdp.mjs --list                 # 列出可调试页面
node scripts/cdp.mjs probe.js               # 在主窗口求值
node scripts/cdp.mjs probe.js subtitle      # 在字幕窗求值
```

macOS 和 Ubuntu 的安装包没法在 Windows 上交叉编译，由 `.github/workflows/build.yml`
（**build & release**）在 GitHub Actions 上生成 Windows、macOS、Linux 和 Android 四个平台的安装包：

| 触发方式 | 结果 |
|---|---|
| Actions 页手动运行 | 四个平台分别生成 workflow artifact，不公开 Release |
| 推 `v*` tag | 同上，外加一个 GitHub Release，安装包作为附件 |

发布流程是「先建草稿 → 四个平台分别上传 → **构建、同一提交的 main CI 与 Android 15/16 模拟器测试全部通过后**才公开发布」，
所以任一平台挂掉时 release 会停在草稿状态，不会放出半套包。tag 与
`src-tauri/Cargo.toml` 里的 `version` 不一致会直接失败，避免发出版本号对不上的包。

版本号只有一处：`src-tauri/Cargo.toml` 的 `[package] version`。`tauri.conf.json` 不写
`version` 字段，Tauri 会回落到 Cargo.toml；`package.json` 是 `private` 的，也不带版本号。
CI 就按这一处校验 tag。预发布标签会标记为 Pre-release，不替换稳定版 Latest；Windows MSI 不接受文字预发布后缀，若发布 Beta 等版本须先配置独立的数字 MSI 版本。

打 tag 前必须将发布说明提交到 `.github/release-notes/v<版本号>.md`；CI 建 release 时把它放在最前面，
后面接 GitHub 自动生成的提交列表。说明按 Keep a Changelog 分类，保留对应的中英文内容；
版本、格式及发布前核对要求见[编码规范「版本与发布」](CODING_STANDARDS.md#版本与发布)。

```bash
# X.Y.Z 替换为要发布的版本；更新 Cargo.toml / Cargo.lock 和对应发布说明后提交
# 必须先推 main：发布流程会查找同一提交的 main CI 和 Android 测试
git push origin main
git tag vX.Y.Z
git push origin vX.Y.Z
```

| artifact | 内容 |
|---|---|
| `realingo-x86_64-pc-windows-msvc` | `.msi` + NSIS `.exe` |
| `realingo-universal-apple-darwin` | `.dmg`，**Intel 与 Apple Silicon 通用** |
| `realingo-x86_64-unknown-linux-gnu` | `.deb` + `.rpm` |
| `realingo-android-arm64` | 固定发布密钥签名的 `.apk` |

macOS 不再单独跑 Intel job —— `macos-13` runner 已于 2025-12 退役，x86_64 的 job 只会一直排队；
改为在 Apple Silicon 上交叉编译出 universal 二进制，一个 DMG 通吃。

发布文件统一命名为 `ReaLingo_<版本>_<系统>_<架构>.<格式>`，Windows EXE 保留 `-setup` 后缀。
系统与架构分别为 `windows_x86_64`、`macos_universal`、`linux_x86_64`、`android_arm64`。
macOS universal 包同时包含 Intel x86_64 和 Apple Silicon arm64。

Linux 同时提供 DEB 和 RPM，由包管理器安装运行依赖：

```bash
sudo apt install ./ReaLingo_*_linux_x86_64.deb  # Ubuntu / Debian
sudo dnf install ./ReaLingo_*_linux_x86_64.rpm  # Fedora 等 RPM 发行版，需提供 WebKitGTK 4.1
```

RPM 声明 `webkit2gtk4.1`、Ayatana AppIndicator 共享库和 `pulseaudio-utils` 依赖。
目前不提供 AppImage。RPM 的实际发行版兼容性仍需在对应系统上验证。

打包：

```bash
npm run tauri build
```

测试（重采样、地址拼接、各接口的消息格式与字幕切分）：

Android 的权限、会话、图标、版本码及 APK 启动验证见 [Android 测试与闪退排查](development/android-testing.md)。

```bash
cd src-tauri && cargo test
```

图标：源文件是 `brand/ReaLingo.png`（完整 logo，带文字）。应用图标只取上半部分的图形标 ——
「ReaLingo」那行字在 32×32 任务栏尺寸下会糊成一团，所以裁掉，并把图形放到白色圆角底板上
（直接抠白底会在抗锯齿边缘留白边）。logo 换了就重跑：

```bash
node scripts/make-icon.mjs brand/ReaLingo.png brand/app-icon.png 1024
npx tauri icon brand/app-icon.png
```

应用内标题栏的 logo 不走这条路：白底板是给 OS 图标网格用的，放进界面里就是块贴在标题栏上的
白卡片，深色主题下尤其突兀。它由 `make-banner.mjs` 的 `--mark` 模式出，只取图形、透明底：

```bash
node scripts/make-banner.mjs brand/ReaLingo.png src/assets/mark.png 256 --mark
```

README 顶部的横版 logo 由 `make-banner.mjs` 把上下堆叠的原 logo 重排成「图形在左、彩色字在右」，
并按**连通性**（从边缘 flood fill）抠掉白底 —— 不能按颜色抠，否则气泡里白色的 A 和 文 会一起没掉，
在深色主题下变成黑窟窿。`make-anim.mjs` 再给它加一道循环掠过的高光：

```bash
node scripts/make-banner.mjs brand/ReaLingo.png brand/banner.png 160
node scripts/make-anim.mjs brand/banner.png brand/banner-animated.png
```

抠白底对两半用了**不同规则**，因为没有单一规则能同时做对：图形里气泡中的白色 A / 文 是**内容**，
按连通性（从边缘 flood fill）保留；而文字里 R、e、a、o 的内腔是**背景**，只是恰好被笔画围住，
连通性会把它们留成白块，所以那一半按颜色全抠。两边都按白底解算出**渐变 alpha** 而不是非黑即白 ——
二值遮罩会让抗锯齿的那圈薄边保持不透明的近白色，在深色主题下就是一圈光晕。

README 默认用静态版（117 KB）。动图版 `brand/banner-animated.png`（478 KB）也在仓库里，
把头部的 `banner.png` 换成 `banner-animated.png` 即可启用。用 APNG 而不是 GIF：
GIF 只有 256 色，渐变字会断层，且 1-bit 透明会在深色底上留白边；APNG 全彩 + 完整 alpha，
后缀仍是 `.png`，不支持动画的地方退化成第一帧（即静态 logo）。

</details>

## 架构


<details>
<summary><b>数据流、为什么 WebSocket 在 Rust 侧、重采样</b></summary>

```
麦克风 ──┐
系统声音 ─┤→ 降混单声道 → 窗化 sinc 重采样 16/24kHz → i16 → 100ms 分块 ─┐
音频文件 ─┘   (cpal / symphonia)                                        │
                                                                        ▼
              前端 ←── rt://event ── 事件解析 ←── WebSocket ←── base64 + 各接口的音频帧
             (Vue)                   (realtime.rs)
```

- **WebSocket 放在 Rust 侧**：百炼和 OpenAI 的实时接口用 `Authorization` 请求头鉴权，浏览器
  `WebSocket` 构造函数无法设置请求头。所有平台复用同一套 Rust 会话与协议处理。
- **各接口的差异**集中在 `src-tauri/src/config.rs`：上行采样率（OpenAI 24kHz，其余 16kHz）、
  音频帧与结束帧的格式、会话配置、怎样算结束。Gemini 的 Key 走 URL 参数而不是请求头，
  且只在连接时拼上，不出现在设置页的地址预览里。
- **豆包是 Protobuf**：火山的同传接口走二进制帧，消息结构按官方 `.proto` 在 `src-tauri/src/volc.rs`
  里用 `prost` 派生手写（不需要装 `protoc`），收到后转成 JSON 再走和其他接口相同的处理路径。
  鉴权是 `X-Api-Key` + 固定的 `X-Api-Resource-Id`；它的 24kHz PCM 输出是 32 位浮点，解码时转成 16 位。
- **字幕配对**：Qwen 按服务端的轮次 id 配对原文和译文；豆包每句先发原文再发译文，按顺序一一对应；
  OpenAI 和 Gemini 只给两条增量文字流，
  按句末标点切出轮次，原文在自己最后一个句末处切开，余下的带进下一行。
- **Gemini 的收尾**：它不发结束信号，停止后还会一直推静音帧，所以停止时先补约 3 秒静音
  （不然最后半句出不来），之后连续 4 秒没有新文字、也没有非静音音频就结束会话。
- **系统声音**：Windows 使用 WASAPI loopback / process loopback，macOS 使用 Core Audio process tap，Linux 通过 `pactl` / `parec` 读取 monitor 源；Android 用 Kotlin 前台服务和 AudioPlaybackCapture 采集 PCM，再交给 Rust 音频模块。平台边界见 `src-tauri/src/audio/`。
- **重采样**：直接窗化 sinc，截止频率取两端奈奎斯特的较小者，任意比率都抗混叠
  （48000/16000 = 3，44100/16000 = 2.75625）。

</details>

## 已知边界

| 不支持 | 原因 / 何时加 |
|---|---|
| Linux 上录系统声音时朗读 | monitor 源录的是整个输出的混音，没有「除了某个程序」的选项，朗读会被录回去。可行方案是只录选定程序的 sink-input（`parec --monitor-stream`） |
| 视频文件（mp4/mkv 抽音轨） | 需打包 ffmpeg sidecar，安装包 +40~80MB |
| Qwen / OpenAI / Gemini 的双语互译 | 豆包接口已支持中英互译；其余接口见下方「其他接口为什么不做互译」 |
| 断线自动重连 | 目前报错后需手动重新开始 —— 实时同传断线本就需要用户知情 |

## 其他接口为什么不做互译

豆包同声传译原生支持中英互译（源语言和目标语言都传 `zhen`），一条会话、一份音频就够了。
其他接口都没有这个能力，要做只能走下面的双通道方案，所以暂时只在豆包下提供。


<details>
<summary><b>实测结论：translation.language 是会话级不可变</b></summary>

直觉做法是监听转写事件里的 `language`，发现说的是目标语言就补发一条 `session.update`
把 `translation.language` 换到另一边。**实测不行** —— 用 `examples/probe.rs` 打真实端点：

```
-> {"type":"session.update","session":{...,"translation":{"language":"en"},...}}
← {"type":"error","error":{"code":"invalid_value",
   "message":"Session update error: session already started or finished or failed."}}
← close  (服务端直接断开连接)
```

`translation.language` 是**会话级不可变**配置；错误里的 "started" 指会话已开始送音频，
不是当前 turn，所以「等这句 done 了再改」同样会被拒。而且它不只是报错，是会把正在跑的
会话打断。

可行方案是**双通道**：同一份音频扇出喂两条并行会话（A→B 和 B→A），按 ASR 报的语种采纳
其中一条的输出。代价是输入音频 token 翻倍（7 → 14 token/秒），输出也是双份。
设计细节记在项目计划里，等这些接口确有互译需求时再做。

</details>

## 许可

[MIT](LICENSE)

## Star History

<a href="https://www.star-history.com/?repos=nosugark%2Frealingo&type=date&legend=bottom-right">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=nosugark/realingo&type=date&theme=dark&legend=bottom-right" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=nosugark/realingo&type=date&legend=bottom-right" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=nosugark/realingo&type=date&legend=bottom-right" />
 </picture>
</a>
