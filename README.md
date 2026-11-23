# session-handoff（会话交接单）

DSH 宿主插件：**每轮对话结束自动刷新本会话交接单**，**新开对话时先问一句「按上一份续作还是新任务」**，选续作就自动带上交接单路径并按它的第 9 节开工。

## 它做什么

| 时机 | 行为 |
| --- | --- |
| 每轮 `turn/end` | **先问一句**「本轮对话结束，要生成交接单吗？」——点「生成本轮交接单」才写盘；不答/关掉/直接发下一句都不写，也不影响本轮结束 |
| 新开对话（本会话第一个 step：`turn<=1` 且 `step=1`，子会话除外） | 在**第一个 step** 注入续作提示：先用 `ask_user_question` 问续作/新任务 |
| 用户说「出交接单 / 交接一下」 | 模型调 `handoff` 工具（`action: write`）立即生成，**不询问** |
| `/handoff` 命令 | 手动刷新（不询问）、`/handoff ask`（先问再写）、开关、列出、查看、成本估算 |

**落盘位置**：`D:\DSH\项目\<项目名>\交接\<YYYYMMDD-HHMM>-<任务片段>-交接单.md`
- 文件名里的「任务片段」取自**本轮最后一条用户消息**（去掉 Markdown/口语开头/非法字符，截到 `nameMaxChars` 字）；本轮没有用户消息时退化为工具名。
- **每轮一份、历史保留**：同一轮重复点/重复命令会覆盖同名文件，不同会话同名自动加 `-2`。
- 会话中途切项目目录时，会在新项目目录另建（旧文件留着）。
- `outputDir` 可强制指定目录；cwd 不在 `D:\DSH\项目` 下时落到 `项目\其他\交接`。

## 配置

改 `cordis.patch.yml` 里 `session-handoff` 行的 `config`（或在 profile 层用同 id 覆盖），**改完需重载该行/重启**。

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关（false 时完全不注册监听器） |
| `turnEndEnabled` | `true` | 每轮结束时是否发起询问/生成；false = 只手动 |
| `confirmBeforeWrite` | `true` | **轮末先问再写**；false = 结束即自动写（旧行为） |
| `askDelayMs` | `5000` | 轮末到弹卡之间的等待；这期间你发了新消息就不问了 |
| `askTimeoutMs` | `300000` | 卡片最长停留，超时按「不生成」 |
| `nameMaxChars` | `24` | 文件名里任务片段的最大字符数 |
| `summaryMode` | `llm` | `llm` 用模型润色；`deterministic` 零模型调用（质量略降） |
| `debounceMs` | `1500` | 连发多轮合并成一次生成 |
| `maxDigestChars` | `12000` | 本轮摘要上限 |
| `maxPrevChars` | `6000` | 上一版交接单喂给模型的上限 |
| `timeoutMs` | `120000` | 模型调用超时 |
| `provider` / `model` | `''` | 空=沿用会话已记录路由 → 首个可用路由 |
| `newSessionAsk` | `true` | 新会话是否询问续作 |
| `searchRoots` | `['D:\\DSH\\项目']` | 发现上一份交接单的根目录 |
| `maxAgeDays` | `14` | 超过该天数的交接单不再当作候选 |
| `outputDir` | `''` | 强制输出目录 |
| `minTurnEvents` | `2` | 本轮事件太少则跳过 |

## 命令与工具

```
/handoff                立即生成并回路径（不询问）
/handoff ask            就本轮内容先问一次，答「生成」才写
/handoff status|on|off  状态 / 本会话开关
/handoff list [n]       最近 n 份
/handoff read <路径>     查看某份的表头与正文
/handoff cost [n]       最近 n 轮生成开销（字符数 + token 粗估）
/handoff models         可用模型路由
```

工具：`handoff({ action: write|status|list|cost })`，模型可用它响应「出交接单」（**write 不询问**）。

`/handoff status` 里另有两块诊断：
- `lastAsk`：最近一次轮末询问的 `outcome`（`accepted` / `declined` / `ask-timeout` / `ask-cancelled` / `no-answerer` / `no-agent` / `superseded`）与建议文件名；
- `lastResult.reason`：最近一次生成被跳过的原因。

`/handoff status` 里的 `resume` 字段是**续作提示的诊断**：`startup`（是否见到 `agent/created` 的 `source=startup`）、`createdSource`（实际 source）、`asked`（是否已注入）、`reason`（没注入的原因，如 `no-candidate` / `no-createUserMessage` / `not-new-session:<source>`）。新会话第一轮如果没出现 A/B 询问，先看这四个字段。

## 安装 / 卸载

```powershell
# 安装（profile shim 方式，与 docx-forge 相同）
powershell -ExecutionPolicy Bypass -File D:\DSH\session-handoff\install-session-handoff.ps1

# 卸载（顺序敏感：先摘 bundle/依赖，再删目录）
powershell -ExecutionPolicy Bypass -File D:\DSH\session-handoff\uninstall-session-handoff.ps1
```

也可以直接在 **Plugins → 添加插件** 里选 `D:\DSH\session-handoff` 目录（install_bundle 会登记依赖并做 bundle 选择）。

> **卸载顺序很重要**：先停用插件行、移除 `dsh.profile.bundles` 与 `dependencies` 条目、跑 `pnpm install`，**最后**才删目录。反过来（先删目录留声明）会在启动期组装 profile 时读不到包。

## 坏了会影响正常用吗

- 所有监听器都包了 try/catch，**绝不把异常抛回 DSH**：`agent/created` 抛错会让新会话创建失败、`agent/pre-step` 抛错会让该 step 失败，这是本插件最在意的两条线。
- 通知类事件（`session/event`）本身在 DSH 里就是逐监听器隔离的；写盘失败只记 `warn`。
- 模型调用只在后台队列，带超时与 abort，失败自动回落确定性稿。
- 三级开关：配置 `enabled` → `/handoff off`（本会话）→ 插件行停用（全局）。

## 已知限制

1. 「续作询问」由模型按注入提示调用 `ask_user_question` 完成，依赖模型遵守指令；「轮末询问」是宿主直接调 `ctx.userQuestions.ask`，不经过模型。
2. 轮末询问需要**已连接的 Web 客户端**（卡片走客户端的 user-questions 面板）；headless/TUI 没有该通道时自动降级为「不生成」，只记 `lastResult.reason = no-answerer`。
3. 交接单是**自动稿**：第 3 节的文件清单来自本轮工具参数（已做存在性检查），其余小节不做人工复核。
4. 每轮一份、不覆盖：历史会累积，需要清理就手动删 `交接\` 里的旧文件。
5. 注入的上下文行（`source.kind='session-handoff'`）在 Web 端的渲染样式以实际页面为准。
6. 卸载后旧会话里那几行注入消息仍可正常重开（会话日志只校验 `source.kind` 是非空字符串）。
