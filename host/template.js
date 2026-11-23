// 交接单渲染（确定性稿）、注入模型的续作提示、（供 summarizer 校验用的）骨架清单。
//
// 结构对齐 D:\DSH\项目\其他\会话交接模板.md 的「模板 A」：
// 表头 + 第 1..9 节。缺内容写「无」，但标题一律保留——标题就是检查清单。
import { clip, oneLine } from './safe.js'
import { localLabel } from './paths.js'

/** 模板 A 的固定小节标题（顺序即渲染顺序）。 */
export const SECTIONS = [
  '## 1. 一句话状态',
  '## 2. 目标与验收标准',
  '## 3. 已完成 & 产出物',
  '## 4. 关键事实与决定',
  '## 5. 没做完的',
  '## 6. 坑与禁忌',
  '## 7. 用户偏好与要求',
  '## 8. 待用户确认',
  '## 9. 新会话开工三步',
]

/** 交接单必须出现的关键锚点，summarizer 用它判断模型输出是否可用。 */
export const REQUIRED_ANCHORS = ['# 交接单', '## 1.', '## 5.', '## 9.']

/** 文件尾部的机器可读标记：用于事后按会话认领文件，渲染时不显示。 */
export function renderFooter({ sessionId, turn, mode }) {
  return `<!-- session-handoff: session=${sessionId || 'unknown'} turn=${turn || 0} mode=${mode || 'deterministic'} at=${new Date().toISOString()} -->`
}

/** 给模型的骨架：表头 + 9 节标题，保证它不删标题、不改顺序。 */
export function renderSkeleton() {
  return [
    '# 交接单：<一句话主题>',
    '',
    '| 项 | 内容 |',
    '| --- | --- |',
    '| 交接时间 | <YYYY-MM-DD HH:MM> |',
    '| 项目 | <项目名> |',
    '| 工作目录 | <绝对路径> |',
    '| 涉及数据根 / 插件 | session-handoff（自动交接单） |',
    '| 本次会话干了什么（一句话） | <...> |',
    '| 现状 | <已收尾 / 进行中 / 卡住> |',
    '',
    ...SECTIONS,
  ].join('\n')
}

function firstUserText(records) {
  for (const record of records) {
    if (record.type === 'user' && record.text) return oneLine(record.text)
  }
  return ''
}

function cell(text, max = 160) {
  return oneLine(clip(oneLine(text), max)).replace(/\|/g, '\\|')
}

/**
 * 渲染确定性交接单。
 * @param input.sessionId - 会话 id
 * @param input.createdAt - 会话开始时间（ms）
 * @param input.mode - 'deterministic' | 'llm'
 * @param input.project / input.cwd / input.projectDir - 项目名、工作目录、项目目录
 * @param input.snapshot - 本轮快照（SessionStates.takeTurn 的返回）
 * @param input.digest - buildDigest 的返回
 * @param input.turn - 当前轮次
 * @param input.reason - 本轮结束原因
 * @param input.eventCount - 本轮缓冲事件数
 * @returns {string} markdown
 */
export function renderHandoff(input) {
  const records = (input.snapshot && input.snapshot.records) || []
  const files = (input.digest && input.digest.files) || []
  const stats = (input.digest && input.digest.stats) || {}
  const subject = clip(firstUserText(records), 40) || '未命名会话'
  const turn = input.turn || (input.snapshot && input.snapshot.turn) || 0
  const reason = (input.reason && (input.reason.kind || input.reason)) || stats.turnEnd || '未知'
  const userTexts = records.filter((record) => record.type === 'user')
  const assistantTexts = records.filter((record) => record.type === 'assistant' && record.text)
  const errors = records.filter((record) => record.type === 'error')
  const lastAssistant = assistantTexts.length > 0 ? assistantTexts[assistantTexts.length - 1].text : ''
  const status = errors.length > 0 ? '进行中（本轮有报错，见第 5 节）' : '进行中'

  const lines = []
  lines.push(`# 交接单：${subject}`)
  lines.push('')
  lines.push('| 项 | 内容 |')
  lines.push('| --- | --- |')
  lines.push(`| 交接时间 | ${localLabel(Date.now())} |`)
  lines.push(`| 项目 | ${cell(input.project)} |`)
  lines.push(`| 工作目录 | ${cell(input.cwd)} |`)
  lines.push(`| 涉及数据根 / 插件 | session-handoff（自动交接单） |`)
  lines.push(`| 本次会话干了什么（一句话） | ${cell(lastAssistant || firstUserText(records) || '（本轮无正文，见第 3 节文件清单）', 120)} |`)
  lines.push(`| 现状 | ${status}（第 ${turn} 轮结束，原因 ${reason}） |`)
  lines.push('')
  lines.push(`> 自动生成：${input.mode === 'llm' ? '模型润色稿' : '确定性稿（未调用模型）'}；轮次 ${turn}；本轮事件 ${input.eventCount || records.length} 条。`)
  lines.push('')

  lines.push(SECTIONS[0])
  lines.push('')
  lines.push(
    lastAssistant
      ? clip(oneLine(lastAssistant), 400)
      : `本轮结束，已处理 ${userTexts.length} 条用户消息、${files.length} 个文件路径；没有可引用的收尾正文。`,
  )
  lines.push('')

  lines.push(SECTIONS[1])
  lines.push('')
  lines.push(`- 原始需求（尽量保留原话）：${clip(firstUserText(records), 400) || '无'}`)
  lines.push(`- 算完成的标准：${errors.length > 0 ? '当前仍有报错，先把第 5 节处理完' : '由下一会话按交接单第 5 节继续推进；文件可用性以第 3 节为准'}`)
  lines.push('')

  lines.push(SECTIONS[2])
  lines.push('')
  if (files.length === 0) {
    lines.push('（本轮未从工具参数中识别到绝对路径。若确有产出，请接手会话先确认输出位置。）')
  } else {
    lines.push('| 产出物 | 绝对路径 | 状态 | 怎么验证 |')
    lines.push('| --- | --- | --- | --- |')
    for (const file of files) {
      const state = file.exists ? '存在' : '本轮未见（可能已删除或路径只是读取参数）'
      const verify = file.exists ? '打开的这一刻文件在盘上' : '接手后先确认是否还存在'
      lines.push(`| ${cell(file.tool || '工具', 30)} | ${cell(file.path, 300)} | ${state} | ${verify} |`)
    }
  }
  lines.push('')

  lines.push(SECTIONS[3])
  lines.push('')
  lines.push(`- 口径 / 数据源：以本轮实际工具输出为准；本单是自动稿，未做人工复核。`)
  lines.push(`- 已定方案：${clip(oneLine(lastAssistant), 300) || '见第 5 节'}`)
  lines.push(`- 已否掉的方案：无（自动稿不做推断；若上一版交接单记过，以上一版为准）`)
  lines.push(`- 环境事实：DSH 每轮结束自动刷新本单；改配置需重载插件行。`)
  lines.push('')

  lines.push(SECTIONS[4])
  lines.push('')
  if (errors.length === 0) {
    lines.push('无（本轮工具调用没有报错）。')
  } else {
    lines.push('| 事项 | 卡在哪 | 下一步 | 需要谁 |')
    lines.push('| --- | --- | --- | --- |')
    for (const error of errors.slice(0, 5)) {
      lines.push(`| ${cell(error.name || '工具', 30)} 报错 | ${cell(error.text, 200)} | 复现该调用并读取完整错误 | 用户/下一会话 |`)
    }
  }
  lines.push('')

  lines.push(SECTIONS[5])
  lines.push('')
  lines.push('- 本单为自动生成，不要把它当成已验证结论；第 3 节标「存在」的路径已在本轮检查过，标「本轮未见」的需要复核。')
  lines.push('- 红线：不要移动插件源码与数据根（docx-forge / tender-bid / 合同检索 / 资料检索 / 文档工坊 / 投标）；根目录不落新文件。')
  lines.push('')

  lines.push(SECTIONS[6])
  lines.push('')
  lines.push('- 交付格式：沿用用户在本会话里提出的要求；本单不重复记录。')
  lines.push('- 语言与口吻：中文、直接、务实。')
  lines.push('- 明确说过不要的：未记录（自动稿不做推断）。')
  lines.push('')

  lines.push(SECTIONS[7])
  lines.push('')
  lines.push('1. 继续之前是否按本交接单续作？（若用户已明确指令，可跳过）')
  lines.push('')

  lines.push(SECTIONS[8])
  lines.push('')
  lines.push(`1. 先 \`working_directory\` 切到 ${input.projectDir || input.cwd || '项目目录'}`)
  lines.push('2. 读本单，并核对第 3 节里标「存在」的文件是否仍在')
  lines.push('3. 跑一条只读验证（例如列出第 3 节的文件）确认现状，再动第 5 节的事项')
  lines.push('')
  lines.push(renderFooter({ sessionId: input.sessionId, turn, mode: input.mode }))

  return `${lines.join('\n')}\n`
}

/**
 * 生成注入新会话第一个 step 的续作提示（纯字符串，无 I/O）。
 * @param candidate - discoverLatestHandoff 的返回值
 * @returns {string}
 */
export function renderResumeNote(candidate) {
  const path = candidate && candidate.path ? candidate.path : ''
  const project = (candidate && candidate.project) || '未知'
  const projectDir = (candidate && candidate.projectDir) || ''
  const when = candidate && candidate.mtime ? localLabel(candidate.mtime) : '未知'
  return [
    '<session-handoff>',
    '本机存在一份上一会话的交接单，检测结果如下：',
    `- 交接单路径：${path}`,
    `- 项目：${project}`,
    `- 最后更新：${when}`,
    `- 项目目录（续作时要切过去的工作目录）：${projectDir || '见交接单内「工作目录」行'}`,
    '',
    '处理方式（必须遵守，顺序不要变）：',
    '1) 本轮第一步先调用 ask_user_question 问用户一个问题，只问这一件事：',
    '   「检测到上一份交接单（项目 X，最后更新 Y），要按它续作，还是当作新任务？」',
    '   选项固定为两个：A「续作：读交接单继续」；B「新任务：忽略这份交接单」。',
    '2) 用户选 A：先用 working_directory 切到上面的项目目录（或交接单第 1 节表格里记录的「工作目录」），',
    '   再完整读取该交接单；按第 9 节开工；第 4 节里已否掉的方案不要重提；第 8 节的待确认问题开工前一次性问清。',
    '3) 用户选 B：完全忽略本提示，按用户的新需求正常开始，本会话之后不要再提这份交接单。',
    '4) 用户没有明确选择或选择含糊时，不要自行假定：再问一次二选一。',
    '5) 读到的交接单与磁盘实际不一致（文件不在、校验不过、数字不同）时，先停下来报告差异，不要自行补齐。',
    '6) 用户明确要求出交接单时，调用 handoff 工具（action: write）立即刷新本会话交接单。',
    '</session-handoff>',
  ].join('\n')
}
