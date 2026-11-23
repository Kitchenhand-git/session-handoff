// 轮末先问后写：确认、拒绝、超时、无通道、被打断、命令路径不问。
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadConfig } from '../host/config.js'
import { HandoffService } from '../host/service.js'
import { registerHandoffHooks } from '../host/hooks.js'
import { registerHandoffCommands } from '../host/commands.js'
import { check, eq, includes, sleep, summary } from './_harness.mjs'

const work = mkdtempSync(join(tmpdir(), 'handoff-ask-'))
const projectDir = join(work, '项目', '演示项目')
const outDir = join(projectDir, '交接')

function makeCtx(userQuestions) {
  const handlers = new Map()
  const logs = []
  const commands = []
  const ctx = {
    logger: {
      info: (...args) => logs.push(['info', args.join(' ')]),
      warn: (...args) => logs.push(['warn', args.join(' ')]),
      error: (...args) => logs.push(['error', args.join(' ')]),
      debug: () => {},
    },
    get: (name) => {
      if (name === 'workingDirectory') return { get: () => projectDir }
      if (name === 'userQuestions') return userQuestions
      if (name === 'agents') return undefined
      return undefined
    },
    on: (name, fn) => {
      handlers.set(name, fn)
      return () => handlers.delete(name)
    },
    effect: (fn) => {
      const disposer = fn()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    commands: { register: (def) => { commands.push(def); return () => {} } },
    tools: { register: () => () => {} },
    llm: undefined,
  }
  return { ctx, handlers, logs, commands }
}

function makeSession(id, cwd) {
  return { id, header: { createdAt: Date.now(), cwd }, requestHeader: () => undefined }
}

function makeConfig(extra = {}) {
  const { config } = loadConfig({
    debounceMs: 5,
    summaryMode: 'deterministic',
    outputDir: outDir,
    minTurnEvents: 1,
    confirmBeforeWrite: true,
    askDelayMs: 0,
    ...extra,
  })
  return config
}

function seed(service, session) {
  const state = service.states.get(session, true)
  state.agent = { id: 'agent-1', session }
  state.lastUserMessageAt = 0
  state.pending = [
    {
      records: [
        { type: 'user', text: '把交接单改成先问后写' },
        { type: 'assistant', text: '好' },
        { type: 'turn-end', reason: { kind: 'completed' } },
      ],
      turn: 1,
      dropped: 0,
    },
  ]
}

/** 立刻作答的假 userQuestions：记录收到的请求。 */
function answering(label) {
  const calls = []
  const service = {
    calls,
    ask: async (request) => {
      calls.push(request)
      return { answers: request.questions.map((question) => ({ id: question.id, selected: [label] })) }
    },
  }
  return service
}

async function main() {
  // ---- 1) 同意 -> 写盘，文件名带任务，问题里带建议文件名
  {
    const uq = answering('生成本轮交接单')
    const { ctx } = makeCtx(uq)
    const service = new HandoffService(ctx, makeConfig(), ctx.logger)
    const session = makeSession('ask11111-2222', projectDir)
    seed(service, session)
    const result = await service.enqueue(session, { reason: 'turn-end' })
    eq('同意后生成成功', result.ok, true)
    eq('只问了一次', uq.calls.length, 1)
    const question = uq.calls[0].questions[0]
    eq('问题带 header', question.header, '交接单')
    includes('问题里提示文件名', question.question, '先问后写')
    eq('问题有两个选项', question.options.length, 2)
    const files = readdirSync(outDir)
    eq('落盘一份', files.length, 1)
    includes('文件名带任务片段', files[0], '把交接单改成先问后写')
    includes('正文含用户原话', readFileSync(join(outDir, files[0]), 'utf8'), '把交接单改成先问后写')
    eq('lastAsk 记录同意', service.states.get(session).ask.outcome, 'accepted')
    service.dispose()
  }

  // ---- 2) 拒绝 -> 不写
  {
    const uq = answering('本轮不生成')
    const { ctx } = makeCtx(uq)
    const service = new HandoffService(ctx, makeConfig(), ctx.logger)
    const session = makeSession('ask22222-3333', projectDir)
    seed(service, session)
    const before = readdirSync(outDir).length
    const result = await service.enqueue(session, { reason: 'turn-end' })
    eq('拒绝后不生成', result.ok, false)
    eq('拒绝原因', result.reason, 'declined')
    eq('拒绝不写文件', readdirSync(outDir).length, before)
    eq('lastResult 记录 declined', service.states.get(session).lastResult.reason, 'declined')
    eq('lastAsk 记录拒绝', service.states.get(session).ask.outcome, 'declined')
    service.dispose()
  }

  // ---- 3) 超时 -> 不写，且不抛
  {
    const uq = {
      ask: (request) => new Promise((resolve, reject) => {
        request.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { code: 'ASK_ABORTED' })))
      }),
    }
    const { ctx } = makeCtx(uq)
    const config = makeConfig()
    config.askTimeoutMs = 40
    const service = new HandoffService(ctx, config, ctx.logger)
    const session = makeSession('ask33333-4444', projectDir)
    seed(service, session)
    const before = readdirSync(outDir).length
    const result = await service.enqueue(session, { reason: 'turn-end' })
    eq('超时不生成', result.reason, 'ask-timeout')
    eq('超时不写文件', readdirSync(outDir).length, before)
    service.dispose()
  }

  // ---- 4) 没有 userQuestions（headless）-> 不写、不抛
  {
    const { ctx } = makeCtx(undefined)
    const service = new HandoffService(ctx, makeConfig(), ctx.logger)
    const session = makeSession('ask44444-5555', projectDir)
    seed(service, session)
    const before = readdirSync(outDir).length
    const result = await service.enqueue(session, { reason: 'turn-end' })
    eq('无通道时跳过', result.reason, 'no-answerer')
    eq('无通道不写文件', readdirSync(outDir).length, before)
    service.dispose()
  }

  // ---- 5) 用户发新消息 -> 收起询问、不写
  {
    const uq = {
      ask: (request) => new Promise((resolve, reject) => {
        request.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { code: 'ASK_ABORTED' })))
      }),
    }
    const { ctx, handlers } = makeCtx(uq)
    const service = new HandoffService(ctx, makeConfig(), ctx.logger)
    const session = makeSession('ask55555-6666', projectDir)
    registerHandoffHooks(ctx, service)
    seed(service, session)
    const before = readdirSync(outDir).length
    const pending = service.enqueue(session, { reason: 'turn-end' })
    await sleep(30)
    handlers.get('session/event')(session, {
      type: 'user/message',
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: '换个话题' }] },
    })
    const result = await pending
    check('新消息打断询问', result.reason === 'ask-cancelled' || result.reason === 'superseded', result.reason)
    eq('打断后不写文件', readdirSync(outDir).length, before)
    service.dispose()
  }

  // ---- 6) 命令路径不问：直接写
  {
    const uq = answering('本轮不生成')
    const { ctx, commands } = makeCtx(uq)
    const service = new HandoffService(ctx, makeConfig(), ctx.logger)
    registerHandoffCommands(ctx, service)
    const session = makeSession('ask66666-7777', projectDir)
    seed(service, session)
    const result = await service.enqueue(session, { reason: 'command' })
    eq('命令不问也生成', result.ok, true)
    eq('命令没触发提问', uq.calls.length, 0)
    const command = await commands[0].handler({ agent: { session }, rawInput: 'ask' })
    eq('/handoff ask 需要提问通道', command.kind === 'error' || command.kind === 'success', true)
    service.dispose()
  }

  // ---- 7) 关掉确认（confirmBeforeWrite:false）恢复自动写
  {
    const uq = answering('本轮不生成')
    const { ctx } = makeCtx(uq)
    const service = new HandoffService(ctx, makeConfig({ confirmBeforeWrite: false }), ctx.logger)
    const session = makeSession('ask77777-8888', projectDir)
    seed(service, session)
    const result = await service.enqueue(session, { reason: 'turn-end' })
    eq('关闭确认后自动写', result.ok, true)
    eq('关闭确认后不提问', uq.calls.length, 0)
    service.dispose()
  }

  // ---- 8) 同一轮重复生成：同名同会话覆盖，不产生副本
  {
    const uq = answering('生成本轮交接单')
    const { ctx } = makeCtx(uq)
    const service = new HandoffService(ctx, makeConfig(), ctx.logger)
    const session = makeSession('ask88888-9999', projectDir)
    seed(service, session)
    const first = await service.enqueue(session, { reason: 'turn-end' })
    const second = await service.enqueue(session, { reason: 'command' })
    eq('重复生成不改文件名', second.path, first.path)
    service.dispose()
  }

  // ---- 9) /handoff ask：还没轮末时也能就当前缓冲发起询问（不清空缓冲）
  {
    const uq = answering('生成本轮交接单')
    const { ctx, commands } = makeCtx(uq)
    const service = new HandoffService(ctx, makeConfig(), ctx.logger)
    registerHandoffCommands(ctx, service)
    const session = makeSession('ask99999-0000', projectDir)
    const state = service.states.get(session, true)
    state.agent = { id: 'agent-9', session }
    service.bufferEvent(session, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '手动问一次' }] } })
    service.bufferEvent(session, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '好' }] } } })
    const result = await commands[0].handler({ agent: { session }, rawInput: 'ask' })
    eq('ask 命令成功', result.kind, 'success')
    eq('ask 命令会提问', uq.calls.length, 1)
    check('缓冲未被清空', service.states.get(session).records.length === 2, String(service.states.get(session).records.length))
    service.dispose()
  }
}

try {
  await main()
} catch (error) {
  check('ask 未抛异常', false, error && error.stack ? error.stack.split('\n')[0] : String(error))
  console.error(error)
} finally {
  rmSync(work, { recursive: true, force: true })
}

summary('ask')
