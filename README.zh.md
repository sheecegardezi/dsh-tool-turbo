# dsh-tool-turbo

**为 [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) 按轮次自动调节 `reasoning_effort`，缩短工具调用延迟。**

在多步工具链任务中，模型在**每一次工具调用前**都会重新思考——而这个思考过程占据了绝大部分墙钟时间（一个 50 步的 agent 任务可能在工具之间花费数分钟思考）。`dsh-tool-turbo` 观察当前步骤最近的工具调用，向下一次模型请求注入"尽可能低的合理推理档位"；一旦任务变重，再自动升回。

## 工作原理

DeepSeek API 提供三档 `reasoning_effort`（`low` / `high` / `max`，2026-08-13 上线）。dsh 在**每一步**都会通过 `agent/request` waterfall 重新解析请求配置（见 `packages/core/agent-loop/src/agent.ts`——"plugins propose the next request config"）。`dsh-tool-turbo` 接入该 waterfall：

1. **观察**：从会话中读取当前步骤最近的 `tool/call` 记录。
2. **决策**：简单、确定性工具（`write`、`read`、`grep`、`glob`、`bash`、`fs_*` 等）且载荷小 → `low`；混合/重负载 → `high`；超大载荷 → `max`（可选开启）。
3. **注入**：将决策写入该步骤下一次模型调用的 `agent/request` 配置。

长工具链保持"廉价轮次保持廉价"，同时绝不让困难轮次缺少推理。

## 安装

```bash
# 1. 克隆并安装开发依赖（仅用于类型检查与测试）
git clone https://github.com/Electricitysheep/dsh-tool-turbo.git
cd dsh-tool-turbo && npm install

# 2. 注册进你的 dsh profile（以 web 为例，任意 profile 均可）
npm pack
dsh plugin --profile web add /绝对路径/dsh-tool-turbo-0.1.1.tgz
#    或直接指向检出目录：
dsh plugin --profile web add /绝对路径/dsh-tool-turbo

# 3. 重启 dsh web —— bundle 层在启动时加载
dsh web
```

配置项（patch entry 的 `config:` 键）：`enabled`、`allowDowngrade`、`allowUpgrade`、`baseline`；未指定的键回落默认值，部分配置安全。

## 运行时 API 说明

已对照 `@deepseek-ai/dsh-agent` / `dsh-session` `0.1.2-rc.1` 验证：

- `agent/request` 是 waterfall：payload 为 `{ agent, turn, step, signal }`，`next()` 解析 `LlmCallConfig`；返回修改后的副本是调整请求配置的官方途径（`reasoningEffort` 会被转发为线上 `reasoning_effort`）。
- 会话历史通过 `Session.eventAt(seq)` + `Session.seq` 读取——`Session` 类**没有** `.events` 属性。
- 工具耗时来自 `session/event` 事件流（`tool/call` → `tool/result`，按会话 id + `callId` 关联）。运行时不存在 `agent/tool` 事件。

## 验证

- **17 个单元测试**覆盖策略（`decideEffort`）与宿主接线（`apply`）：全新提示不改动请求、简单工具链降至 `low`、升降档双向尊重用户开关（未开 `allowDowngrade` 时绝不低于基线）、单个超大载荷优先于简单占比、遥测按 `tool/call` → `tool/result` 计时。
- `tsc --noEmit` 通过。

## 决策策略（纯函数，可测试）

| 最近的工具调用 | 决策 |
|---|---|
| 无（全新提示） | 不改动请求 |
| 任一单次超大载荷（≥ 3200 字符） | `max` |
| ≥75% 简单工具、小载荷、允许降档 | `low` |
| 混合 / 重工具 | `high`（允许升级时） |
| 其他 / 受开关约束 | 保持用户选择的档位 |

开关（settings 命名空间规划中）：`allowDowngrade`（默认开）、`allowUpgrade`（默认关——`max` 保持保守）、`baseline`（默认 `high`）。

## 路线图

- [x] 决策核心 + waterfall 注入
- [x] 每次工具耗时遥测（host 日志）
- [ ] settings 命名空间（dsh-settings）控制开关
- [ ] 工具耗时在 UI / agent 上下文呈现
- [ ] 多 profile 安装文档（`headless` / `tui`）

## 许可

MIT
