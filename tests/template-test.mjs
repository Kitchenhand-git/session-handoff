// 交接单渲染与续作提示
import { REQUIRED_ANCHORS, SECTIONS, renderHandoff, renderResumeNote, renderSkeleton } from '../host/template.js'
import { buildDigest } from '../host/digest.js'
import { check, eq, includes, summary } from './_harness.mjs'

const records = [
  { type: 'user', text: '把技术册框架填图完成' },
  { type: 'assistant', text: '框架已生成，还差 12 张图' },
  { type: 'tool', name: 'tender_build', args: JSON.stringify({ id: 'p1', target: 'technical' }) },
  { type: 'error', name: 'ops_bash', text: 'powershell 未找到' },
  { type: 'turn-end', reason: { kind: 'completed' } },
]
const digest = buildDigest({ records, chars: 0, dropped: 0, turn: 2, cwd: 'D:\\DSH\\项目\\投标工作台' }, {
  maxChars: 4000,
  cwd: 'D:\\DSH\\项目\\投标工作台',
  files: [{ path: 'D:\\DSH\\投标\\a.docx', tool: 'tender_build', exists: false }],
})

const markdown = renderHandoff({
  sessionId: 'abcd-1234-5678',
  createdAt: Date.now(),
  mode: 'deterministic',
  project: '投标工作台',
  cwd: 'D:\\DSH\\项目\\投标工作台',
  projectDir: 'D:\\DSH\\项目\\投标工作台',
  snapshot: { records, turn: 2 },
  digest,
  turn: 2,
  reason: { kind: 'completed' },
  eventCount: records.length,
})

for (const section of SECTIONS) includes(`渲染含小节 ${section.slice(3, 9)}`, markdown, section)
for (const anchor of REQUIRED_ANCHORS) includes(`渲染含锚点 ${anchor}`, markdown, anchor)
includes('渲染含表头 交接时间', markdown, '| 交接时间 |')
includes('渲染含项目名', markdown, '投标工作台')
includes('渲染含状态列', markdown, '| 状态 | 怎么验证 |')
includes('渲染含报错行', markdown, 'powershell 未找到')
includes('渲染含机器标记', markdown, '<!-- session-handoff: session=abcd-1234-5678')
check('渲染不残留占位符', !markdown.includes('<YYYY') && !markdown.includes('<…>'), 'found placeholder')
check('渲染以一级标题开头', markdown.startsWith('# 交接单：'), markdown.slice(0, 20))
check('渲染结尾有换行', markdown.endsWith('\n'))

const empty = renderHandoff({
  sessionId: 'x', createdAt: Date.now(), mode: 'deterministic', project: '其他', cwd: 'D:\\DSH', projectDir: 'D:\\DSH\\项目\\其他',
  snapshot: { records: [], turn: 0 }, digest: { files: [], stats: {} }, turn: 0, reason: undefined, eventCount: 0,
})
includes('空数据也写第 3 节说明', empty, '本轮未从工具参数中识别到绝对路径')
includes('空数据也保留第 5 节「无」', empty, '无（本轮工具调用没有报错）')
eq('空数据仍是 9 节', SECTIONS.filter((section) => empty.includes(section)).length, 9)

const note = renderResumeNote({
  path: 'D:\\DSH\\项目\\投标工作台\\交接\\20261120-1330-abcd1234-交接单.md',
  project: '投标工作台',
  projectDir: 'D:\\DSH\\项目\\投标工作台',
  mtime: Date.now(),
})
includes('提示含路径', note, '20261120-1330-abcd1234-交接单.md')
includes('提示含续作选项 A', note, 'A「续作')
includes('提示含新任务选项 B', note, 'B「新任务')
includes('提示含 ask_user_question', note, 'ask_user_question')
includes('提示含 working_directory', note, 'working_directory')
includes('提示含交接单围栏', note, '<session-handoff>')

const skeleton = renderSkeleton()
for (const section of SECTIONS) includes(`骨架含 ${section.slice(3, 9)}`, skeleton, section)

summary('template')
