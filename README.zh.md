# dsh-loop-guard

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）插件：在 Agent 开始"原地打转"时把它拉回来——切断重复刷屏的模型输出、识别近似重复的工具调用、可选地给失控的一轮设上限。

英文文档：[README.md](README.md)。

## 要解决的问题

长时间运行的 Agent 会以三种从外部看起来一样的方式失败——它还在干活，但其实没有进展：

| 失败形态 | 表现 |
| --- | --- |
| 输出退化 | 模型把同一句话反复输出直到撞上长度上限。上下文越长越容易发生。 |
| 工具打转 | 同一个工具反复作用于同一个目标，只是参数略有变化：同一文件换 offset 反复读、同一条命令反复跑、A→B→A→B 循环。 |
| 失控的一轮 | 步数、时长或输出量持续增长却没有收敛。 |

DSH 自带 `dsh-repeat-tool-reminder`，但它只识别**参数完全相同**的工具调用，而且只是提醒模型。`dsh-loop-guard` 补的是它够不着的那几格。

## 工作原理

只挂载 DSH 公开的扩展接缝，不改动 agent 循环本身。

| 接缝 | 用途 |
| --- | --- |
| `llm/stream`（瀑布） | 包装分片流、实时检测重复、用一个终止错误分片结束这次尝试 |
| `agent/request-error`（瀑布） | 接管本插件自己失败码的恢复——重跑该步，且有次数上限 |
| `agent/pre-step`（瀑布） | 跟踪轮次边界 |
| `tools/post-execute`（瀑布） | 跟踪近似重复的工具链、注入模型可见的提醒、超过硬阈值时取消本轮 |

两个独立检测器扫描滚动窗口内的流式文本：

- **周期检测**：任意长度的单元一直重复到窗口末尾（能抓到一句短话无限重复）；
- **滚动哈希分片检测**：某个 64 字片段覆盖了窗口的大部分（能抓到成段重复，包括没有顶到末尾的重复）。

工具调用参数永不计入"模型输出"：写大文件、跑长命令是真实工作，不是退化。

## 安装

两种方式都需要你运行 DSH 时用的 profile 名（例如 `web`）。

**按 bundle 安装（推荐）**，可从 git 地址、tarball 或本地目录安装：

```bash
dsh plugin --profile <profile> add github:LISparrowC1/dsh-loop-guard
```

DSH 会把包加入该 profile，并应用包内的 `cordis.patch.yml`（由它插入 loader entry）。

**手动安装**：把本包复制到 `$DSH_HOME/profiles/<profile>/node_modules/dsh-loop-guard/`，然后在 `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 追加：

```yaml
- insert:
    - id: loop-guard
      name: 'dsh-loop-guard'
```

两种方式**只能选一种**——两个 entry 会把插件挂载两次。手动复制不会写进该 profile 的 lockfile，之后在该 profile 跑 `pnpm install` 可能把它删掉。

profile 补丁在 DSH 启动时读取，所以安装后要重启一次 DSH。

## 配置

entry 支持可选的 `config` 段，未写的字段一律用下面的默认值。

```yaml
- insert:
    - id: loop-guard
      name: 'dsh-loop-guard'
      config:
        enabled: true
        dryRun: false            # true = 只检测和记录，从不执行动作
        logEvents: true          # 把决策追加到 $DSH_HOME/loop-guard/events.jsonl
        locale: zh               # en | zh，给人看的文案语言；默认 en
        repetition:
          enabled: true
          includeReasoning: true    # 推理流同样消耗 token
          maxRetries: 1             # 被切断的那一步自动重跑次数
          minUnitChars: 6           # 周期检测考虑的最短单元
          minRepeats: 8             # 需要的连续重复次数
          minSpanChars: 400         # 重复内容的最小跨度，用来挡掉正常行文
          windowChars: 4096         # 滚动检测窗口
          minShingleOccurrences: 4  # 同一 64 字片段的最少出现次数
          minShingleCoverage: 0.5   # 该片段至少覆盖窗口的比例
        toolLoop:
          enabled: true
          fuzzyAdvisoryAt: 5        # 近似重复第几次提醒模型
          hardStopAt: 12            # 近似重复第几次取消本轮
          cycleAdvisoryAt: 3        # A→B→A 循环重复几轮时提醒
          exclude: ['todo_write', 'job_output']
          argumentsPreviewChars: 240
        brake:
          enabled: true
          maxStepsPerTurn: 60           # 0 = 不限
          maxTurnMinutes: 30            # 0 = 不限
          maxCallsPerHour: 240          # 进程级计数；0 = 不限
          maxOutputCharsPerTurn: 200000 # 只算模型写的文字；0 = 不限
```

`locale` 只影响**给人看**的文字：结束本轮的错误、对话里守卫的提示、以及事件日志的 `reason` 字段。发给模型的文字始终是英文，模型行为不随语言设置变化。

默认值刻意保守：判定重复要求窗口里大部分内容都是同一段文字，所以正常的长回答、表格、代码都不会被误判。

### 实时覆盖

profile 补丁只在启动时读取。需要立刻生效的改动写 `$DSH_HOME/loop-guard/config.json`——它会覆盖在补丁配置之上，下一次模型调用就用新值，不用重启：

```json
{ "dryRun": true, "brake": { "enabled": false } }
```

顶层键是 `enabled`、`dryRun`、`locale`、`repetition`、`toolLoop`、`brake`；后三段按字段合并。删除该文件即回到补丁配置。变化会记为 `overrides-applied`、`overrides-absent`、`overrides-invalid`。

## 你会看到什么

- **切断并重试**：刷屏的回答会在几百字内停住，然后这一步自动重跑。
- **重试用尽**：本轮以一条错误结束，写明被判重复的片段和重试次数。重新发送要求即可。
- **工具打转**：对话里出现一条 `Near-duplicate tool calls detected` 提示；到达硬阈值时本轮被取消。
- **事件日志**：`$DSH_HOME/loop-guard/events.jsonl`，每行一个 JSON。`kind` 取值包括 `plugin-loaded`、`repetition`、`repetition-retry`、`repetition-stop`、`budget-refused`、`budget-output`、`tool-advisory`、`tool-stop`、`overrides-applied`、`overrides-absent`、`overrides-invalid`。文件只追加、会持续增长，不需要历史时自行删除。

## 调优

如果正常回答被误切：

1. 看 `repetition` 事件里的 `reason` 字段——它会引用被判为重复的原文。
2. 往覆盖文件写 `{"dryRun": true}`，只观察不动作。
3. 调高 `minRepeats` / `minSpanChars` / `minShingleCoverage`，或写 `{"repetition": {"enabled": false}}`。

如果花费熔断挡住了正常工作，用 `{"brake": {"enabled": false}}` 关掉它——两个循环守卫照常工作。

## 停用与卸载

- 立刻全关：`$DSH_HOME/loop-guard/config.json` 写 `{"enabled": false}`。
- 重启后关闭：entry 配置里 `enabled: false`。
- 停用：删掉 profile `cordis.patch.yml` 里的 `loop-guard` entry。
- 卸载：反向执行安装（删除依赖或 `node_modules` 副本，再删 entry）。

## 开发

```bash
node --test     # 22 个用例：检测算法、流包装、重试预算、花费口径、工具链、dryRun、实时覆盖、语言
```

代码分四层：`lib/detector.js`（纯重复检测）、`lib/messages.js`（按语言组织的全部人读文案）、`lib/guard.js`（决策与监听器，不依赖 cordis）、`lib/index.js`（cordis 接线、配置 schema、覆盖文件读取）。

## 许可证

MIT，见 [LICENSE](LICENSE)。
