# 编码规范

ReaLingo 的写法约定。这里记下的是仓库已经在遵守、评审时会照着查的规则；
没写到的地方，照周围代码的样子写。

## 提交前必须通过

```bash
npx vue-tsc --noEmit                      # 前端类型检查
cd src-tauri && cargo clippy --all-targets   # 没有警告
cd src-tauri && cargo test --lib
```

仓库**不跑 `cargo fmt`**：现有代码的行宽在 120 左右，整体重排只会制造无意义的 diff。
新代码跟着所在文件的排版走。

## 每个接口的差异只放一处

接口（`Protocol`）之间的不同是这个项目最容易散开的地方，所以有硬规定：

- **Rust**：按接口分支的逻辑只写在 `src-tauri/src/config.rs` 的 `Settings` 方法里
  （采样率、握手、发什么帧、怎样算准备好 / 结束、二进制帧怎么解）。
  `realtime.rs` 只调用这些方法，**不出现 `Protocol::Xxx` 判断**。
  某个接口自己的线上格式（如豆包的 Protobuf）放进它自己的模块（`volc.rs`），由 `config.rs` 调用。
- **前端**：界面上按接口的取舍只来自 `src/languages.ts` 的 `PROTOCOLS` 表
  （语言、朗读、音色、源语言模式、互译、语言对限制……）。
  组件和其他函数里**不写 `protocol === "xxx"`**，要新的区别就给 `PROTOCOLS` 加字段。
- 加一个接口时，应该只需要：`config.rs` 里补各方法的分支、`PROTOCOLS` / `PRESETS` 加一行、
  `secret.rs` 加钥匙串位置、设置页加选项和 Key 链接、i18n 加文案。超出这些就说明有逻辑放错了地方。

## 线上数据

- 所有服务端帧在进入 `TextStream` 之前都是 JSON，并且用 **`type` 字段**表示事件名。
  不是 JSON 的协议（豆包）在解码时转成这种形状，后面的处理不再区分接口。
- 事件字段、取值以**真实服务返回的报文**为准：先用 `examples/probe.rs` 打真实端点看原始帧，
  再写解析；单元测试里的帧照抄实测报文。文档和实测不一致时以实测为准，并在注释里写明。
- 时间一律是"在输入音频里的毫秒数"，起止成对出现时用 `Span` 类型，不拆成散字段。

## 设置与密钥

- 新设置字段：Rust 侧加 `#[serde(default)]`，前端在 `store.ts` 的默认值里补上。
  旧设置文件必须能照常打开；迁移写在 `initSettings`，**保留用户已经做过的选择**，
  没选过的才用新默认。
- API Key 只进系统凭据库（`secret.rs`），每家一个位置；不写进 `settings.json`，
  也不出现在设置页显示的地址里。
- 历史记录（JSONL）新增字段只能是可选的，旧文件照旧能读、能导出。

## 注释

- 代码注释用英文，说**为什么**，不复述代码在做什么。实测得出的结论（"seen live"、哪个版本
  的服务这样表现）要写进注释，后来的人才知道不能随手改。
- 有意走的捷径用 `ponytail:` 注释标出：写清楚上限在哪、什么情况下该升级、怎么升级。

## 测试

- Rust 单元测试写在同一文件的 `#[cfg(test)] mod tests` 里，测试名用一句话描述行为
  （`openai_streams_are_cut_into_turns_at_sentence_ends`）。
- 有分支的解析、配对、时间计算都要有测试；协议相关的测试用实测帧。
- 前端没有测试框架。前端里有分支的纯计算（如 SRT 时间轴）改动后，至少用 node 跑一遍边界情况再提交。

## 界面文案

- 每条界面文字都同时写进 `src/i18n.ts` 的中文和英文两份。
- README 有中英两份（`README.md` / `README.en.md`），改一份就同步另一份。
- 项目主页 `docs/index.html` 由 GitHub Pages 从 `main` 直接发布，
  只描述**已经发布**的版本里有的功能；新功能的主页改动随发版一起提交。

## 依赖

- 能用标准库或已有依赖解决的不加新依赖。
- 不引入需要额外系统工具才能构建的依赖（例如 Protobuf 用 `prost` 派生手写消息，不用 `prost-build` + `protoc`）。

## 版本与发布

- 版本号只有 `src-tauri/Cargo.toml` 一处；发布说明写在 `.github/release-notes/v<版本>.md`。
  发布流程见 README「开发」一节。

## 提交

- 提交信息用中文 conventional commit：`type: 描述`（`feat` / `fix` / `docs` / `chore(release)` 等），
  正文写为什么这样改。
- **按功能分开提交**，一个提交只做一件事；一个文件混了几件事就按代码段拆开。
- 仓库文本文件统一 LF 行尾。
