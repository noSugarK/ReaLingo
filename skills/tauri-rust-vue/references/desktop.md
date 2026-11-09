# Windows、macOS 与 Linux 桌面集成

## 窗口、托盘与外链

多 WebView 窗口按 label 分配职责和权限；只给实际需要的窗口/操作授权。窗口关闭、隐藏到托盘、退出应用是三种行为，分别决定后台会话是否继续，以及隐藏窗口还有没有唤回入口。托盘在 Linux 的 AppIndicator 上不能假定支持左键事件，应提供可用菜单路径。

置顶字幕/工具窗分别配置透明、装饰、焦点、任务栏可见性和点击穿透；锁定穿透后仍要有可靠的解锁/隐藏入口。系统窗口管理器控制最终 Z-order，不把一次 `always_on_top` 成功当作所有系统的最终视觉保证。

外部网页、GitHub 和 `mailto:` 用 opener 交给系统，避免 `<a>` 导航掉承载原生桥的应用页面。处理没有邮件客户端/系统处理程序的错误，并提供可见、可复制的地址。打开邮件编写器不等于发送邮件。

透明窗口白屏/空白时先分辨：窗口存在但未绘制、前端加载失败、透明背景露出底层、原生崩溃。检查 WebView 控制台和 Rust stderr；WebView2 可在调试环境使用远程调试端口，结束后关闭调试暴露。

## 音频和系统权限

| 平台 | 实现与边界 | 无声或错误时的判断 |
| --- | --- | --- |
| Windows | WASAPI loopback 采整个输出；需要排除自身时评估 process loopback 和系统版本要求 | 麦克风与输出设备分别测试；能录混音不等于已排除本程序朗读 |
| macOS | Core Audio process tap 有最低系统版本；应用需相应 usage description 与 TCC 授权 | 权限被拒可能表现为有效的全零缓冲；先区分权限、设备和 tap 是否开始 |
| Linux | ALSA 的普通输入枚举不包含 PulseAudio/PipeWire monitor；可使用相应客户端/工具 | 查声音服务器是否运行、monitor 是否存在、依赖是否安装；系统整体混音会包含自身播放 |

ReaLingo 的 macOS system-audio 实现以 14.4+ 为条件，Windows process loopback 以 Windows 10 2004+ 为条件；复用时核对实际 API 和目标系统，不将应用最低安装版本等同于所有功能的最低版本。

macOS 升级后失去授权时同时记录 bundle identifier、实际签名和 TCC 状态。ad-hoc 签名变化可能使旧授权失效；系统设置里移除旧授权再请求是诊断手段，不是正式产品必须让用户反复清权限的设计。

## 目标依赖与打包

Rust 后端从统一业务接口进入平台模块。用目标依赖隔离 Windows bindings、Core Audio/Objective-C、Linux 工具和桌面 keyring；查看 `cargo tree --target TARGET -e features` 的实际合并结果，而不只看顶层 manifest。

- **Windows**：MSVC 构建工具与 WebView2 运行时是不同依赖；EXE/NSIS 与 MSI/WiX 是不同打包路径。MSI 的四段数字版本不能直接使用 `beta.1` 文字；在 WiX 专用配置映射数字版本，并保留应用语义版本和升级规则。没有做此映射时，预发布构建仍可能在 MSI 阶段失败。
- **macOS**：按需选择单架构或 universal；universal 同时需要两套 Rust target，不能把产物重命名当作合并架构。代码签名、notarization、隔离标记和录音授权分别验证。当前 runner 是否可用应查实际 CI 平台，不照抄已退役 runner。
- **Linux**：构建机安装 WebKitGTK/GTK、AppIndicator、音频和 TLS 等真实系统依赖；产物声明目标发行版的运行依赖。DEB、RPM 的包名不同，必要时用目标包管理器支持的库 capability；验证安装和运行，不以 RPM 文件生成成功推断所有发行版兼容。

Linux 透明窗口在特定虚拟机/驱动上完全不绘制时，WebKitGTK DMA-BUF 是一个案例线索。ReaLingo 仅在桌面 Linux 且用户未显式设置时使用 `WEBKIT_DISABLE_DMABUF_RENDERER=1`；先用故障环境确认，不给所有 Tauri 项目无条件加这个开关。
