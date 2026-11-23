// 用宿主 llm 服务把「上一版 + 本轮摘要」润色成完整交接单。
// 任何失败（拿不到服务、没有路由、超时、输出不合结构）都返回 null，由调用方回落到确定性稿。
import { errorText } from './safe.js'
import { REQUIRED_ANCHORS } from './template.js'

const SYSTEM_PROMPT = [
  '你是项目交接单撰写器。你的唯一输出是一份中文 Markdown 交接单。',
  '严格保留用户给出的 9 个小节标题与原顺序，缺内容就写「无」，绝不编造路径、金额、日期、人名或决定。',
  '不要输出代码围栏，不要输出解释或前后缀。',
].join('')

/** 只累积模型可见正文：reasoning-delta 会污染 JSON/Markdown，必须丢弃。 */
function chunkText(chunk) {
  if (!chunk || typeof chunk !== 'object') return ''
  if (chunk.type === 'reasoning-delta') return ''
  if (chunk.type === 'text-delta' && typeof chunk.text === 'string') return chunk.text
  if (typeof chunk.text === 'string' && chunk.type === undefined) return chunk.text
  return ''
}

/** 懒取 llm 服务：未声明 inject 时属性访问会抛，两条路径都要兜住。 */
export function getLlm(ctx) {
  try {
    if (typeof ctx.get === 'function') {
      const viaGet = ctx.get('llm')
      if (viaGet) return viaGet
    }
  } catch {
    /* 继续尝试属性访问 */
  }
  try {
    return ctx.llm || null
  } catch {
    return null
  }
}

function providerId(entry) {
  if (typeof entry === 'string') return entry
  if (entry && typeof entry === 'object') return entry.id || entry.provider || entry.name
  return undefined
}

function modelId(entry) {
  if (typeof entry === 'string') return entry
  if (entry && typeof entry === 'object') return entry.id || entry.model || entry.name
  return undefined
}

/**
 * 解析调用路由：配置显式指定 > 会话已记录路由 > 首个可用路由。
 * @returns {Promise<{provider: string, model: string} | null>}
 */
export async function resolveRoute(llm, config, session) {
  if (!llm) return null
  const wantedProvider = (config.provider || '').trim()
  const wantedModel = (config.model || '').trim()
  if (wantedProvider && wantedModel) return { provider: wantedProvider, model: wantedModel }

  if (wantedProvider && typeof llm.listModels === 'function') {
    try {
      const models = (await llm.listModels(wantedProvider)) || []
      const model = wantedModel || modelId(models[0])
      if (model) return { provider: wantedProvider, model }
    } catch {
      /* 继续 */
    }
  }

  // 会话里已记录的请求头可能带 provider/model（字段随版本变化，取到就用）
  try {
    if (session && typeof session.requestHeader === 'function') {
      const header = session.requestHeader()
      const provider = header && (header.provider || (header.model && header.model.provider))
      const model = header && (header.model && (header.model.model || header.model.id)) || header.model
      if (typeof provider === 'string' && typeof model === 'string' && provider && model) {
        return { provider, model }
      }
    }
  } catch {
    /* 继续 */
  }

  if (wantedModel) {
    try {
      const providers = (await llm.listProviders?.()) || []
      for (const entry of providers) {
        const provider = providerId(entry)
        if (provider) return { provider, model: wantedModel }
      }
    } catch {
      /* 继续 */
    }
    return null
  }

  try {
    const providers = (await llm.listProviders?.()) || []
    for (const entry of providers) {
      const provider = providerId(entry)
      if (!provider) continue
      const models = (await llm.listModels?.(provider)) || []
      const model = modelId(models[0])
      if (model) return { provider, model }
    }
  } catch {
    /* 拿不到路由 */
  }
  return null
}

function stripFences(text) {
  let value = String(text || '').trim()
  const fence = value.match(/```(?:markdown|md)?\s*([\s\S]*?)```/i)
  if (fence) value = fence[1].trim()
  const start = value.indexOf('# 交接单')
  if (start > 0) value = value.slice(start)
  return value.trim()
}

function validates(text) {
  if (!text || text.length > 60000) return false
  return REQUIRED_ANCHORS.every((anchor) => text.includes(anchor))
}

/**
 * 调用模型润色交接单。
 * @param options.llm - llm 服务
 * @param options.route - {provider, model}
 * @param options.previous - 上一版交接单（可为空字符串）
 * @param options.digest - 本轮摘要
 * @param options.facts - 程序提供的确定事实（时间/项目/工作目录/轮次），要求模型原样使用
 * @param options.skeleton - 骨架（标题清单 + 表头行示例）
 * @param options.timeoutMs - 超时
 * @param options.signal - 外部取消
 * @returns {Promise<{text: string, provider: string, model: string, chars: number} | null>}
 */
export async function summarize(options) {
  const { llm, route, previous, digest, facts, skeleton, timeoutMs = 120000 } = options
  if (!llm || typeof llm.stream !== 'function' || !route) return null

  const user = [
    '【上一版交接单（首次生成为空）】',
    previous && previous.trim() !== '' ? previous : '（无）',
    '',
    '【程序提供的确定事实：表头与这些字段必须原样使用，不得写「未知」】',
    facts || '（无）',
    '',
    '【本轮会话摘要（事实来源，只允许使用这里的内容）】',
    digest,
    '',
    '【必须使用的骨架：表头 + 9 个小节，标题文字与顺序不可改】',
    skeleton,
    '',
    '直接输出完整交接单 Markdown。',
  ].join('\n')

  const messages = [
    { role: 'system', content: [{ type: 'text', text: SYSTEM_PROMPT }] },
    { role: 'user', content: [{ type: 'text', text: user }] },
  ]

  const controller = new AbortController()
  const timer = setTimeout(() => {
    try {
      controller.abort()
    } catch {
      /* 忽略 */
    }
  }, Math.max(5000, timeoutMs))
  const onAbort = () => {
    try {
      controller.abort()
    } catch {
      /* 忽略 */
    }
  }
  if (options.signal && typeof options.signal.addEventListener === 'function') {
    options.signal.addEventListener('abort', onAbort, { once: true })
  }

  let text = ''
  try {
    const stream = llm.stream({ provider: route.provider, model: route.model, messages, signal: controller.signal })
    for await (const chunk of stream) {
      if (!chunk || typeof chunk !== 'object') continue
      if (chunk.type === 'finish' || chunk.kind === 'finish') {
        const reason = chunk.reason || chunk.finish || {}
        const failure = reason.failure || reason.error || null
        if (reason.kind === 'error' || failure) {
          return null
        }
        break
      }
      text += chunkText(chunk)
    }
  } catch (error) {
    // 取消/超时/适配器错误：静默降级，只让调用方记一条 warn
    if (String(errorText(error)).length > 0) return null
    return null
  } finally {
    clearTimeout(timer)
    if (options.signal && typeof options.signal.removeEventListener === 'function') {
      options.signal.removeEventListener('abort', onAbort)
    }
  }

  const cleaned = stripFences(text)
  if (!validates(cleaned)) return null
  return { text: cleaned, provider: route.provider, model: route.model, chars: cleaned.length }
}
