// 配置解析：不依赖 schemastery。
//
// 不使用 `export const Config` 的原因：
//   1) 少一个 @deepseek-ai/schemastery 的加载依赖，插件更不容易因解析失败整行不激活；
//   2) 本插件的首要目标是「坏了也不影响正常对话」，非法配置一律降级为默认值 + warn，而不是抛错。
// 代价：Plugins 页不会展示配置 schema，配置说明写在 README 与 cordis.patch.yml 注释里。
const DEFAULT_SEARCH_ROOTS = ['D:\\DSH\\项目']
export const DEFAULT_OUTPUT_TAIL = ['项目', '其他', '交接']
/** 构建标记：/handoff status 会显示它，用来确认运行中的进程加载的是哪一版代码。 */
export const BUILD = '2026-11-23-14'

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function bool(value, fallback, warnings, key) {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value === 'boolean') return value
  if (value === 'true' || value === 'on' || value === 1 || value === '1') return true
  if (value === 'false' || value === 'off' || value === 0 || value === '0') return false
  warnings.push(`${key} 取值非法（${String(value)}），用默认 ${String(fallback)}`)
  return fallback
}

function int(value, fallback, min, max, warnings, key) {
  if (value === undefined || value === null || value === '') return fallback
  const num = Number(value)
  if (!Number.isFinite(num) || !Number.isInteger(num)) {
    warnings.push(`${key} 不是整数（${String(value)}），用默认 ${fallback}`)
    return fallback
  }
  if (num < min || num > max) {
    warnings.push(`${key} 超出范围 ${min}..${max}（${num}），已夹到边界`)
    return Math.min(max, Math.max(min, num))
  }
  return num
}

function str(value, fallback, warnings, key) {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'string') {
    warnings.push(`${key} 不是字符串，用默认值`)
    return fallback
  }
  return value.trim()
}

function stringList(value, fallback, warnings, key) {
  if (value === undefined || value === null) return [...fallback]
  const list = Array.isArray(value) ? value : [value]
  const cleaned = []
  for (const item of list) {
    if (typeof item !== 'string') {
      warnings.push(`${key} 里有非字符串项，已忽略`)
      continue
    }
    const text = item.trim()
    if (text !== '' && !cleaned.includes(text)) cleaned.push(text)
  }
  if (cleaned.length === 0) {
    warnings.push(`${key} 为空，用默认值`)
    return [...fallback]
  }
  return cleaned
}

/**
 * 读取插件行配置并归一化。
 * @param raw - cordis 传入的行配置（可能为 undefined / 非对象）。
 * @returns {{config: object, warnings: string[]}}
 */
export function loadConfig(raw) {
  const warnings = []
  const input = isPlainObject(raw) ? raw : {}
  if (raw !== undefined && !isPlainObject(raw)) warnings.push('插件行 config 不是对象，全部使用默认值')

  const summaryMode = str(input.summaryMode, 'llm', warnings, 'summaryMode').toLowerCase()
  const normalizedMode = summaryMode === 'deterministic' ? 'deterministic' : 'llm'
  if (summaryMode !== 'llm' && summaryMode !== 'deterministic') {
    warnings.push(`summaryMode 只能是 llm / deterministic（收到 ${summaryMode}），按 llm 处理`)
  }

  const config = {
    enabled: bool(input.enabled, true, warnings, 'enabled'),
    turnEndEnabled: bool(input.turnEndEnabled, true, warnings, 'turnEndEnabled'),
    summaryMode: normalizedMode,
    debounceMs: int(input.debounceMs, 1500, 0, 60000, warnings, 'debounceMs'),
    maxDigestChars: int(input.maxDigestChars, 12000, 1000, 80000, warnings, 'maxDigestChars'),
    maxPrevChars: int(input.maxPrevChars, 6000, 0, 60000, warnings, 'maxPrevChars'),
    timeoutMs: int(input.timeoutMs, 120000, 5000, 900000, warnings, 'timeoutMs'),
    provider: str(input.provider, '', warnings, 'provider'),
    model: str(input.model, '', warnings, 'model'),
    newSessionAsk: bool(input.newSessionAsk, true, warnings, 'newSessionAsk'),
    // 轮末先问再写：true = 弹卡确认；false = 恢复旧的「结束即自动写」
    confirmBeforeWrite: bool(input.confirmBeforeWrite, true, warnings, 'confirmBeforeWrite'),
    // 轮末到弹卡之间给用户先打字的窗口（期间有新消息就不问了）
    askDelayMs: int(input.askDelayMs, 5000, 0, 600000, warnings, 'askDelayMs'),
    // 卡片最长停留，超时按「不生成」
    askTimeoutMs: int(input.askTimeoutMs, 300000, 10000, 3600000, warnings, 'askTimeoutMs'),
    // 文件名任务片段的最大字符数
    nameMaxChars: int(input.nameMaxChars, 24, 6, 80, warnings, 'nameMaxChars'),
    searchRoots: stringList(input.searchRoots, DEFAULT_SEARCH_ROOTS, warnings, 'searchRoots'),
    maxAgeDays: int(input.maxAgeDays, 14, 1, 3650, warnings, 'maxAgeDays'),
    outputDir: str(input.outputDir, '', warnings, 'outputDir'),
    minTurnEvents: int(input.minTurnEvents, 2, 1, 1000, warnings, 'minTurnEvents'),
    // 非配置项：插件内部常量
    candidateCacheMs: 10000,
    maxFilesPerFile: 40,
    maxBufferedEvents: 500,
    maxBufferedChars: 200000,
  }
  return { config, warnings }
}
