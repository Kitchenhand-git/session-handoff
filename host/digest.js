// 把一轮会话事件压成「给模型看的摘要 + 给交接单第 3 节用的文件清单」。
//
// 输入是 hooks 里缓冲好的记录（已压扁），不读会话日志、不做 I/O 之外的推断。
import { clip, oneLine } from './safe.js'
import { pathExists } from './paths.js'

const PATH_KEYS = new Set([
  'path', 'paths', 'file', 'files', 'file_path', 'filepath', 'save', 'savepath', 'savetopath',
  'output', 'outputpath', 'outputname', 'target', 'targetpath', 'template', 'cwd', 'dir', 'folder',
  'source', 'dest', 'destination', 'copy', 'move', 'root', 'workspace',
])

const DRIVE_PATH = /^[A-Za-z]:[\\/][^\0\r\n]{0,500}$/
const UNC_PATH = /^\\\\[^\0\r\n]{1,500}$/

function looksLikePath(value) {
  if (typeof value !== 'string') return false
  if (value.length < 4 || value.length > 500) return false
  return DRIVE_PATH.test(value) || UNC_PATH.test(value)
}

function collectPaths(value, key, preferred, fallback, depth) {
  if (depth > 6) return
  if (typeof value === 'string') {
    if (!looksLikePath(value)) return
    if (preferred.includes(value) || fallback.includes(value)) return
    // 白名单键（path / file_path / savePath…）优先，其余路径靠后，保证上限内先留重要路径
    if (PATH_KEYS.has(key)) preferred.push(value)
    else fallback.push(value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 50)) collectPaths(item, key, preferred, fallback, depth + 1)
    return
  }
  if (typeof value === 'object' && value !== null) {
    for (const [childKey, childValue] of Object.entries(value).slice(0, 50)) {
      collectPaths(childValue, childKey.toLowerCase(), preferred, fallback, depth + 1)
    }
  }
}

/**
 * 从工具调用参数（原始 JSON 字符串）里抠出绝对路径。
 * @returns {string[]} 去重后的绝对路径（白名单键优先，顺序稳定）
 */
export function extractPathsFromArguments(argumentsText, limit = 40) {
  const preferred = []
  const fallback = []
  const text = String(argumentsText || '')
  if (!text) return preferred
  try {
    collectPaths(JSON.parse(text), '', preferred, fallback, 0)
  } catch {
    // 参数不是合法 JSON：退回正则扫描
    const matches = text.match(/[A-Za-z]:\\[^"',\s]{1,400}/g) || []
    for (const match of matches) {
      const value = match.replace(/\\+$/, '')
      if (value.length > 3 && !preferred.includes(value)) preferred.push(value)
    }
  }
  return [...preferred, ...fallback].slice(0, limit)
}

/** 第 3 节的文件清单：去重 + 存在性 + 首次出现时的工具名。 */
export function collectFiles(records, limit = 40) {
  const seen = new Map()
  for (const record of records) {
    if (record.type !== 'tool') continue
    const paths = extractPathsFromArguments(record.args, 40)
    for (const path of paths) {
      if (!seen.has(path)) seen.set(path, { path, tool: record.name, exists: pathExists(path) })
    }
    if (seen.size >= limit) break
  }
  return [...seen.values()].slice(0, limit)
}

function summarizeReason(reason) {
  if (!reason) return '未知'
  if (typeof reason === 'string') return reason
  if (typeof reason.kind === 'string') return reason.kind
  try {
    return JSON.stringify(reason)
  } catch {
    return '未知'
  }
}

/**
 * 生成本轮摘要文本。
 * @param snapshot - SessionStates.takeTurn 返回的快照
 * @param options - { cwd, maxChars, files }
 * @returns {{text: string, stats: object}}
 */
export function buildDigest(snapshot, options = {}) {
  const maxChars = Number.isInteger(options.maxChars) ? options.maxChars : 12000
  const cwd = options.cwd || snapshot.cwd || ''
  const records = Array.isArray(snapshot.records) ? snapshot.records : []
  const files = options.files || collectFiles(records)

  const userTexts = []
  const assistantTexts = []
  const tools = []
  const errors = []
  let turnEnd = ''

  for (const record of records) {
    if (record.type === 'user') userTexts.push(oneLine(record.text))
    else if (record.type === 'assistant') assistantTexts.push(oneLine(record.text))
    else if (record.type === 'tool') tools.push({ name: record.name, args: record.args })
    else if (record.type === 'error') errors.push({ name: record.name || '工具', text: oneLine(record.text) })
    else if (record.type === 'turn-end') turnEnd = summarizeReason(record.reason)
  }

  const lines = []
  lines.push(`## 本轮环境`)
  lines.push(`- 工作目录：${cwd || '未知'}`)
  lines.push(`- 轮次：第 ${snapshot.turn || '?'} 轮；结束原因：${turnEnd || '未知'}`)
  lines.push(`- 缓冲事件：${records.length} 条` + (snapshot.dropped ? `（更早的 ${snapshot.dropped} 条已丢弃）` : ''))

  lines.push('')
  lines.push('## 用户这一轮说了什么')
  if (userTexts.length === 0) lines.push('- （本轮没有用户消息）')
  else for (const text of userTexts.slice(0, 5)) lines.push(`- ${clip(text, 800)}`)

  lines.push('')
  lines.push('## 我这一轮做了什么')
  if (assistantTexts.length === 0) lines.push('- （没有助手正文）')
  else {
    for (const text of assistantTexts.slice(0, -1)) lines.push(`- ${clip(text, 300)}`)
    lines.push(`- 最后一轮收尾：${clip(assistantTexts[assistantTexts.length - 1], 2000)}`)
  }

  lines.push('')
  lines.push('## 工具调用（按顺序）')
  if (tools.length === 0) lines.push('- （无工具调用）')
  else {
    for (const tool of tools.slice(0, 40)) lines.push(`- ${tool.name} ${clip(oneLine(tool.args), 300)}`)
  }

  if (errors.length > 0) {
    lines.push('')
    lines.push('## 报错与失败')
    for (const item of errors.slice(0, 5)) lines.push(`- ${item.name}：${clip(item.text, 400)}`)
  }

  lines.push('')
  lines.push('## 本轮落地/触碰的文件')
  if (files.length === 0) lines.push('- （未从工具参数里识别到绝对路径）')
  else {
    for (const file of files) lines.push(`- ${file.exists ? '[存在]' : '[不存在]'} ${file.path}`)
  }

  let text = lines.join('\n')
  if (text.length > maxChars) {
    // 保头保尾：头部是环境，尾部是文件清单，中间工具明细先截断
    const head = text.slice(0, Math.floor(maxChars * 0.7))
    const tail = text.slice(-Math.floor(maxChars * 0.25))
    text = `${head}\n…（摘要已截断 ${text.length - maxChars} 字）…\n${tail}`
  }

  return {
    text,
    files,
    stats: {
      records: records.length,
      userTexts: userTexts.length,
      assistantTexts: assistantTexts.length,
      tools: tools.length,
      errors: errors.length,
      files: files.length,
      chars: text.length,
      turnEnd,
    },
  }
}
