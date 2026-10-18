/**
 * Every string this plugin shows to a person, in one place.
 *
 * `en` is the default because the published plugin is English-first; `zh`
 * carries the original Chinese wording for installs that select it. Model-facing
 * text (the tool-call notices) is not translated here: instructions to a model
 * stay in one language so behaviour does not depend on the viewer's locale.
 *
 * @module dsh-loop-guard/messages
 */

/** Locale names this catalog understands. */
export const LOCALES = Object.freeze(['en', 'zh'])

/** Quote one detected unit for display, bounded so a long unit cannot flood a log line. */
function excerpt(unit) {
  return JSON.stringify(unit.length > 40 ? `${unit.slice(0, 40)}…` : unit)
}

const CATALOGS = {
  en: {
    repeatPeriodic: (copies, unit) => `Detected the same text repeated ${copies} times in a row (excerpt: ${excerpt(unit)})`,
    repeatWindow: (percent, unit) => `Detected that ${percent}% of the output is one repeated passage (excerpt: ${excerpt(unit)})`,
    repetitionCut: (reason) => `${reason}. The stream was cut to stop the repeat and the spend.`,
    budgetCalls: (limit) =>
      `This hour has reached the model-call limit (${limit}). Paused to cap spending; continue later or raise loop-guard's maxCallsPerHour.`,
    budgetSteps: (limit) =>
      `This turn has run ${limit} steps without converging. Stopped to cap spending; restate the goal or raise loop-guard's maxStepsPerTurn.`,
    budgetMinutes: (limit) =>
      `This turn has run longer than ${limit} minutes. Stopped to cap spending; send the request again to continue, or raise loop-guard's maxTurnMinutes.`,
    budgetOutput: (limit) =>
      `Model-written output in this turn passed ${limit} characters (tool arguments are not counted). Stopped to cap spending; restate the goal or raise loop-guard's maxOutputCharsPerTurn.`,
    cancelReason: (tool, count) => `loop-guard: ${tool} repeated ${count}× on the same target`,
    noticeStop: (tool, count, target) =>
      `Repeated tool call detected:\n- tool: ${tool}\n- consecutive_calls: ${count}\n- target: ${target}\nThis chain is not making progress. The turn was stopped by the loop guard so it cannot keep spending tokens on the same action. Report what is blocking progress instead of retrying.`,
    noticeCycle: (period, target) =>
      `Cyclic tool calls detected:\n- pattern length: ${period}\n- target: ${target}\nThe last calls repeat the same ${period}-step cycle without progress. Break the cycle: change approach, gather different evidence, or finish the task.`,
    noticeNearDuplicate: (tool, count, target) =>
      `Near-duplicate tool calls detected:\n- tool: ${tool}\n- consecutive_calls: ${count} (arguments changed, target did not)\n- target: ${target}\nThese calls act on the same target without progress. Inspect the latest result and choose a different action or different arguments instead of calling again.`,
  },
  zh: {
    repeatPeriodic: (copies, unit) => `检测到输出连续重复同一段文字 ${copies} 次（片段：${excerpt(unit)}）`,
    repeatWindow: (percent, unit) => `检测到输出中有 ${percent}% 的内容是同一段文字的重复（片段：${excerpt(unit)}）`,
    repetitionCut: (reason) => `${reason}。已中断这次输出以免继续刷屏和消耗额度。`,
    budgetCalls: (limit) =>
      `本小时模型调用已达上限（${limit} 次），为控制花费已暂停。请稍后继续，或在插件配置里调高 loop-guard 的 maxCallsPerHour。`,
    budgetSteps: (limit) =>
      `本轮已连续执行 ${limit} 步，看起来没有收敛，为控制花费已停止。请重新描述目标，或调高 loop-guard 的 maxStepsPerTurn。`,
    budgetMinutes: (limit) =>
      `本轮已运行超过 ${limit} 分钟，为控制花费已停止。可重新发送要求继续，或调高 loop-guard 的 maxTurnMinutes。`,
    budgetOutput: (limit) =>
      `本轮模型文字输出已超过 ${limit} 字符（不含工具参数），为控制花费已停止。请重新描述目标，或调高 loop-guard 的 maxOutputCharsPerTurn。`,
    cancelReason: (tool, count) => `loop-guard：${tool} 在同一目标上重复了 ${count} 次`,
    noticeStop: (tool, count, target) =>
      `Repeated tool call detected:\n- tool: ${tool}\n- consecutive_calls: ${count}\n- target: ${target}\nThis chain is not making progress. The turn was stopped by the loop guard so it cannot keep spending tokens on the same action. Report what is blocking progress instead of retrying.`,
    noticeCycle: (period, target) =>
      `Cyclic tool calls detected:\n- pattern length: ${period}\n- target: ${target}\nThe last calls repeat the same ${period}-step cycle without progress. Break the cycle: change approach, gather different evidence, or finish the task.`,
    noticeNearDuplicate: (tool, count, target) =>
      `Near-duplicate tool calls detected:\n- tool: ${tool}\n- consecutive_calls: ${count} (arguments changed, target did not)\n- target: ${target}\nThese calls act on the same target without progress. Inspect the latest result and choose a different action or different arguments instead of calling again.`,
  },
}

/**
 * Resolve one locale's catalog, falling back to English for anything unknown.
 * @param locale - configured locale name.
 * @returns the catalog for that locale.
 */
export function createMessages(locale) {
  return Object.hasOwn(CATALOGS, locale) ? CATALOGS[locale] : CATALOGS.en
}

/**
 * Describe one detector hit in the active locale.
 * @param hit - detector hit (`periodic` or `shingle`).
 * @param messages - catalog from {@link createMessages}.
 * @returns one sentence naming what repeated.
 */
export function describeHit(hit, messages) {
  if (hit.kind === 'shingle') return messages.repeatWindow(Math.round((hit.coverage ?? 0) * 100), hit.unit)
  return messages.repeatPeriodic(hit.copies, hit.unit)
}
