# dsh-loop-guard

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugin that stops an agent from spinning: it cuts off repeated model output, catches near-duplicate tool calls, and can cap a runaway turn.

Chinese documentation: [README.zh.md](README.zh.md).

## The problem

Long-running agents fail in ways that look the same from the outside — the agent keeps working while making no progress:

| Failure | What it looks like |
| --- | --- |
| Output degeneration | The model repeats the same phrase until it hits the response limit. More likely as the context grows. |
| Tool spinning | The same tool keeps running against the same target with slightly different arguments: a file re-read at new offsets, the same command retried, an A→B→A→B cycle. |
| Runaway turn | Steps, minutes or output keep growing with no convergence. |

DSH ships `dsh-repeat-tool-reminder`, which detects only **exactly identical** tool calls, and only advises the model. `dsh-loop-guard` covers the rest.

## How it works

Only documented DSH extension seams are used; the agent loop itself is untouched.

| Seam | Use |
| --- | --- |
| `llm/stream` (waterfall) | Wraps the chunk stream, detects repetition live, ends the attempt with a terminal error chunk |
| `agent/request-error` (waterfall) | Owns recovery for the guard's own failure codes — re-runs the step, bounded |
| `agent/pre-step` (waterfall) | Tracks turn boundaries |
| `tools/post-execute` (waterfall) | Tracks near-duplicate tool chains, injects a model-visible notice, cancels past the hard threshold |

Two independent detectors scan a rolling window of streamed text:

- a **periodic detector** — a unit of any length repeated to the end of the window (catches one short sentence repeated forever);
- a **rolling-hash shingle detector** — one 64-character slice covering most of the window (catches a repeated paragraph, including repeats that do not reach the tail).

Tool-call arguments are never counted as model output: writing a file or running a long command is real work, not degeneration.

## Install

Both paths need the profile name you run DSH with (for example `web`).

**Bundle install (recommended).** From a git URL, tarball or local checkout:

```bash
dsh plugin --profile <profile> add github:LISparrowC1/dsh-loop-guard
```

DSH adds the package to the profile and applies its `cordis.patch.yml`, which inserts the loader entry.

**Manual install.** Copy this package into `$DSH_HOME/profiles/<profile>/node_modules/dsh-loop-guard/`, then append to `$DSH_HOME/profiles/<profile>/cordis.patch.yml`:

```yaml
- insert:
    - id: loop-guard
      name: 'dsh-loop-guard'
```

Use one path or the other — two entries would mount the plugin twice. The manual copy is not recorded in the profile's lockfile, so a later `pnpm install` in that profile may remove it.

Profile patches are read when DSH starts, so restart DSH after installing.

## Configuration

The entry accepts an optional `config` block. Every field falls back to the defaults below.

```yaml
- insert:
    - id: loop-guard
      name: 'dsh-loop-guard'
      config:
        enabled: true
        dryRun: false            # true = detect and log, never enforce
        logEvents: true          # append decisions to $DSH_HOME/loop-guard/events.jsonl
        locale: en               # en | zh — language of the messages shown to people
        repetition:
          enabled: true
          includeReasoning: true    # reasoning streams cost tokens too
          maxRetries: 1             # automatic re-runs of one cut step
          minUnitChars: 6           # shortest unit considered by the periodic detector
          minRepeats: 8             # consecutive repetitions required
          minSpanChars: 400         # minimum repeated span, keeps prose out
          windowChars: 4096         # rolling detection window
          minShingleOccurrences: 4  # occurrences of one 64-char slice
          minShingleCoverage: 0.5   # share of the window one slice must cover
        toolLoop:
          enabled: true
          fuzzyAdvisoryAt: 5        # near-duplicate count that warns the model
          hardStopAt: 12            # near-duplicate count that cancels the turn
          cycleAdvisoryAt: 3        # A→B→A cycle repeats that warn
          exclude: ['todo_write', 'job_output']
          argumentsPreviewChars: 240
        brake:
          enabled: true
          maxStepsPerTurn: 60           # 0 disables
          maxTurnMinutes: 30            # 0 disables
          maxCallsPerHour: 240          # process-wide; 0 disables
          maxOutputCharsPerTurn: 200000 # model-written text only; 0 disables
```

`locale` only affects the strings a person reads: the error that ends a turn, the guard's notices in the transcript, and the `reason` field of logged events. Text sent to the model is always English, so model behaviour does not depend on the configured language.

The defaults are deliberately conservative: a repetition hit requires most of the window to be the same text, so ordinary long answers, tables and code are not touched.

### Live overrides

The profile patch is read at startup. For changes that must apply immediately, write `$DSH_HOME/loop-guard/config.json`; it is merged over the patch config and picked up by the next model call, with no restart:

```json
{ "dryRun": true, "brake": { "enabled": false } }
```

Top-level keys are `enabled`, `dryRun`, `locale`, `repetition`, `toolLoop` and `brake`; the three sections merge field by field. Delete the file to return to the patch configuration. Changes are logged as `overrides-applied`, `overrides-absent` and `overrides-invalid`.

## What you will see

- **Cut and retry** — a repeating response stops within a few hundred characters and the step is re-run automatically.
- **Retry exhausted** — the turn ends with an error naming the repeated snippet and the retry count. Send the request again.
- **Tool spinning** — a `Near-duplicate tool calls detected` notice appears in the transcript, and at the hard threshold the turn is cancelled.
- **Event log** — `$DSH_HOME/loop-guard/events.jsonl`, one JSON object per line. `kind` values include `plugin-loaded`, `repetition`, `repetition-retry`, `repetition-stop`, `budget-refused`, `budget-output`, `tool-advisory`, `tool-stop`, `overrides-applied`, `overrides-absent`, `overrides-invalid`. The file is append-only and grows; delete it when you no longer need the history.

## Tuning

If a normal answer is ever cut:

1. Read the `reason` field of the `repetition` event — it quotes the text that was judged repetitive.
2. Write `{"dryRun": true}` to the override file to observe without enforcing.
3. Raise `minRepeats` / `minSpanChars` / `minShingleCoverage`, or set `{"repetition": {"enabled": false}}`.

If the spend brakes interrupt legitimate work, disable them with `{"brake": {"enabled": false}}` — the two loop guards keep working.

## Disable and uninstall

- Temporarily off, immediately: `$DSH_HOME/loop-guard/config.json` → `{"enabled": false}`.
- Off after a restart: `enabled: false` in the entry config.
- Disabled: remove the `loop-guard` entry from the profile's `cordis.patch.yml`.
- Uninstalled: reverse the install (remove the dependency or the `node_modules` copy, then the entry).

## Development

```bash
node --test     # 22 tests: detectors, stream wrapping, retry budget, budget accounting, tool chains, dry run, live overrides, locales
```

The code is in four layers: `lib/detector.js` (pure repetition detection), `lib/messages.js` (every human-facing string, per locale), `lib/guard.js` (decisions and listeners, no cordis imports), and `lib/index.js` (cordis wiring, config schema, override-file reader).

## License

MIT — see [LICENSE](LICENSE).
