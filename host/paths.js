// 目录与文件名解析、候选交接单发现、原子写。
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

const WORKSPACE_ROOT = 'D:\\DSH'
const PROJECTS_ROOT = 'D:\\DSH\\项目'
const HANDOFF_DIR_NAME = '交接'
const HANDOFF_SUFFIX = '交接单.md'

/** 把路径统一成正斜杠再比较，避免大小写/分隔符差异导致判断失败。 */
function normalized(path) {
  return String(path || '').replace(/\//g, '\\').replace(/\\+$/, '')
}

function isUnder(child, parent) {
  const c = normalized(child).toLowerCase()
  const p = normalized(parent).toLowerCase()
  return c === p || c.startsWith(`${p}\\`)
}

/** 项目名：cwd 在 项目\<名>\… 之下时取 <名>，否则回退到目录名。 */
export function projectNameOf(cwd) {
  const full = normalized(cwd)
  if (!full) return '其他'
  if (isUnder(full, PROJECTS_ROOT)) {
    const rest = full.slice(PROJECTS_ROOT.length).replace(/^\\+/, '')
    const first = rest.split('\\')[0]
    if (first) return first
  }
  const name = basename(full)
  return name && name !== '.' ? name : '其他'
}

/** 会话工作目录对应的项目目录（新会话续作时要切过去的地方）。 */
export function projectDirOf(cwd) {
  const name = projectNameOf(cwd)
  return isUnder(cwd, PROJECTS_ROOT) ? normalized(cwd) : join(PROJECTS_ROOT, name)
}

/**
 * 决定交接单落盘目录。
 * 优先 outputDir；否则 cwd 在 D:\DSH\项目 下 -> <cwd>\交接；否则 D:\DSH\项目\其他\交接。
 */
export function resolveOutputDir({ cwd, outputDir }) {
  if (outputDir && outputDir.trim() !== '') return normalized(resolve(outputDir.trim()))
  const full = normalized(cwd)
  if (full && isUnder(full, PROJECTS_ROOT)) {
    // 若 cwd 就是某个项目目录本身，直接放它的 交接 子目录
    return join(normalized(resolve(full)), HANDOFF_DIR_NAME)
  }
  return join(PROJECTS_ROOT, '其他', HANDOFF_DIR_NAME)
}

function pad(value) {
  return String(value).padStart(2, '0')
}

/** 会话开始时间 -> YYYYMMDD-HHMM（本地时区），会话内固定，用于滚动覆盖。 */
export function fileStamp(createdAt) {
  const ms = Number.isFinite(createdAt) && createdAt > 0 ? createdAt : Date.now()
  const date = new Date(ms)
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`
}

/** 本地可读时间 YYYY-MM-DD HH:MM。 */
export function localLabel(ms = Date.now()) {
  const date = new Date(ms)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 会话 id 的前 8 位（先去掉 `session-` 这类前缀，再只保留字母数字，避免文件名非法字符）。 */
export function sid8(sessionId) {
  const raw = String(sessionId || '')
    .replace(/^session[-_]/i, '')
    .replace(/[^0-9a-zA-Z]/g, '')
  return raw.slice(0, 8) || 'unknown'
}

// 只去掉纯口语开头，避免把「现在/需要」这类词误删；命中一个就停。
const FILLER_PREFIXES = [
  '我认为',
  '我觉得',
  '我想',
  '请帮我',
  '麻烦你',
  '麻烦',
  '帮我',
  '请',
  '另外',
  '还有',
  '然后',
  '那么',
  '所以',
  '所以说',
]

/** 把一段任务描述压成可做文件名的片段（去 Markdown/URL/非法字符，截断）。 */
export function sanitizeSlug(text, maxChars = 24) {
  let value = String(text === undefined || text === null ? '' : text)
  value = value.replace(/```[\s\S]*?```/g, ' ')
  value = value.replace(/`[^`]*`/g, ' ')
  value = value.replace(/https?:\/\/\S+/g, ' ')
  value = value.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
  value = value.replace(/[#>*~|]/g, ' ')
  value = value.replace(/[\r\n\t]+/g, ' ')
  value = value.replace(/^[\s"'“”‘’「」『』【】()（）:：,，.。;；!！?？、-]+/, '')
  for (const filler of FILLER_PREFIXES) {
    if (value.startsWith(filler)) {
      value = value.slice(filler.length).replace(/^[\s,，。.：:、]+/, '')
      break
    }
  }
  // Windows 文件名非法字符与控制字符
  value = value.replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
  value = value.replace(/\s+/g, ' ').trim()
  value = value.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '')
  const limit = Number.isFinite(maxChars) && maxChars > 4 ? Math.floor(maxChars) : 24
  if (value.length > limit) value = value.slice(0, limit).replace(/[.\s]+$/, '').trim()
  return value || '交接'
}

/** 从本轮记录里取「这一轮在干什么」：最后一条用户消息优先。 */
export function taskSlug(records, maxChars = 24) {
  const list = Array.isArray(records) ? records : []
  let text = ''
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const record = list[index]
    if (record && record.type === 'user' && typeof record.text === 'string' && record.text.trim() !== '') {
      text = record.text
      break
    }
  }
  if (text === '') {
    for (let index = list.length - 1; index >= 0; index -= 1) {
      const record = list[index]
      if (record && record.type === 'tool' && typeof record.name === 'string' && record.name) {
        text = record.name
        break
      }
    }
  }
  return sanitizeSlug(text, maxChars)
}

/** 本份交接单的文件名：<轮末时间>-<任务片段>-交接单.md */
export function handoffFileName({ at, task, maxChars }) {
  return `${fileStamp(at)}-${sanitizeSlug(task, maxChars)}-${HANDOFF_SUFFIX}`
}

/** 文件是否属于该会话（读正文里的 footer 标记 session=...）。 */
function fileOwnedBy(file, sessionId) {
  try {
    const text = readFileSync(file, 'utf8')
    const needle = String(sessionId || '').replace(/^session[-_]/i, '')
    if (needle === '') return false
    return text.includes(needle)
  } catch {
    return false
  }
}

/**
 * 决定这一轮交接单写到哪个文件：
 * - 同名文件已存在且属于同一会话（同一轮重复点/重复命令）→ 覆盖它；
 * - 同名但属于别的会话 → 追加 -2 / -3 避免互相覆盖。
 */
export function resolveHandoffPath({ dir, at, task, maxChars, sessionId }) {
  const stem = `${fileStamp(at)}-${sanitizeSlug(task, maxChars)}`
  let target = join(dir, `${stem}-${HANDOFF_SUFFIX}`)
  for (let n = 2; n <= 50; n += 1) {
    if (!safeStat(target)) return target
    if (sessionId && fileOwnedBy(target, sessionId)) return target
    target = join(dir, `${stem}-${n}-${HANDOFF_SUFFIX}`)
  }
  return join(dir, `${stem}-${Date.now()}-${HANDOFF_SUFFIX}`)
}

/** 在目录里找本会话已经存在的交接单（会话迁移/重启后复认，避免生成第二种文件）。 */
export function findExistingHandoff(dir, sessionId) {
  const tag = `-${sid8(sessionId)}-${HANDOFF_SUFFIX}`
  try {
    for (const name of readdirSync(dir)) {
      if (name.endsWith(tag)) return join(dir, name)
    }
  } catch {
    /* 目录不存在或不可读：当作没有 */
  }
  return undefined
}

/** 原子写：先写临时文件再 rename，避免读到半截内容。 */
export function atomicWrite(file, text) {
  const dir = dirname(file)
  mkdirSync(dir, { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, file)
}

function safeStat(file) {
  try {
    const info = statSync(file)
    return info.isFile() ? info : undefined
  } catch {
    return undefined
  }
}

/** 列表里的路径是否存在（用于交接单第 3 节标注状态）。 */
export function pathExists(file) {
  try {
    return existsSync(String(file))
  } catch {
    return false
  }
}

/**
 * 从交接单文件头部行读「项目 / 工作目录」，失败返回空对象。
 * 只在用户显式 /handoff list|read 与候选确认时使用，不在 agent/created 里读。
 */
export function readHandoffHeader(file, limitBytes = 8192) {
  try {
    const text = readFileSync(file, { encoding: 'utf8' })
    const head = text.slice(0, limitBytes)
    const pick = (label) => {
      const match = head.match(new RegExp(`\\|\\s*${label}\\s*\\|\\s*([^|\\n]+)\\|`))
      return match ? match[1].trim() : undefined
    }
    return {
      project: pick('项目'),
      cwd: pick('工作目录'),
      updatedAt: pick('交接时间'),
      summary: pick('本次会话干了什么（一句话）'),
    }
  } catch {
    return {}
  }
}

function listHandoffFiles(dir, out, depth) {
  if (depth < 0) return
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  let count = 0
  for (const entry of entries) {
    if (count >= 200) break
    const full = join(dir, entry.name)
    try {
      if (entry.isDirectory()) {
        // 只看一层项目目录下的 交接 目录：<root>/<项目>/交接/*
        if (entry.name === HANDOFF_DIR_NAME) {
          let files
          try {
            files = readdirSync(full, { withFileTypes: true })
          } catch {
            continue
          }
          let seen = 0
          for (const file of files) {
            if (seen >= 200) break
            if (!file.isFile() || !file.name.endsWith(HANDOFF_SUFFIX)) continue
            const info = safeStat(join(full, file.name))
            if (!info) continue
            out.push({ path: join(full, file.name), mtime: info.mtimeMs, dir: full })
            seen += 1
            count += 1
          }
          continue
        }
        listHandoffFiles(full, out, depth - 1)
      }
    } catch {
      /* 单个条目失败不影响其它 */
    }
  }
}

/**
 * 发现所有交接单（本机、有界、同步），按 mtime 倒序。
 * 只在 agent/created 与 /handoff list 里调用；不读文件内容。
 * @returns {Array<{path: string, mtime: number, project: string, projectDir: string}>}
 */
export function discoverHandoffs({ searchRoots, maxAgeDays, now = Date.now() }) {
  const files = []
  for (const root of searchRoots) {
    listHandoffFiles(normalized(root), files, 2)
  }
  const cutoff = now - maxAgeDays * 24 * 3600 * 1000
  const fresh = files.filter((item) => item.mtime >= cutoff)
  fresh.sort((a, b) => b.mtime - a.mtime)
  return fresh.map((item) => ({
    path: item.path,
    mtime: item.mtime,
    project: projectNameOf(dirname(item.dir)),
    projectDir: dirname(item.dir),
  }))
}

/** 最近一份交接单；没有则 undefined。 */
export function discoverLatestHandoff(options) {
  return discoverHandoffs(options)[0]
}

export { WORKSPACE_ROOT, PROJECTS_ROOT, HANDOFF_DIR_NAME, HANDOFF_SUFFIX, safeStat }
