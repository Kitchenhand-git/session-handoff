// 集成冒烟：假 ctx + 真 service/hooks/commands/tools，跑一遍「新会话询问 + 轮末刷新 + 命令/工具」。
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BUILD, loadConfig } from '../host/config.js'
import { HandoffService } from '../host/service.js'
import { registerHandoffHooks, builtinCreateUserMessage } from '../host/hooks.js'
import { registerHandoffCommands } from '../host/commands.js'
import { registerHandoffTool } from '../host/tools.js'
import { SECTIONS } from '../host/template.js'
import { check, eq, includes, sleep, summary } from './_harness.mjs'

const work = mkdtempSync(join(tmpdir(), 'handoff-smoke-'))
const projectDir = join(work, '项目', '演示项目')
const outDir = join(projectDir, '交接')
const root = join(work, '项目')
const candidatePath = join(root, '旧项目', '交接', '20261120-1330-deadbeef-交接单.md')

const handlers = new Map()
const logs = []
const commands = []
const tools = []

const ctx = {
  logger: {
    info: (...args) => logs.push(['info', args.join(' ')]),
    warn: (...args) => logs.push(['warn', args.join(' ')]),
    error: (...args) => logs.push(['error', args.join(' ')]),
    debug: () => {},
  },
  get: (name) => (name === 'workingDirectory' ? { get: () => projectDir } : undefined),
  on: (name, fn) => {
    handlers.set(name, fn)
    return () => handlers.delete(name)
  },
  effect: (fn) => {
    const disposer = fn()
    return typeof disposer === 'function' ? disposer : () => {}
  },
  commands: { register: (def) => { commands.push(def); return () => {} } },
  tools: { register: (def) => { tools.push(def); return () => {} } },
  llm: undefined,
}

function makeCreateUserMessage(input) {
  return { id: `stub-${Math.random().toString(36).slice(2, 8)}`, role: 'user', ...input }
}

const session = {
  id: 'aaaa1111-2222-3333-4444-555566667777',
  header: { createdAt: Date.now(), cwd: projectDir },
  requestHeader: () => undefined,
}

function emit(name, ...args) {
  const handler = handlers.get(name)
  if (!handler) throw new Error(`未注册的监听器：${name}`)
  return handler(...args)
}

function sessionEvent(event) {
  return emit('session/event', session, event)
}

async function main() {
  // 造一份旧交接单作为候选
  const { mkdirSync, writeFileSync } = await import('node:fs')
  mkdirSync(join(root, '旧项目', '交接'), { recursive: true })
  writeFileSync(candidatePath, [
    '# 交接单：旧任务',
    '',
    '| 项 | 内容 |',
    '| --- | --- |',
    '| 交接时间 | 2026-11-20 13:30 |',
    '| 项目 | 演示工程 |',
    '| 工作目录 | D:\\DSH\\项目\\旧项目 |',
    '| 本次会话干了什么（一句话） | 做到一半 |',
    '',
    '## 5. 没做完的',
    '还有 12 张图没填。',
    '',
  ].join('\n'), 'utf8')

  const { config } = loadConfig({
    debounceMs: 10,
    summaryMode: 'deterministic',
    searchRoots: [root],
    outputDir: outDir,
    minTurnEvents: 2,
    newSessionAsk: true,
    maxAgeDays: 30,
    confirmBeforeWrite: false,
    askDelayMs: 0,
  })
  check('loadConfig 无警告', loadConfig({ debounceMs: 10 }).warnings.length === 0)

  const service = new HandoffService(ctx, config, ctx.logger)
  registerHandoffHooks(ctx, service, { createUserMessage: makeCreateUserMessage })
  registerHandoffCommands(ctx, service)
  registerHandoffTool(ctx, service)

  eq('注册了 5 个监听器', handlers.size, 5)
  eq('注册了 1 个命令', commands.length, 1)
  eq('注册了 1 个工具', tools.length, 1)
  eq('命令名', commands[0].name, 'handoff')
  eq('工具名', tools[0].name, 'handoff')

  // ---- 新会话：agent/created 预扫描 + 首个 step 注入
  emit('agent/created', { agent: { session }, source: 'startup' })
  const state = service.states.get(session)
  check('已记录 startup', state && state.startup === true)
  check('已预扫描候选', state && state.candidate && state.candidate.path === candidatePath, JSON.stringify(state && state.candidate))

  const next = async () => ({ kind: 'enter', messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '继续' }] }] })
  const decision = await emit('agent/pre-step', { agent: { session }, step: 1, turn: 1, messages: [] }, next)
  eq('注入后消息数 +1', decision.messages.length, 2)
  const injected = decision.messages[1]
  eq('注入消息 source.kind', injected.source.kind, 'session-handoff')
  includes('注入消息带候选路径', injected.content[0].text, candidatePath)
  includes('注入消息要求先问', injected.content[0].text, 'ask_user_question')
  // 回归：提示里的「项目」取交接单表头，而不是候选所在文件夹名（旧项目）
  includes('注入消息用表头项目名', injected.content[0].text, '演示工程')

  const again = await emit('agent/pre-step', { agent: { session }, step: 2, turn: 1, messages: [] }, next)
  eq('非首个 step 不注入', again.messages.length, 1)
  check('adopted 已置位', service.states.get(session).adopted === true)

  // ---- 回归：没有 agent/created 也要注入（插件中途加载 / 热重载时 created 已错过）
  const lateSession = { id: 'late-0001', header: { createdAt: Date.now() }, requestHeader: () => undefined }
  const late = await emit('agent/pre-step', { agent: { session: lateSession }, step: 1, turn: 1, messages: [] }, next)
  eq('无 agent/created 也注入', late.messages.length, 2)
  eq('诊断记为 asked', service.states.get(lateSession).resumeReason, 'asked')

  // ---- 回归：真机上裸解析不到 @deepseek-ai/dsh-llm，必须走本地兜底工厂
  const builtin = builtinCreateUserMessage({ content: [{ type: 'text', text: 'x' }], source: { kind: 'session-handoff' } })
  check('兜底消息 role=user', builtin.role === 'user')
  check('兜底消息有 id', typeof builtin.id === 'string' && builtin.id.length > 0)
  check('兜底消息已冻结', Object.isFrozen(builtin))
  eq('工厂来源已记录', service.status(session).resume.factory, 'injected')

  // ---- 回归：子会话（subagent）不注入
  const childSession = { id: 'child-0001', header: { createdAt: Date.now(), origin: 'subagent' }, requestHeader: () => undefined }
  const child = await emit('agent/pre-step', { agent: { session: childSession }, step: 1, turn: 1, messages: [] }, next)
  eq('子会话不注入', child.messages.length, 1)

  // ---- 回归：老会话的第 1 步（turn>1）不算新会话
  const laterSession = { id: 'later-0001', header: { createdAt: Date.now() }, requestHeader: () => undefined }
  const later = await emit('agent/pre-step', { agent: { session: laterSession }, step: 1, turn: 2, messages: [] }, next)
  eq('turn>1 不注入', later.messages.length, 1)

  // ---- 第一轮：轮末刷新
  sessionEvent({ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '把演示项目做完' }] } })
  sessionEvent({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '先建骨架' }] } } })
  sessionEvent({ type: 'tool/call', data: { name: 'write', arguments: JSON.stringify({ file_path: join(work, '骨架.md') }) } })
  sessionEvent({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await sleep(150)

  const files = readdirSync(outDir)
  eq('轮末生成 1 个交接单', files.length, 1)
  const handoffPath = join(outDir, files[0])
  includes('文件名带本轮任务', files[0], '把演示项目做完')
  const first = readFileSync(handoffPath, 'utf8')
  eq('九个标题齐全', SECTIONS.filter((section) => first.includes(section)).length, 9)
  includes('含用户原话', first, '把演示项目做完')
  includes('含机器标记', first, `session=${session.id}`)
  includes('含确定性稿标记', first, '确定性稿')

  const firstMtime = statSync(handoffPath).mtimeMs
  await sleep(20)

  // ---- 第二轮：新任务 -> 新建一份，历史保留
  sessionEvent({ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '再补一张图' }] } })
  sessionEvent({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '图已补上' }] } } })
  sessionEvent({ type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
  await sleep(150)

  const files2 = readdirSync(outDir)
  eq('第二轮新建一份（保留历史）', files2.length, 2)
  const secondName = files2.find((name) => name.includes('再补一张图'))
  check('第二份文件名带新任务', Boolean(secondName), files2.join(' | '))
  const secondPath = join(outDir, secondName)
  const second = readFileSync(secondPath, 'utf8')
  includes('第二轮内容已刷新', second, '图已补上')
  check('第一份 mtime 未被改动', statSync(handoffPath).mtimeMs === firstMtime)

  // ---- 回归：插件中途加载/热重载后，本轮可能没有用户消息但有工具调用 -> 仍然必须出单
  sessionEvent({ type: 'tool/call', data: { name: 'ops_bash', arguments: JSON.stringify({ command: 'ls D:\\DSH' }) } })
  sessionEvent({ type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } })
  await sleep(150)
  const files3 = readdirSync(outDir)
  eq('第三轮再新建一份', files3.length, 3)
  const thirdName = files3.find((name) => name.includes('ops_bash'))
  check('无用户消息时用工具名命名', Boolean(thirdName), files3.join(' | '))
  const thirdPath = join(outDir, thirdName)
  const third = readFileSync(thirdPath, 'utf8')
  includes('无用户消息但有工具调用仍刷新', third, '第 3 轮')
  check('第三轮与第二轮内容不同', third !== second)

  // ---- 空轮（只有 turn/end，没有任何活动）跳过并记录原因
  sessionEvent({ type: 'turn/end', data: { turn: 4, reason: { kind: 'completed' } } })
  await sleep(120)
  eq('空轮不写文件', readdirSync(outDir).length, 3)

  // ---- 命令
  const status = await commands[0].handler({ agent: { session }, rawInput: 'status' })
  eq('命令 status 成功', status.kind, 'success')
  const statusJson = JSON.parse(status.text)
  eq('status.filePath 为最新落盘路径', statusJson.filePath, thirdPath)
  eq('status 报告项目名', statusJson.project, '演示项目')
  eq('status 会话未 off', statusJson.sessionOff, false)
  eq('status 带构建标记', statusJson.build, BUILD)
  eq('status 记录最近一次结果', statusJson.lastResult && statusJson.lastResult.reason, 'empty-turn')
  eq('status 显示确认开关', statusJson.confirmBeforeWrite, false)
  const list = await commands[0].handler({ agent: { session }, rawInput: 'list 5' })
  includes('list 含候选交接单', list.text, candidatePath)
  const cost = await commands[0].handler({ agent: { session }, rawInput: 'cost' })
  eq('cost 成功', cost.kind, 'success')
  const read = await commands[0].handler({ agent: { session }, rawInput: `read ${thirdPath}` })
  includes('read 含表头项目', read.text, '演示项目')
  const manual = await commands[0].handler({ agent: { session }, rawInput: '' })
  eq('空参数=立即刷新', manual.kind, 'success')
  includes('立即刷新改写同一份', manual.text, thirdPath)
  eq('手动刷新不新增文件', readdirSync(outDir).length, 3)

  // ---- off 后不再自动刷新
  const off = await commands[0].handler({ agent: { session }, rawInput: 'off' })
  includes('off 提示', off.text, '停用')
  const mtimeBefore = statSync(handoffPath).mtimeMs
  await sleep(20)
  sessionEvent({ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '这条不该触发刷新' }] } })
  sessionEvent({ type: 'turn/end', data: { turn: 5, reason: { kind: 'completed' } } })
  await sleep(120)
  eq('off 后文件未变', statSync(handoffPath).mtimeMs, mtimeBefore)
  const on = await commands[0].handler({ agent: { session }, rawInput: 'on' })
  includes('on 提示', on.text, '恢复')

  // ---- 工具
  const toolResult = JSON.parse(await tools[0].execute({ action: 'write' }, { agent: { session } }))
  eq('工具 write 成功', toolResult.ok, true)
  check('工具 write 回路径', typeof toolResult.path === 'string' && toolResult.path.endsWith('交接单.md'), toolResult.path)
  eq('工具写入新一份', readdirSync(outDir).length, 4)
  eq('工具 write 模式', toolResult.mode, 'deterministic')

  // ---- session 关闭清理
  emit('session/disposed', session)
  eq('session/disposed 清状态', service.states.get(session), undefined)
  service.dispose()
  eq('无 warn 日志', logs.filter(([level]) => level === 'warn').length, 0)
}

try {
  await main()
} catch (error) {
  check('smoke 未抛异常', false, error && error.stack ? error.stack.split('\n')[0] : String(error))
  console.error(error)
} finally {
  rmSync(work, { recursive: true, force: true })
}

summary('smoke')
