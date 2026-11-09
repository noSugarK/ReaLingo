# 验证、版本与发布

## 按边界挑验证

先读取仓库脚本和 CI，使用其实际命令。下面是有这些脚本的项目示例，不要求给别的项目新建同名测试：

```bash
npm test
npm run build
cargo test --locked --manifest-path src-tauri/Cargo.toml
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

主机检查通过后，针对本次平台变化做目标构建和关键路径运行。原生改动检查 release 构建，因为 Kotlin/Swift 编译、混淆、资源、签名和打包阶段都可能不被 dev 覆盖。纯文案或低影响 UI 修改不要求机械重跑所有平台。

| 证据 | 能证明 | 仍不能证明 |
| --- | --- | --- |
| Vue 类型检查、浏览器预览 | 前端类型、布局、交互 | 原生插件、设备枚举、系统授权 |
| Rust 主机测试/Clippy | 当前主机编译和共享逻辑 | Android cfg、JNI 或其他 OS 后端 |
| 目标 release 构建 | 目标链接、原生源码、资源/混淆 | 成品可启动、能录音或联网 |
| 成品检查与安装 | 包名、签名、版本、架构/对齐 | 功能路径已经跑通 |
| 模拟器/设备会话 | 所测系统、架构和场景 | 未测厂商策略、未测架构、厂商线上 API |

Android 16 KB 兼容要同时检查 APK ZIP 对齐和每个原生库的 ELF LOAD 段。模拟器实际页大小用 `adb shell getconf PAGE_SIZE` 确认；同时记录 API、WebView、架构。构建 ARM64 APK 再在 x86_64 模拟器跑另一份 APK，不能报告为 ARM64 真机验证。

## 冒烟与故障归因

安装/清数据前明确目标包和数据影响；`pm clear` 只用于获准的模拟器/可丢弃测试安装。两次冷启动触发真实初始化，再验证本次变更涉及的权限、资源、后台返回和停止路径。

保留截图、UI XML、版本、包名、实际 PID 和 crash 日志。原生 Activity 出现不代表 WebView 已渲染。无障碍选择器随真实标签更新；等待状态后再点击，检查控件可见、未被键盘/顶栏遮挡且焦点在目标编辑器。

区分应用 crash/ANR、UiAutomation 崩溃、系统 Launcher ANR 和缺 WebView 的镜像。仅对已确认的系统故障做窄范围恢复；应用异常仍失败。恢复之后重跑原场景，不能把所有超时都忽略。

测试握手/停止等时限时，本地协议服务保持可响应。同步 UI 自动化可能阻塞 Node 事件循环，应把 peer 放独立进程。使用本地可控服务验证传输、PCM、setup ACK/拒绝和取消；厂商 API 兼容仍需另有证据。

## 可升级的版本与身份

- 一个权威应用版本源，必要的派生字段由构建脚本生成。tag、应用报告版本、系统包版本和下载名一致；从最终 APK/MSI/应用 bundle 读取验证，而不是只看界面标签。
- Android 升级要求包名、签名身份一致且 versionCode 递增。测试包用独立稳定身份；不能指望临时 debug key 覆盖旧生产包。Keystore、密码和别名只走受控秘密配置，错误时在长构建前失败。
- 为 Android 预发布序列预留有序数字空间，确保 alpha → beta → rc → stable 和后续版本递增且不溢出。公式由项目选择；例如 ReaLingo 的 stable 槽位为 999，不能把这一公式当作 Android 平台标准。
- 版本比较处理 SemVer prerelease 与数字段。简单 `split('.').map(Number)` 遇 `beta` 会产生 NaN，可能使 Beta 用户收不到同基础版本的正式更新。用边界例覆盖 beta.2/beta.10/stable。
- Windows MSI 需要自己的数字版本映射。应用保留 `0.8.0-beta.1` 不代表 WiX 接受它；核对当前 Tauri 的 `bundle.windows.wix.version` 与实际升级规则。

## 构建与公开发布分开

用户授权发版后，先确定版本、目标包和说明，再执行。已有授权覆盖的普通重试继续推进；遇到会丢失数据、变更发布身份或重写已公开历史的修复，重新核对授权范围。

保留现有 CI 设计；若跨平台附件会分批上传，草稿可避免半套包先公开。等待用户要求的构建和测试运行结束，检查**同一提交**的结果。引用旧提交的绿色结果、仅触发 workflow、看到 artifact 名称都不等于此次发布通过。

ReaLingo 的 gate 查找同一 SHA 的 main CI 和 Android 测试，所以先推 main，再推 tag；这不是所有仓库的通用 Git 发布顺序。若缺少该 SHA 的运行，应触发正确检查或修复流程，不能移除 gate 伪装成功。

公开后核对 release 的 draft/prerelease/Latest 状态、每个平台附件、文件名、大小与实际可下载性。正式版标记和预发布渠道遵循用户选择；构建失败时保留可诊断草稿或遵循项目回滚约定，不宣称发布完成。

## 下载资产和网站

收集最终安装器到单独目录，再统一命名为含版本、系统、架构和格式的文件名；复制不改变已签名文件字节。Windows EXE/MSI、macOS universal DMG、Linux DEB/RPM、Android APK 分别列清楚；某格式缺失时报错，避免上传同名文件覆盖另一架构或语言。

GitHub `/releases/latest` 排除 prerelease。稳定版尚无 APK 而测试版有 APK 时，下载页需按平台和渠道选取真实资产，明确预发布标签；不能给 Android 用户链接一个根本不含 APK 的旧稳定版。

官网同时更新系统识别、资产后缀、安装步骤、平台功能表和中英文文案。Android UA 往往含 Linux，先识别 Android。API 失败时提供可用的 Release/下载页回退，不拼版本不明的 `/latest/download/固定文件名`。

API Key 存储、最低系统版本和测试覆盖按实际实现描述。网站是公开用户文档，不能把桌面凭据库承诺套在 Android 明文配置回退上。
