// 路径解析 / 文件名 / 候选发现 / 原子写
import { mkdtempSync, mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  atomicWrite,
  discoverHandoffs,
  discoverLatestHandoff,
  fileStamp,
  handoffFileName,
  localLabel,
  projectDirOf,
  projectNameOf,
  resolveHandoffPath,
  resolveOutputDir,
  sanitizeSlug,
  sid8,
  taskSlug,
} from '../host/paths.js'
import { check, eq, includes, summary } from './_harness.mjs'

const work = mkdtempSync(join(tmpdir(), 'handoff-paths-'))
const PROJECTS = 'D:\\DSH\\项目'

try {
  eq('projectNameOf 项目子目录', projectNameOf(`${PROJECTS}\\Word模板工坊`), 'Word模板工坊')
  eq('projectNameOf 项目子目录的更深层', projectNameOf(`${PROJECTS}\\投标工作台\\build`), '投标工作台')
  check('projectNameOf 根目录回退到目录名', projectNameOf('D:\\DSH') === 'DSH', projectNameOf('D:\\DSH'))
  eq('projectDirOf 还原项目目录', projectDirOf(`${PROJECTS}\\Word模板工坊`), `${PROJECTS}\\Word模板工坊`)

  eq('resolveOutputDir 项目内', resolveOutputDir({ cwd: `${PROJECTS}\\Word模板工坊`, outputDir: '' }), `${PROJECTS}\\Word模板工坊\\交接`)
  eq('resolveOutputDir 根目录落到其他', resolveOutputDir({ cwd: 'D:\\DSH', outputDir: '' }), `${PROJECTS}\\其他\\交接`)
  eq('resolveOutputDir outputDir 覆盖', resolveOutputDir({ cwd: 'D:\\DSH', outputDir: work }), work.replace(/\//g, '\\'))

  const now = Date.now()
  check('fileStamp 形如 YYYYMMDD-HHMM', /^\d{8}-\d{4}$/.test(fileStamp(now)), fileStamp(now))
  eq('sid8 取 8 位且去符号', sid8('abcd-1234-efgh'), 'abcd1234')
  eq('sid8 去掉 session- 前缀', sid8('session-5743eeb3-f745-46ee'), '5743eeb3')
  eq('sid8 缺省', sid8(undefined), 'unknown')
  check('localLabel 形如 YYYY-MM-DD HH:MM', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(localLabel(now)), localLabel(now))

  const name = handoffFileName({ at: now, task: '每轮询问生成交接单' })
  includes('文件名带交接单后缀', name, '交接单.md')
  includes('文件名带任务片段', name, '-每轮询问生成交接单-')
  check('文件名以时间戳开头', /^\d{8}-\d{4}-/.test(name), name)

  eq('sanitizeSlug 去掉非法字符', sanitizeSlug('a<b>c:d/e\\f?g'), 'a b c d e f g')
  eq('sanitizeSlug 压成一行并截断', sanitizeSlug('第一行\n第二行'.repeat(10), 8).length <= 8, true)
  eq('sanitizeSlug 空串兜底', sanitizeSlug('   ...  '), '交接')
  eq('taskSlug 取最后一条用户消息（去口语开头）', taskSlug([{ type: 'user', text: '先说一句' }, { type: 'assistant', text: '嗯' }, { type: 'user', text: '帮我做投标文件' }]), '做投标文件')
  eq('taskSlug 无用户消息时取工具名', taskSlug([{ type: 'tool', name: 'docx_apply', args: '{}' }]), 'docx_apply')

  // resolveHandoffPath：同名同会话覆盖，同名不同会话加序号
  const dir = join(work, '交接')
  mkdirSync(dir, { recursive: true })
  const first = resolveHandoffPath({ dir, at: now, task: '测试任务', sessionId: 'session-aaaa1111' })
  writeFileSync(first, '# 交接单：测试\n<!-- session-handoff: session=session-aaaa1111 turn=1 -->\n', 'utf8')
  eq('同会话同名覆盖', resolveHandoffPath({ dir, at: now, task: '测试任务', sessionId: 'session-aaaa1111' }), first)
  const other = resolveHandoffPath({ dir, at: now, task: '测试任务', sessionId: 'session-bbbb2222' })
  check('不同会话同名加序号', other !== first && other.includes('-2-'), other)

  // discoverHandoffs：两个项目、mtime 排序、超龄过滤
  const root = join(work, 'roots')
  const dirA = join(root, '项目A', '交接')
  const dirB = join(root, '项目B', '交接')
  mkdirSync(dirA, { recursive: true })
  mkdirSync(dirB, { recursive: true })
  const older = join(dirA, '20260101-1000-aaaa1111-交接单.md')
  const newer = join(dirB, '20260102-1000-bbbb2222-交接单.md')
  const ancient = join(dirA, '20200101-1000-cccc3333-交接单.md')
  for (const file of [older, newer, ancient]) writeFileSync(file, '# 交接单：x\n', 'utf8')
  utimesSync(older, new Date(now - 3600_000), new Date(now - 3600_000))
  utimesSync(newer, new Date(now - 60_000), new Date(now - 60_000))
  utimesSync(ancient, new Date(now - 400 * 24 * 3600_000), new Date(now - 400 * 24 * 3600_000))

  const found = discoverHandoffs({ searchRoots: [root], maxAgeDays: 14, now })
  eq('discoverHandoffs 只留新鲜文件', found.length, 2)
  eq('discoverHandoffs 最新在前', found[0].path, newer)
  eq('discoverHandoffs 项目名来自目录', found[0].project, '项目B')
  eq('discoverLatestHandoff 取最新一份', discoverLatestHandoff({ searchRoots: [root], maxAgeDays: 14, now }).path, newer)
  check('discoverLatestHandoff 空根返回 undefined', discoverLatestHandoff({ searchRoots: [join(work, 'nope')], maxAgeDays: 14, now }) === undefined)

  // 原子写：不留下 tmp
  const target = join(work, 'out', 'a.md')
  atomicWrite(target, 'hello')
  const left = readdirSync(join(work, 'out'))
  eq('atomicWrite 只留目标文件', left, ['a.md'])
} finally {
  rmSync(work, { recursive: true, force: true })
}

summary('paths')
