// 摘要生成与路径提取
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildDigest, collectFiles, extractPathsFromArguments } from '../host/digest.js'
import { check, eq, includes, summary } from './_harness.mjs'

const work = mkdtempSync(join(tmpdir(), 'handoff-digest-'))
try {
  const realFile = join(work, '产出.docx')
  writeFileSync(realFile, 'x')

  // 路径提取：合法 JSON 里的白名单键优先
  const args = JSON.stringify({
    path: 'D:\\DSH\\项目\\X\\a.docx',
    savePath: realFile,
    note: 'D:\\DSH\\项目\\X\\说明.txt',
    list: ['E:\\tmp\\b.pdf'],
  })
  const paths = extractPathsFromArguments(args, 10)
  check('extractPaths 拿到路径', paths.length >= 3, String(paths.length))
  eq('extractPaths 白名单键在前', paths[0], 'D:\\DSH\\项目\\X\\a.docx')
  check('extractPaths 命中真实文件路径', paths.includes(realFile), paths.join(','))
  eq('extractPaths 去重且受 limit 限制', extractPathsFromArguments(args, 1).length, 1)

  // 非法 JSON：正则兜底
  const broken = extractPathsFromArguments('{"path": "D:\\DSH\\x\\y.md" oops', 5)
  check('extractPaths 非法 JSON 仍能兜底', broken.some((item) => item.includes('y.md')), JSON.stringify(broken))

  const records = [
    { type: 'user', text: '帮我把模板改成 2026 年版' },
    { type: 'assistant', text: '我先看看模板结构' },
    { type: 'tool', name: 'docx_inspect', args: JSON.stringify({ path: 'D:\\DSH\\项目\\X\\t.docx' }) },
    { type: 'tool', name: 'write', args: JSON.stringify({ file_path: realFile }) },
    { type: 'error', name: 'ops_bash', text: 'EACCES: permission denied' },
    { type: 'turn-end', reason: { kind: 'completed' } },
  ]
  const files = collectFiles(records, 10)
  eq('collectFiles 数量', files.length, 2)
  const real = files.find((item) => item.path === realFile)
  check('collectFiles 标记存在', real && real.exists === true, JSON.stringify(real))

  const digest = buildDigest({ records, chars: 0, dropped: 0, turn: 3, cwd: 'D:\\DSH\\项目\\X' }, {
    maxChars: 12000,
    cwd: 'D:\\DSH\\项目\\X',
    files,
  })
  includes('摘要含环境段', digest.text, '本轮环境')
  includes('摘要含用户原话', digest.text, '2026 年版')
  includes('摘要含工具名', digest.text, 'docx_inspect')
  includes('摘要含报错原文', digest.text, 'permission denied')
  includes('摘要含文件存在标记', digest.text, '[存在]')
  eq('摘要统计轮次', digest.stats.turnEnd, 'completed')
  check('摘要统计用户消息数', digest.stats.userTexts === 1, String(digest.stats.userTexts))

  // 截断：maxChars 很小时仍保留头尾
  const small = buildDigest({ records, chars: 0, dropped: 0, turn: 3, cwd: 'X' }, { maxChars: 300, cwd: 'X', files })
  check('摘要按 maxChars 截断', small.text.length <= 320, String(small.text.length))
  includes('截断时保留头部', small.text, '本轮环境')

  // 空记录不炸
  const empty = buildDigest({ records: [], chars: 0, dropped: 0, turn: 0, cwd: '' }, { maxChars: 1000, cwd: '', files: [] })
  includes('空摘要仍结构化', empty.text, '用户这一轮说了什么')
} finally {
  rmSync(work, { recursive: true, force: true })
}

summary('digest')
