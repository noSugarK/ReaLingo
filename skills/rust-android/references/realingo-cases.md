# ReaLingo Android 移植案例

证据范围：`main` (`fb0ce7e`) 到 `feat/android` (`0cf81f9`)，71 个提交；审查日期 2026-11-09。下列 SHA 只用于本仓库历史查询，移植到其他项目时先核对依赖版本。

在 ReaLingo 仓库运行 `git show <SHA>` 查看修复和原始解释。项目实现及验证说明见 `development/android-testing.md`（审查时原路径为 `docs/android-testing.md`）。提交说明是历史证据，不能代替对当前代码和平台事实的核实。

| 故障或风险 | 本次经验 | 提交依据 |
| --- | --- | --- |
| 通用依赖把桌面平台后端带入 Android | 按目标分 TLS、keyring 与平台功能；检查 feature 合并 | `aff32f3`, `14828a7` |
| 使用不存在的 cpal feature，Cargo 解析失败 | cpal 0.17 自动选择 AAudio，核对版本真实 feature | `a658207` |
| `-laaudio` 链接失败，改 Gradle 无效 | Tauri minSdk 配置影响 Rust linker API；同时核对 manifest | `9e83fa2`, `9546bfe` |
| 模板补丁不命中，或最终写回覆盖前面的补丁 | 保留渲染证据、验证最终状态、幂等重复运行 | `b0968b0`, `9c6fd05`, `3460f07` |
| 安卓调用桌面窗口 API 编译失败 | 在编译边界隔离桌面能力 | `b6142ef` |
| 手写 Rust JNI 实验反复出现 API、所有权和生命周期编译错误 | 根据真实 crate API 编译验证；Activity 功能最终收敛到 Kotlin 桥 | `20dd2b4`, `4162046`, `db32cda` |
| 桌面字幕窗变为第二个移动 Activity，挡住主界面 | 平台配置只声明 main，避免启动后补救 | `664d7a0`, `316b173`, `8c904d8` |
| 首次 `list_devices` 原生 abort | cpal 查询前必须有共享 NDK context；本项目升级 Tauri 2.12/Tao 0.37 | `17b7be4` |
| Rust runtime 与前端 API 版本漂移 | 检查兼容版本及锁文件，做真实启动 | `720e26d` |
| 顶栏、键盘遮挡 WebView | 原生 WindowInsets 与实际点击位置一起验证 | `e0248bd`, `21191d5` |
| 默认麦克风不在枚举列表，被误判为不存在 | 先检查 AAudio 默认路由 sentinel，再看枚举 | `d1ca84b` |
| 授权框未完成就被判定永久拒绝 | 显式 requesting 状态及权限结果回调 | `8c904d8` |
| 系统音频和字幕需要在其他应用上运行 | MediaProjection + AudioRecord + 前台服务；overlay 单独授权 | `b82ee0e`, `eb65099` |
| 原生字幕宽度和 UI 配置相互覆盖 | 核对拖拽结果与百分比设置的同步和持久化 | `e8ab024` |
| 无法判断正在连接还是根本没上传 | 查询会话健康、阶段、上传采样时长及最后错误 | `1b63012`, `d4b4c76` |
| 停止挂起于握手、ACK 或持续心跳 | 取消覆盖每个等待点；收尾用绝对截止时间 | `14ce9d2` |
| ws 测试通过，正式 wss 首次连接 panic | 显式安装 rustls CryptoProvider，真实 TLS 成功/失败/取消测试 | `7f3aa2c`, `7893b49` |
| 丢弃上传 JoinHandle，异常退出留下后台任务 | JoinSet 随外层退出 abort 子任务 | `7f3aa2c` |
| 自动化 UI 操作阻塞本地服务或吃掉测试时限 | 服务独立进程；复用当前 connecting 快照执行取消 | `18543d8`, `703ffbb` |
| APK 装了但启动失败，CI 把系统故障归到应用 | 保留原始异常，按每次启动 PID 筛选崩溃 | `be4a74e`, `b84eaad` |
| 旧系统镜像缺 WebView，16 KB 预览镜像自身崩溃 | 区分镜像问题；本分支最终用 API35/4KB 与 API36/16KB | `be4a74e`, `b41a74a` |
| UiAutomator 读到旧状态、错误输入框或无效坐标 | 新鲜快照、焦点和可见边界检查、等待 IME/桌面稳定 | `35f4197`, `9c10166`, `08909dd` |
| 模拟器 Launcher ANR 干扰 overlay 手势 | 留存证据，只识别系统 Launcher 故障，应用 ANR 仍失败 | `0cf81f9` |
| 临时签名无法升级，模板版本阻断安装 | 稳定密钥与包名，验证最终 APK 的 versionCode 与签名 | `eb65099` |
| Gradle 下载/插件仓库持续失败 | 官方资产摘要校验，区分 pluginManagement 与普通 repositories | `b0ef5d6`, `291ff09`, `62f0a31`, `1d58796` |

## 初始审查与后续修复

以下区分 `0cf81f9` 审查结论和随后发布的 `v0.8.0`，不把旧风险当作当前缺陷：

| 初始发现 | 截至 v0.8.0 的状态 |
| --- | --- |
| Android 无凭据库，API Key 明文写 settings | 仍存在；文档明确披露应用私有目录中的明文回退。安全持久化和迁移仍需实现，不作为推荐模式 |
| raw 事件先于音频裁剪发送，base64 经过 IPC | `a67626f` 已改为裁剪后发送；验证仍应检查实际诊断 payload |
| 轮询 30 秒结束丢失自动启动意图 | `403466c` 保留 pendingStart，让稍后同意可继续启动 |
| 尾部对齐可能让长字幕无法回到第一条 | `e535d70`、`896fae1` 修复列表和全屏字幕的滚动起点 |

## 验证证据的边界

本次主机验证通过 Node 66 项、Python 7 项、Rust 60 项（1 项硬件测试按原设置跳过）、vue-tsc、Vite 构建、Clippy。主机为 Windows，未重新构建/安装 APK，也未运行远端 CI 或厂商真机。测试文档中的“workflow 会检查”只描述检查设计，不能报告成此次设备验证通过。

上述数字是初始审查记录。后续 `v0.8.0` 的 [main CI](https://github.com/noSugarK/ReaLingo/actions/runs/42559374377)、[API35/4KB 与 API36/16KB 冒烟](https://github.com/noSugarK/ReaLingo/actions/runs/42559374379)和[四平台发布构建](https://github.com/noSugarK/ReaLingo/actions/runs/42559402548)均成功；ARM64 包构建不等于所有厂商真机已验证。
