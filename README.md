# ReaLingo · 实时语音翻译

基于阿里云百炼 `qwen3.5-livetranslate-flash-realtime` 的桌面同声传译工具。
Tauri 2 + Rust 内核，Vue 3 前端，苹果液态玻璃风格界面。

## 功能

- **三种音频来源**：麦克风 / 系统声音（Windows WASAPI loopback）/ 本地音频文件
- **60 种语言互译**，源语言可自动检测
- **独立字幕窗**：默认置顶，双语 / 仅译文 / 仅原文，背景不透明度、字号、字体颜色、描边可调，
  锁定后鼠标点击穿透（不挡住下面的播放器）
- **界面中英文切换**，浅色 / 深色 / 跟随系统
- 译文导出 TXT / SRT
- 内置 `rt://raw` 事件查看器（标题栏 `< >` 按钮），用于排查协议字段

## 配置

首次启动后点右上角齿轮：

| 项 | 说明 |
|---|---|
| API Key | 百炼控制台 → API-KEY。只保存在本机 `settings.json` |
| 地域 | 华北2（北京）/ 新加坡 |
| 业务空间 ID | **选填**。留空走公共域名 `dashscope[-intl].aliyuncs.com`；填写后走业务空间专属域名 `{id}.cn-beijing.maas.aliyuncs.com`（性能更好），在百炼控制台业务空间详情页查看 |

设置页底部实时显示最终会连接的 WebSocket 地址。

## 开发

```bash
npm install
npm run tauri dev
```

打包：

```bash
npm run tauri build
```

测试（重采样与地址拼接）：

```bash
cd src-tauri && cargo test
```

图标：源文件是 `brand/ReaLingo.png`（完整 logo，带文字）。应用图标只取上半部分的图形标 ——
「ReaLingo」那行字在 32×32 任务栏尺寸下会糊成一团，所以裁掉，并把图形放到白色圆角底板上
（直接抠白底会在抗锯齿边缘留白边）。logo 换了就重跑：

```bash
node tools/make-icon.mjs brand/ReaLingo.png app-icon.png 1024
node tools/make-icon.mjs brand/ReaLingo.png src/assets/mark.png 256
npx tauri icon app-icon.png
```

## 架构

```
麦克风 ──┐
系统声音 ─┤→ 降混单声道 → 窗化 sinc 重采样 16kHz → i16 → 100ms 分块 ─┐
音频文件 ─┘   (cpal / symphonia)                                    │
                                                                    ▼
              前端 ←── rt://event ── 事件解析 ←── WebSocket ←── base64 + append
             (Vue)                   (realtime.rs)
```

- **WebSocket 放在 Rust 侧**：百炼实时接口用 `Authorization` 请求头鉴权，浏览器
  `WebSocket` 构造函数无法设置请求头。附带好处是 API Key 不进 webview。
- **系统声音**：cpal 的 WASAPI 后端在对 *输出* 设备调用 `build_input_stream` 时会自动带上
  `AUDCLNT_STREAMFLAGS_LOOPBACK`，不需要额外 crate。
- **重采样**：直接窗化 sinc，截止频率取两端奈奎斯特的较小者，任意比率都抗混叠
  （48000/16000 = 3，44100/16000 = 2.75625）。

## 已知边界

| 不支持 | 原因 / 何时加 |
|---|---|
| 译文语音输出（TTS） | 当前 `modalities: ["text"]`。加 `"audio"` + 前端 Web Audio 播放队列即可 |
| 视频文件（mp4/mkv 抽音轨） | 需打包 ffmpeg sidecar，安装包 +40~80MB |
| macOS / Linux 系统声音 | loopback 是 WASAPI 特性；macOS 需 ScreenCaptureKit |
| 双语互译（说中出英 / 说英出中） | 见下方「双语互译为什么还没做」 |
| 断线自动重连 | 目前报错后需手动重新开始 —— 实时同传断线本就需要用户知情 |
| API Key 加密存储 | 明文存本地配置，与多数桌面工具一致；要更严可换 `keyring` |

## 双语互译为什么还没做

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
设计细节记在项目计划里，等确有对话式互译需求时再做。
