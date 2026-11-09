---
name: rust-android
description: 开发或审查 Rust Android 应用，处理交叉编译、JNI/Kotlin 桥、音频采集、TLS、前后台生命周期及 APK 验证。适用于 Tauri 移动端移植；纯桌面 Rust 或单纯移动网页布局无需使用。
---

# Rust Android 开发

先确定项目实际使用的 Rust、NDK、Android API、Tauri/Tao、cpal、TLS 和 WebView 版本，再应用下述经验。具体版本来自 ReaLingo 的一次移植，升级后要重新验证兼容性。需要故障特征和历史依据时，读 [references/realingo-cases.md](references/realingo-cases.md)。

## 先划清平台边界

- Rust 保留音频处理、网络协议和可独立测试的状态机；Activity 权限、系统设置、SAF、MediaProjection、悬浮窗交给 Kotlin 或已有原生插件。沿用项目现有桥接方式。
- 读目标相关的 Cargo dependencies 和 feature 合并结果。桌面凭据库、系统托盘、桌面窗口 API、Linux 子进程工具不应无条件进入 Android 路径。用 `cfg(target_os = "android")` 区分 Android；Android 的 `target_os` 是 `android`，不是 `linux`，不要混淆与 `target_family = "unix"` 的关系。
- 对不可用的平台功能返回准确能力或错误。为保持共享调用面可用 stub，但录音、导出、保存密钥不能靠空操作伪装成功。
- Tauri 使用平台配置声明移动端窗口。桌面的第二字幕窗口可能创建另一 Activity，启动后再关闭已经太晚；原生跨应用悬浮窗用 Android overlay。

## 构建与首次启动

- 原生库最低 API 同时约束 Rust 链接与 APK 声明。cpal 0.17 的 AAudio 后端需要 API 26；Tauri 的链接等级来自 `bundle.android.minSdkVersion`，只补生成的 Gradle 文件不能改变 cargo-ndk 的等级。查看真实 linker 命令与成品 manifest。
- 查当前 crate 的真实 feature，避免凭名字猜开关。cpal 0.17 按目标自动选 AAudio，没有 `aaudio` feature。
- 调用依赖 Android context 的 crate 前，核实谁初始化 context，以及消费者是否使用同一依赖实例。ReaLingo 的首次设备枚举曾因 Tauri/Tao 未初始化共享 `ndk-context` 而崩溃；桌面测试与成功打包都覆盖不到此问题。
- JNI/FFI 入口验证数组长度、计数和对象状态，把可恢复错误转换成返回值。panic 跨不可 unwind 的外部边界可能直接 abort；外层异步任务的 `catch_unwind` 不是这类故障的修复。
- 修改生成工程前保存模板渲染值作为证据；补丁重复执行后结果应一致，漏匹配要可诊断。验证生成文件和成品，避免测试仅确认自己写入的配置。

## Kotlin 桥与权限

- `JavascriptInterface` 运行在 JavaBridge 线程。窗口和 Activity 操作回 UI 主线程；文件复制和其他长任务放到工作线程。通过反射调用的方法保留 `@Keep` 等混淆保护。
- 桥接双方核对方法名、参数和 JSON 形状。轮询协议区分 idle、busy/asking、成功、取消、失败；一个动作有明确所有者，避免旧结果串入新请求。
- 麦克风权限同时考虑 granted、rationale、是否询问过、系统请求是否仍进行中。系统弹窗打开时 `rationale=false` 不能判定永久拒绝；以权限回调确认请求结束。
- 用户同意后若承诺自动开始，应保留启动意图直到本次请求成功、拒绝或明确取消。轮询时限到达不等于用户已作答；回到前台重新检查权限，并防止 resume 与 visibilitychange 重复启动。
- SAF 的 `content://` 是 URI，不是 Rust 文件路径。需要路径的解码器可读取复制后的私有缓存；文件名来自 provider，需处理 basename、冲突和失败残留。导出通过 ContentResolver 写系统选择的目的地。
- Android Keystore 主要存放加密密钥；API token 可用其保护的密钥加密后持久化。桌面 keyring 无 Android 后端不代表可以自动改成明文 settings。实现存储后验证旧明文迁移与清理，核对项目安全承诺。

## 音频与原生生命周期

- AAudio 的默认设备可能是 `-1` 路由 sentinel，未必出现在硬件枚举里。默认设备可打开性与枚举列表成员资格分开判断；用真实采集帧证明可用。
- 系统声音 AudioPlaybackCapture 从 Android 10/API 29 起可用，需要录音权限和每次会话的新 MediaProjection 授权；对目标系统版本核对前台服务类型、权限、授权和启动顺序。
- 授权成功、录音器开始、PCM 到达、有效声音到达是不同状态。受保护媒体、通话或禁止 capture 的应用可能静音；诊断和测试应说明证明了哪一层。
- 在协议边界明确 PCM 采样率、通道、位宽与字节序，并进行重采样/混音。音频时间用实际采样数计算；本机播放需要按平台能力排除自采集。
- 原生服务负责后台采集与 MediaProjection 释放；Rust stop、前台服务结束、投影撤销、录音错误必须收敛到同一会话结束路径。WebView 的定时器可能在后台暂停，不能成为及时释放原生资源的唯一机制。
- 原生悬浮窗分别验证显示权限、前台通知、锁定穿透、拖拽缩放、屏幕旋转和位置持久化。Android 12+ 对不可信 overlay 的触摸穿透有透明度限制；结合当前系统行为验证。
- Android edge-to-edge 下 CSS safe-area 可能为零；必要时用原生 WindowInsets 处理 systemBars、displayCutout 与 IME，验证输入框和固定顶栏仍可操作。

## TLS 与停止语义

- 分目标选择 TLS 后端，并检查 rustls 的根证书与 CryptoProvider 是两件事。启用证书集合不会自动保证有可用加密提供器；按依赖实际选择在初始化时安装 provider。
- 用真实 `wss://` 覆盖成功连接、证书拒绝和握手取消。普通 `ws://` 只能证明协议传输；向明文端点拨 `wss://` 仅证明失败路径，不等于成功 TLS 会话。
- 连接、配置写入、等待 setup ACK、音频上传和收尾读取都要能取消。把“传输已连接”与“服务已准备好接收音频”分开，按协议真实 ACK 开闸。
- 收尾设置绝对截止时间；逐包重置 timeout 会被持续心跳无限延长。读取停止与写任务退出一起验证；丢弃 Tokio JoinHandle 会 detach，必要时使用显式 abort 或持有任务的 JoinSet。
- `spawn_blocking` 中已运行的驱动调用不会因为异步 timeout 自动终止；为工作线程传入停止状态，并在迟到完成时释放资源。新旧会话的事件和结果应按会话标识隔离。
- 错误要关闭采集并留下可查询的状态，避免错误后一个 closed 事件擦掉诊断。UI 区分 connecting、connected、stopping、closed/error，前台恢复可查询原生权威状态。
- 音频 base64 在发诊断 IPC 之前剥离或替换为字节数。只测试剥离辅助函数不够，还要确认真正发出的事件已经脱敏和裁剪。日志与错误避免包含 API Key。

## 按证据完成验证

选择改动涉及的层级并明确缺口：

1. 主机类型检查、Rust 测试和 Clippy：验证共享逻辑，不能代替 Android 目标编译。
2. Android 交叉编译和 Kotlin release 构建：暴露 cfg、JNI 签名、资源及混淆问题。
3. 成品检查：包名、签名、versionName/versionCode、manifest、APK ZIP 对齐及每个 `.so` 的 ELF LOAD 段对齐。16 KB 需要 ZIP 与 ELF 两层都通过。
4. 有 WebView 的模拟器/设备冷启动：触发真实设备枚举、权限、录音和前后台切换；分别核实 4 KB 与 16 KB 环境实际页大小。构建 ARM64 包不等于已在 ARM64 真机运行。
5. 本地可控服务：覆盖 PCM 上传、字幕返回、setup 无 ACK/拒绝、TLS 和停止截止时间。使用计数而非保存 PCM；明确本地服务不证明厂商 API 兼容。
6. 用户硬件或目标厂商设备：记录包的 commit、系统、WebView、页大小和日志，验证厂商音频与后台策略。

UI 冒烟使用新鲜快照，点击前确认目标可见、未被顶栏/键盘遮住，并确认真实输入焦点。服务端测试应独立运行，避免阻塞的 UI 自动化耗尽握手取消时限。保留截图、UI XML、被测应用各次 PID 的 crash 日志；只对已确认的模拟器系统故障作隔离处理。

测试包与正式包保留各自稳定身份；升级需要同包名、同签名且递增的 versionCode。APK 复用要核对全部应用/构建输入相同。下载 Gradle 等构建产物核对官方来源与摘要；网络故障修复不应依赖未验证的替代二进制。

完成时说明实际通过的检查、仍未覆盖的设备或网络路径，以及需要修复的问题。把已修好的历史故障当作经验，把当前发现当作待办，避免把现存缺陷写成推荐模式。
