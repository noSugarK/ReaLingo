# 共享实现：Vue、Rust 与平台边界

## 让第一条真实路径可用

先用现有依赖和插件完成一个业务动作。新增 command 需要 Rust 的 `#[tauri::command]`、`generate_handler!` 注册、Vue 的 `invoke` 调用，以及返回类型/字段约定一致。Tauri 2 的 `invoke` 来自 `@tauri-apps/api/core`；迁移旧示例时核对路径，而不是混用 v1 的 API。

例如：

```rust
#[derive(serde::Serialize)]
struct ExportReceipt { bytes: usize }

#[tauri::command]
fn export_preview(text: String) -> Result<ExportReceipt, String> {
    if text.is_empty() { return Err("empty export".into()); }
    Ok(ExportReceipt { bytes: text.len() })
}
```

```ts
const receipt = await invoke<{ bytes: number }>("export_preview", { text });
```

这是不写磁盘的边界示例，不是完整导出功能。实际导出还需系统选择器、写入失败和取消处理。Rust 字段是否使用 `serde(rename_all = "camelCase")`、command 参数名如何转换，都跟随项目约定；跨语言边界用同一份真实 payload 验证。

## 双端复用到什么程度

当两种布局已明显不同时，可按以下职责拆分，目录名称不必照抄：

```text
src/core/       协议能力表、设置、会话和纯业务规则
src/shared/     两端确实共用的组件和资产
src/desktop/    桌面布局、窗口和托盘操作
src/mobile/     触控布局、权限入口和原生桥适配
src-tauri/src/ Rust commands、会话、网络及平台模块
```

布局不同不等于业务不同：模型能力、语言限制、导出时间轴和凭据槽位应由同一处决定。新增差异先找已有能力表，避免每个组件都写一次 `protocol === ...` 或平台判断。仅一个小组件需要的平台差异不必拆出整套 shell。

后端可以提供 `{ os, capabilities }`；前端的按钮、来源选择和降级提示使用能力结果。桌面窗口窄屏不应触发 Android 插件。某插件在 npm 中存在，也不等于它实现了移动端后端。

## 会话、事件与重入

- 开始动作先验证输入，再申请资源；成功获得录音器/连接不等于业务 ready。协议要求 ACK 时先收到 ACK 再发送数据。
- 为 UI 定义真实的 `idle / connecting / ready / stopping / closed / error` 或更小的项目状态集；不要用一个 `running` 布尔量掩盖所有中间状态。
- 给任务或会话一个代次标识；事件、轮询和异步回复更新 UI 前核对代次。快速停止后重开时，旧回复不能覆盖新会话。
- 事件通知用于及时刷新，可查询状态用于恢复错过的事件。切后台、重新挂载、权限返回后查询原生权威状态；轮询频率随可见性/活动会话调整。
- 把连接、握手、配置 ACK、上传和 drain 都纳入取消；结束用绝对截止时间，防止持续 ping 延长等待。持有任务句柄并明确退出策略；丢弃 Tokio `JoinHandle` 不会自动停止任务，`spawn_blocking` 已开始的工作也不因外层超时自行结束。
- 注册事件监听时保存 unlisten，组件卸载/会话结束时清理；防止重复订阅导致重复字幕、状态回退或资源泄漏。

高频 PCM、base64 和大日志不宜逐帧穿过 UI IPC。原生/Rust 处理媒体，UI 接收节流后的电平、计数和状态。检查实际发出的诊断事件已经裁剪和脱敏，而不只检查辅助函数的返回值。

## 设置、秘密与文件

新增持久化字段提供 Rust `serde(default)`、前端默认值和旧配置迁移；迁移保留用户明确选择。主题/语言是客户端偏好，不必强迫后端接管。

桌面优先使用可用的系统凭据库。Android 新实现可用 Keystore 保护加密密钥，再用它加密 token；Keystore 并不是任意字符串数据库。已有项目若采用明文回退，应准确披露并在授权范围内处理安全迁移，不借普通 UI 任务悄悄改存储策略。

文件权限和路径分别设计：用户选择的 URI、应用私有缓存和外部导出目的地是不同对象。对来自 WebView 的任意路径、标识和文件名验证归属/规范化规则；系统选择器授权不意味着所有相似字符串都可信。

## UI 验证容易漏的地方

- 图标按钮保留稳定的 `aria-label`、键盘焦点和可点击面积；桌面 tooltip 不能成为手机唯一的含义来源。视觉标签变化后核对设备的无障碍树和现有冒烟选择器。
- 长内容使用能从第一条滚到最新内容的布局；flex 尾部对齐可能把超长列表推到负方向，`overflow-y: auto` 不一定救得回来。用超过一屏的真实数据验证起点和末尾。
- 嵌套 grid/flex 中检查 `min-height: 0`、容器高度和滚动所有者；测试长更新说明、窄屏和键盘出现时的操作区域。
- 浅色、深色和系统主题分别检查 Logo。应用启动器白底图标与界面内透明标记用途不同；“GitHub Logo”是链接入口的标识，不应自动改成应用大图或改写简介。
