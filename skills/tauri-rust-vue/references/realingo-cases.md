# ReaLingo 实例：症状、修复与适用条件

案例来自 [noSugarK/ReaLingo](https://github.com/noSugarK/ReaLingo)，截至 2026-11-09 发布的 `v0.8.0`。可在原仓库用 `git show SHA` 核对。路径用于在案例仓库定位，不要求使用技能的项目有这些文件。

## 开发与运行

| 症状 | 实际原因和解决方向 | 案例依据 |
| --- | --- | --- |
| Android 初始化能编译，首次列设备原生 abort | 消费 AAudio 的共享 NDK context 尚未初始化；案例升级 Tauri/Tao 并验证真实冷启动 | `17b7be4`；`src-tauri/Cargo.lock` |
| `-laaudio` 找不到，改 Gradle 仍失败 | Rust linker API 与 manifest 是两处约束；Tauri minSdk 配置需影响真实 linker | `9e83fa2`, `9546bfe` |
| Android 主页面被另一个窗口盖住 | 桌面字幕窗口创建了额外 Activity；Android 平台配置仅声明 main | `664d7a0`, `8c904d8` |
| ws 本地测试正常，首个 wss 会话 panic | rustls 有根证书但没有 CryptoProvider；明确初始化并测试可信 TLS、拒绝和取消 | `7f3aa2c`, `7893b49` |
| 系统弹窗超过 30 秒才同意，应用不继续启动 | 轮询结束丢了用户意图；保留 pendingStart，在前台恢复时查询结果 | `403466c` |
| 长字幕滚不回第一条 | flex 尾部对齐使超长内容从起点负溢出；同时修复列表和全屏容器 | `e535d70`, `896fae1` |
| 诊断事件包含巨大 base64 | 在剥离音频前发送 raw 事件；改为剥离后发送，检查实际 IPC payload | `a67626f` |
| UI 自动化让握手/停止测试超时 | 同步 UI 子进程阻塞本地 peer；服务放独立进程 | `18543d8`, `703ffbb` |
| 改为图标后两个模拟器都说找不到许可证 | 新的 `aria-label` 与导航约定不匹配；按钮使用清晰的 title 作为可访问名称，显示仍为图标 | `9581b75`；原失败日志的 `phone UI did not render MIT / License MIT / 许可 MIT` |

## 发布过程中暴露的问题

| 症状 | 处理与防止复发 | 案例依据 |
| --- | --- | --- |
| Windows 应用已编译，但 MSI 阶段失败 | WiX 拒绝 `beta.1` 文字预发布标识。此次最终按用户要求发布数字版 `0.8.0`；没有声称已实现通用 Beta→MSI 映射 | [未发布 Beta 构建](https://github.com/noSugarK/ReaLingo/actions/runs/42557851974)，`b7040aa` |
| Android 脚本拒绝 prerelease，或正式包不能覆盖测试版序列 | 为预发布阶段分配数字槽位并验证单调性；完整版本保留在 versionName | `141621c`；`scripts/prepare-android.mjs` |
| Beta 用户检测不到同版本正式更新 | 数字段解析遇 beta 变 NaN；按 SemVer 处理 prerelease 顺序 | `dd2a858` |
| 附件名看不出系统和架构；Linux 缺 RPM | 按 target 收集并重命名真实安装器，加入 RPM 构建/依赖和下载选择 | `3114dfb` |
| 桌面已上传而 Android 仍未结束，就可能公开 Release | 发布依赖四平台构建，并检查同 SHA 的 main CI 与 Android 测试 | `b7040aa`；`.github/workflows/build.yml` |
| 官网没有 Android 下载，桌面 latest 也没有 APK | 首页/下载页新增 Android UA、APK 类型和安装指南，按渠道选择实际资产 | `0874291`，`b7040aa` |

## 已验证到哪一层

`v0.8.0` 的[全平台构建与公开发布](https://github.com/noSugarK/ReaLingo/actions/runs/42559402548)、[main CI](https://github.com/noSugarK/ReaLingo/actions/runs/42559374377)和 [Android API35/4KB、API36/16KB 冒烟](https://github.com/noSugarK/ReaLingo/actions/runs/42559374379)均成功。发布包含 Windows EXE/MSI、macOS universal DMG、Linux DEB/RPM、Android arm64 APK。

这些结果不证明所有厂商 ARM64 真机、每种 RPM 发行版或厂商线上 API 都完成了实测。Android 在该版本仍用应用私有 `settings.json` 明文保存 API Key；它是应披露的现状，不是推荐的安全存储方案。

最初 `0cf81f9` 审查中的 raw 事件、长授权等待和长列表问题已在上述提交修复。复用案例时先确定所查版本，避免把旧风险重复报告为当前缺陷。
