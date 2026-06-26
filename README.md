# OnlyRouter Switch

> 一个桌面 App，让小白用户**零门槛**把 Codex / Claude Code 接到 [OnlyRouter](https://onlyrouter.ai)，一键切换模型，并通过内置本地代理获得**协议翻译、智能路由、安全脱敏**三层能力。

面向**纯小白**：填一个 API Key → 选模型 → 一键配置，终端里 `codex` / `claude` 立刻可用。国内开箱即用，全程免 VPN。

---

## 一、为什么做这个（产品起点）

团队交接先理解动机，再看代码。

**痛点 1 · Codex 接不上国产模型。** Codex CLI/App 只会发 `wire_api=responses` 格式的请求，而 DeepSeek、Kimi 等上游只提供 Chat Completions 接口 → 直接 404。市面方案要装 CC Switch + VS Code 一堆东西，小白搞不定。

**痛点 2 · 配置太难。** 自定义 provider 要手写 `~/.codex/config.toml`、设环境变量、懂 base_url，劝退非技术用户。

**痛点 3 · 裸连大模型不安全、不划算。** prompt 里的密钥/PII 直接发给上游有泄露风险；简单任务用顶配模型烧钱、难任务用便宜模型质量崩。

**我们的解法**：做一个 Electron 桌面 App，把上面三件事全包掉——
1. 用户只面对「填 Key → 选模型 → 一键配置」三步，看不到任何配置文件。
2. App 内置一个常驻**本地代理**（`127.0.0.1`），所有请求经它中转。
3. 代理里塞三层中间件：**协议翻译**（解决 404）、**智能路由**（省钱保质）、**安全网关**（脱敏防泄露）。

一句话：**让 Codex/Claude Code 像接官方一样接 OnlyRouter，且更安全更省钱。**

---

## 二、整体架构

```
┌─────────────┐         ┌──────────────────────────────────────┐        ┌──────────────┐
│ Codex /     │ 请求    │   本地代理网关 (gateway.js)            │ 翻译后  │  OnlyRouter   │
│ Claude Code │ ──────► │   127.0.0.1:8788                      │ ─────► │  上游 API     │
│  (CLI/App)  │ ◄────── │                                       │ ◄───── │              │
└─────────────┘  响应   │  ┌─ 协议翻译  Responses ⇄ Chat       │        └──────────────┘
                        │  ├─ 智能路由  routing.js              │
                        │  ├─ 安全网关  security.js             │
                        │  └─ 自迭代    learning.js             │
                        └──────────────────────────────────────┘
                                       ▲
                        ┌──────────────┴───────────────┐
                        │  Electron 主进程 (main.js)     │
                        │  · 写 ~/.codex/config.toml     │
                        │  · 写 ~/.claude/settings.json  │
                        │  · 托盘驻留 / 开机自启          │
                        │  · 持有 API Key，注入鉴权       │
                        └──────────────┬───────────────┘
                                       │ IPC (preload.js)
                        ┌──────────────┴───────────────┐
                        │  渲染界面 (renderer/index.html)│
                        │  · 填 Key / 选模型 / 一键配置   │
                        └───────────────────────────────┘
```

**核心设计：代理接管鉴权。** App 持有 Key，网关转发时注入 `Authorization`。客户端环境变量只需「存在」即可，换 Key 不必重开终端。

<!-- MODULES -->

---

## 三、代码模块速览

| 文件 | 职责 | 关键点 |
|------|------|--------|
| `main.js` | Electron 主进程 | 启动网关、写工具配置、托盘驻留、开机自启、持有 Key 注入鉴权 |
| `gateway.js` | 本地 HTTP 代理网关（核心） | Responses ⇄ Chat 双向协议翻译、流式事件转换、挂载三层中间件 |
| `routing.js` | 智能路由 + 模态路由 | 难任务硬走前沿模型；简单任务比价；会话内迟滞钉死模型防缓存击穿 |
| `security.js` | 安全网关中间件 | 出站脱敏密钥/PII（可逆占位符）；入站检测投毒（隐藏 Unicode/外泄链接/危险命令） |
| `learning.js` | 智能路由自迭代 | 记录真实路由效果 → 每日聚合权重 → 决策时优选实测更优模型，纯本地 |
| `preload.js` | IPC 桥 | `contextBridge` 暴露主进程能力给渲染层 |
| `renderer/index.html` | 全部 UI | 填 Key / 选模型 / 双开关 / 一键配置 / 内容生成，单文件 |

### 三层中间件的设计取舍（交接重点）

**协议翻译（gateway.js 顶部有契约注释，勿随意改）**
- Codex 无状态：每轮全量重发 `input[]`，网关无需存会话。
- 终止信号唯一 `response.completed` 且必须带 `usage`。
- 流式工具调用按 `index` 累积、流结束一次性 emit（Codex 对 arguments 分片敏感）。

**智能路由（routing.js）**
- 决策顺序固定：① 能力门槛硬判 → ② 简单任务才比价 → ③ 迟滞防横跳。
- 价格全部锚定 `onlyrouter.ai/api/models` 实时标价。

**安全网关（security.js）**
- 编码场景高精度优先：宁可漏掉软 PII 也尽量不误伤代码。
- 占位符用 `__OR_<类>_<hash8>__`，不用拟真假值（假值会让模型误操作且难无歧义还原）。

---

## 四、本地开发

```bash
npm install        # 安装依赖（.npmrc 已配国内镜像，免 VPN）
npm start          # 启动 App（electron .）
```

网关默认监听 `127.0.0.1:8788`（端口被占用自动后移）。开发时改 `gateway.js` 后重启 App 即可。

## 五、打包

```bash
npm run build:mac    # mac universal dmg（在 macOS 上运行）
npm run build:win    # Windows nsis 安装包（需 Wine 或在 Windows 上运行）
npm run build        # mac + win 一起
```

产物在 `dist/`（已 gitignore）。

> ⚠️ **Windows 包不能在裸 Mac 上直接打**：electron-builder 交叉编译 Windows 需要 Wine，而 Wine 依赖 gstreamer-runtime 安装需 sudo。要么装好 Wine，要么在 Windows 机器 / CI 上跑 `build:win`。

## 六、配置写到哪

| 工具 | 配置位置 | 是否需重启 |
|------|---------|-----------|
| Codex | `~/.codex/config.toml`（模型/渠道）+ 环境变量 `ONLYROUTER_API_KEY`（Key） | 仅**首次**创建环境变量需重开终端一次；之后网关接管鉴权，换 Key/模型免重启 |
| Claude Code | `~/.claude/settings.json`（全部，含 Key/BaseURL/Model） | 永不需要，`claude` 每次启动都读该文件 |
| VS Code | `~/.continue/config.yaml`（Continue 扩展，OpenAI 兼容 provider，apiBase 指向本地网关） | 永不需要，Continue 监听文件变更；偶尔需 Reload Window |

用户运行时的 Key 存在 `app.getPath('userData')/config.json`，**不在仓库内**。

> VS Code 走 **Continue** 扩展：它支持配置文件（不像 Cline/Roo 只能扩展内 UI 手填），所以能被一键写入，契合「填 Key → 一键配置」的小白卖点。请求经 `/v1/chat/completions` 进网关的 `handleChat`，享受智能路由 + 安全脱敏 + 流式真透传。

---

## 七、待办 / 已知问题

- [ ] Codex App（GUI）从 Dock 启动不读 `.zshrc`，环境变量方案对 App 可能无效——需实测确认网关接管鉴权后 App 是否还依赖该变量。
- [ ] Windows Codex App 安装包直链未补（`main.js` 的 `DOWNLOADS.codexAppWin`）。
- [ ] 下载源默认指向 OpenAI 官方 CDN（国内需 VPN），上线前替换成国内托管直链。


