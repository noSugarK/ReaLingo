# 移动集成：Android 原生能力与边界

Android 可直接复用 Rust 业务核心和 Vue 客户端规则；Activity、系统权限、SAF、MediaProjection 和跨应用悬浮窗由原生层实现。以下实现来自 Android；iOS 的检查边界在末尾单列。

## 入口与目标构建

检查库入口是否有 `#[cfg_attr(mobile, tauri::mobile_entry_point)]`，并把桌面专属初始化放在目标边界内。`target_os = "android"` 与 `target_os = "linux"` 不相同；`cfg(desktop)` 等 Tauri 提供的条件也应以当前构建输出为准。

应用配置中按平台声明窗口。桌面第二个字幕 WebView 可能在 Android 产生另一个 Activity；在 setup 里关闭它已经太晚。使用 `tauri.android.conf.json` 选择移动窗口；跨应用字幕是原生 overlay，应用内全屏字幕是 WebView 内布局，两者不能互换。

先运行目标初始化，再用幂等脚本应用项目特有的 Kotlin、manifest 和 Gradle 修改，最后目标编译。生成工程是否纳入版本控制沿用项目选择，不为此重排整个仓库。补丁要检查匹配和最终结果，重复执行不能增加重复权限/仓库/代码块。

minSdk 同时影响 Rust linker 的 Android API 与 manifest。遇到 `-laaudio` 失败时只改 Gradle 不够；查看 Tauri 配置及真实 clang target。ReaLingo 使用的 cpal 0.17 AAudio 要求 API 26，后端按目标选择，没有一个可凭名字假定存在的 `aaudio` feature。

## 原生桥怎样实现

先检查插件在目标端的实际实现；有官方/已有本地插件能完成任务时复用。项目已有 Kotlin bridge 时可以延续，复杂的跨平台新能力再评估本地 Tauri plugin，避免两套桥同时持有同一录音器。

Kotlin/JS/Rust 约定方法名、序列化字段和结果状态。`JavascriptInterface` 调用不在 UI 线程；Activity/Window 操作切主线程，文件复制等阻塞工作放后台。反射入口核对 `@Keep`/混淆规则。桥只挂在可信应用页面，外部页面交给系统浏览器。

结果可通过事件/回调或查询槽返回，但明确 idle、busy、success、cancel、error 和动作归属。若一次只能有一个文件选择请求，新请求不能读取上一次的结果。JNI 入口先检查长度和对象状态；panic 不能越过不可 unwind 的 FFI 边界。

## 权限与生命周期

- 麦克风：同时记录是否请求过、系统是否正在请求和真实权限回调；弹窗打开时 `rationale=false` 不是永久拒绝。用户稍后同意时，保留此次启动意图，并在 resume/visibilitychange 后重新查询，避免重复启动。
- 系统声音：AudioPlaybackCapture 从 API 29 起可用。录音权限、每次 MediaProjection 授权、前台服务类型/通知和新系统的启动次序分别核实。只承诺音频就只读取音频；系统提示“共享屏幕”不表示产品在读取图像。
- 长任务：原生服务持有录音器和投影；Activity 切后台后 WebView 定时器可能暂停。停止、投影撤销、服务终止、录音异常都进入同一清理路径；再次启动用新授权/新资源。
- URI：`content://` 是系统 URI，不是磁盘路径。必须交给只接受路径的 Rust 解码器时复制到受控缓存；导出用 ContentResolver/系统文档选择器，并报告写入失败和取消。
- 窗口：悬浮权限独立于录音权限；锁定穿透、透明度限制、拖拽缩放、旋转和位置持久化分别测试。Android edge-to-edge 的 CSS safe-area 可能为零，需要结合原生 WindowInsets 和 IME 检查实际可点击区域。

## 最容易“编译成功但不能用”的两条路径

**音频初始化**：先枚举设备就可能调用 AAudio/JNI。检查平台初始化方和消费者是否共享同一个 `ndk-context` 依赖实例；真实冷启动覆盖第一次设备查询。默认路由 sentinel 可能合法且不在设备列表中，先询问/尝试系统默认路由，而不是直接判为不存在。

**TLS**：桌面 native-tls 的成功不证明 Android 可用。目标依赖选择 rustls 后，根证书和 CryptoProvider 是两项独立配置；核对 feature 合并和 provider 初始化。用可信测试 CA 的本地 `wss://` 服务分别验证成功、证书拒绝和握手取消。明文 `ws://` 或向明文端口误发 TLS 都不能覆盖成功握手。

看到授权成功时继续核实录音器启动、PCM 帧、非静音输入、实际网络上传和服务端响应。受保护媒体可能静音；每层要有可查询的计数/状态，诊断中不保存原始音频或完整凭据。

需要更深的 JNI、AAudio 或设备故障定位时，可使用当前环境已有的 `rust-android` 技能；本文件本身不依赖该技能已安装。

## iOS 的适用范围

本案例未验证 iOS。若目标含 iOS，先确认 macOS/Xcode、Rust target、签名/entitlement、usage description、插件 Swift 后端和真实设备生命周期；用当前官方平台文档确定构建流程。Android 的 MediaProjection、SAF、overlay 和前台服务方案不能照搬到 iOS，也不能把“移动端支持”写成已验证 iOS。
