// 统一的日志与异常兜底工具。
//
// 本插件的铁律：任何监听器内部抛错都不许冒泡——agent/created 抛错会让会话创建失败，
// agent/pre-step 抛错会让该 step 失败。这里提供 warn()/safe()/errorText() 三件套。
const PREFIX = '[session-handoff]'

function format(args) {
  // 支持 printf 风格的 %s，其余参数原样拼接
  if (typeof args[0] !== 'string') return args.map(String).join(' ')
  let index = 1
  const text = args[0].replace(/%s/g, () => {
    const value = args[index]
    index += 1
    return value === undefined ? '%s' : String(value)
  })
  const rest = args.slice(index)
  return rest.length === 0 ? text : `${text} ${rest.map(String).join(' ')}`
}

function pick(ctx) {
  try {
    const logger = ctx && ctx.logger
    if (logger && typeof logger.warn === 'function') return logger
  } catch {
    /* 未声明的服务访问会抛，忽略 */
  }
  return undefined
}

/** 取一个可用的 logger；都没有时退化成 console，保证不因日志缺失而抛错。 */
export function createLogger(ctx) {
  const base = pick(ctx)
  const call = (level) => (...args) => {
    const text = format(args)
    try {
      if (base && typeof base[level] === 'function') {
        base[level](text.startsWith(PREFIX) ? text : `${PREFIX} ${text}`)
        return
      }
      if (base && typeof base === 'function') {
        base(text.startsWith(PREFIX) ? text : `${PREFIX} ${text}`)
        return
      }
    } catch {
      /* 日志失败不影响功能 */
    }
    try {
      if (level === 'warn' || level === 'error') console.warn(text)
      else console.log(text)
    } catch {
      /* 连 console 都没有就彻底放弃 */
    }
  }
  return { info: call('info'), warn: call('warn'), error: call('error'), debug: call('debug') }
}

/** 把任意异常转成一行可读文本。 */
export function errorText(error) {
  if (!error) return '未知错误'
  if (typeof error === 'string') return error
  if (typeof error === 'object') {
    if (typeof error.message === 'string' && error.message) return error.message
    try {
      return JSON.stringify(error)
    } catch {
      return String(error)
    }
  }
  return String(error)
}

/**
 * 包一层 try/catch：同步与异步异常都只记 warn，返回 fallback。
 * 注意：需要返回值语义的场景（如 agent/pre-step）不要用本函数，改为显式 try/catch 并保证返回值。
 */
export function safe(logger, label, fn, fallback = undefined) {
  try {
    const result = fn()
    if (result && typeof result.then === 'function') {
      return result.catch((error) => {
        logger.warn('%s 失败：%s', label, errorText(error))
        return fallback
      })
    }
    return result
  } catch (error) {
    logger.warn('%s 失败：%s', label, errorText(error))
    return fallback
  }
}

/** 截断文本，超出时带省略号与省略量；上限很小时直接硬截断，保证结果不超过 max。 */
export function clip(text, max) {
  const value = String(text === undefined || text === null ? '' : text)
  if (max <= 0) return ''
  if (value.length <= max) return value
  const suffix = `…(+${value.length - max}字)`
  if (max <= suffix.length + 2) return value.slice(0, max)
  return `${value.slice(0, max - suffix.length)}${suffix}`
}

/** 把一段可能很长的单行文本压成单行（换行变空格）。 */
export function oneLine(text) {
  return String(text === undefined || text === null ? '' : text).replace(/\s+/g, ' ').trim()
}
