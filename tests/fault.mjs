// 故障注入：模型抛错、目录不可写、依赖缺失、脏事件、注入失败——全部不抛异常。
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SECTIONS, renderSkeleton } from '../host/template.js'
import { loadConfig } from '../host/config.js'
import { HandoffService } from '../host/service.js'
import { registerHandoffHooks } from '../host/hooks.js'
import { getLlm, resolveRoute, summarize } from '../host/summarizer.js'
import { clip, oneLine, safe } from '../host/safe.js'
import { check, eq, includes, sleep, summary } from './_harness.mjs'

const work = mkdtempSync(join(tmpdir(), 'handoff-fault-'))
const logs = []

function makeCtx(overrides = {}) {
  const handlers = new Map()
  return {
    handlers,
    ctx: {
      logger: {
        info: () => {},
        warn: (...args) => logs.push(args.join(' ')),
        error: (...args) => logs.push(args.join(' ')),
        debug: () => {},
      },
      get: (name) => (name === 'workingDirectory' ? { get: () => overrides.cwd || work } : undefined),
      on: (name, fn) => { handlers.set(name, fn); return () => handlers.delete(name) },
      effect: (fn) => { const value = fn(); return typeof value === 'function' ? value : () => {} },
      commands: { register: () => () => {} },
      tools: { register: () => () => {} },
      llm: overrides.llm,
    },
  }
}

function makeSession(id, cwd) {
  return { id, header: { createdAt: Date.now(), cwd }, requestHeader: () => undefined }
}

async function main() {
  // ---- 配置容错
  const bad = loadConfig({ debounceMs: 'abc', summaryMode: 'nonsense', searchRoots: [1, ''], enabled: 'maybe', maxAgeDays: 99999 })
  check('非法配置产生警告', bad.warnings.length >= 4, String(bad.warnings.length))
  eq('debounceMs 回落默认', bad.config.debounceMs, 1500)
  eq('summaryMode 回落 llm', bad.config.summaryMode, 'llm')
  eq('searchRoots 回落默认', bad.config.searchRoots.length, 1)
  eq('enabled 回落默认', bad.config.enabled, true)
  eq('maxAgeDays 夹到上界', bad.config.maxAgeDays, 3650)
  const nullConfig = loadConfig(undefined)
  eq('无配置也有默认值', nullConfig.config.newSessionAsk, true)

  // ---- 小工具
  eq('clip 小上限不超长', clip('abcdef', 4).length <= 4, true)
  check('clip 大上限带省略提示', clip('a'.repeat(200), 40).includes('+'), clip('a'.repeat(200), 40))
  eq('oneLine 压成一行', oneLine('a\nb\t c'), 'a b c')
  eq('safe 捕获同步异常', safe({ warn: () => {} }, 'x', () => { throw new Error('boom') }, 'fallback'), 'fallback')
  eq('safe 捕获异步异常', await safe({ warn: () => {} }, 'x', async () => { throw new Error('boom') }, 'fallback'), 'fallback')

  // ---- summarizer：无 llm / 无路由 / 抛错
  const { ctx: bareCtx } = makeCtx()
  eq('无 llm 时 getLlm 返回 null', getLlm(bareCtx), null)
  eq('无 llm 时 resolveRoute 返回 null', await resolveRoute(null, loadConfig({}).config, undefined), null)
  eq('无 llm 时 summarize 返回 null', await summarize({ llm: null, route: null, previous: '', digest: 'x', skeleton: 'y' }), null)

  const throwingLlm = {
    listProviders: async () => [{ id: 'p1' }],
    listModels: async () => [{ id: 'm1' }],
    stream: () => {
      throw new Error('adapter exploded')
    },
  }
  const route = await resolveRoute(throwingLlm, loadConfig({}).config, undefined)
  eq('路由解析成功', route, { provider: 'p1', model: 'm1' })
  eq('stream 抛错时 summarize 返回 null', await summarize({ llm: throwingLlm, route, previous: '', digest: 'x', skeleton: 'y' }), null)

  const badOutputLlm = {
    listProviders: async () => [{ id: 'p1' }],
    listModels: async () => [{ id: 'm1' }],
    async *stream() {
      yield { type: 'text-delta', text: '这不是交接单，只是废话' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  eq('结构不合规时 summarize 返回 null', await summarize({ llm: badOutputLlm, route, previous: '', digest: 'x', skeleton: 'y' }), null)

  // 合法输出：去围栏 + 锚点齐全时接受，且 facts 进入提示词
  let capturedUser = ''
  const goodLlm = {
    listProviders: async () => [{ id: 'p1' }],
    listModels: async () => [{ id: 'm1' }],
    async *stream(options) {
      capturedUser = options.messages[1].content[0].text
      yield { type: 'text-delta', text: '```markdown\n# 交接单：测试\n\n## 1. 一句话状态\nok\n## 5. 没做完的\n无\n## 9. 新会话开工三步\n1. 开工\n```' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const refined = await summarize({
    llm: goodLlm,
    route,
    previous: '上一版内容',
    digest: '本轮摘要',
    facts: '项目：演示项目',
    skeleton: renderSkeleton(),
  })
  check('合规输出被接受', refined && refined.text.startsWith('# 交接单'), JSON.stringify(refined && refined.text.slice(0, 20)))
  check('去掉了代码围栏', refined && !refined.text.includes('```'), 'fence left')
  check('facts 进入提示词', capturedUser.includes('项目：演示项目'), capturedUser.slice(0, 80))
  check('上一版进入提示词', capturedUser.includes('上一版内容'), 'previous missing')

  // ---- 目录不可写：写失败不抛
  const outBad = join(work, 'bad', 'out')
  const { ctx } = makeCtx({ cwd: work })
  const config = loadConfig({ debounceMs: 5, summaryMode: 'deterministic', outputDir: 'Z:\\definitely\\not\\writable', minTurnEvents: 1 }).config
  const service = new HandoffService(ctx, config, ctx.logger)
  const session = makeSession('fail1111-2222', work)
  service.bufferEvent(session, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'x' }] } })
  service.states.get(session).pending = [{ records: service.states.get(session).records, turn: 1 }]
  const failed = await service.run(session, { reason: 'command' })
  eq('写盘失败返回 ok:false', failed.ok, false)
  eq('写盘失败原因', failed.reason, 'write-failed')
  service.dispose()

  // ---- summaryMode=llm + 模型抛错：仍写确定性稿
  const { ctx: ctx2 } = makeCtx({ cwd: join(work, 'proj'), llm: throwingLlm })
  const outOk = join(work, 'proj', '交接')
  const config2 = loadConfig({ debounceMs: 5, summaryMode: 'llm', outputDir: outOk, minTurnEvents: 1, confirmBeforeWrite: false, askDelayMs: 0 }).config
  const service2 = new HandoffService(ctx2, config2, ctx2.logger)
  const session2 = makeSession('llm22222-3333', join(work, 'proj'))
  service2.bufferEvent(session2, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '写点东西' }] } })
  service2.onTurnEnd(session2)
  await sleep(120)
  const written = readdirSync(outOk)
  eq('模型失败仍出文件', written.length, 1)
  includes('模型失败时用确定性稿', readFileSync(join(outOk, written[0]), 'utf8'), '确定性稿')
  check('降级被记录', service2.states.get(session2).degraded.length >= 1)
  service2.dispose()

  // ---- 监听器容错
  const { ctx: ctx3, handlers } = makeCtx({ cwd: work })
  const service3 = new HandoffService(ctx3, loadConfig({ summaryMode: 'deterministic', outputDir: join(work, 'h3'), minTurnEvents: 1 }).config, ctx3.logger)
  const throwingFactory = () => {
    throw new Error('createUserMessage unavailable')
  }
  registerHandoffHooks(ctx3, service3, { createUserMessage: throwingFactory })
  const session3 = makeSession('hook3333-4444', work)
  mkdirSync(join(work, '项目', 'P', '交接'), { recursive: true })
  writeFileSync(join(work, '项目', 'P', '交接', '20261101-1000-11112222-交接单.md'), '# 交接单：x\n', 'utf8')
  service3.config.searchRoots = [join(work, '项目')]

  // 脏事件不抛
  handlers.get('session/event')(undefined, undefined)
  handlers.get('session/event')(session3, { type: 'unknown/type', data: {} })
  handlers.get('session/event')(session3, { type: 'tool/result', data: { message: { isError: true, content: [] }, error: { code: 'E' } } })
  check('脏事件后仍存活', true)

  // agent/created 非 startup 不预扫描
  handlers.get('agent/created')({ agent: { session: session3 }, source: 'resume' })
  check('resume 不设 startup', service3.states.get(session3).startup === false)

  // pre-step：next 返回 reject 原样返回
  const rejected = await handlers.get('agent/pre-step')({ agent: { session: session3 }, step: 1 }, async () => ({ kind: 'reject' }))
  eq('reject 决策原样返回', rejected.kind, 'reject')

  // pre-step：注入工厂抛错 -> 返回原决策，不抛
  handlers.get('agent/created')({ agent: { session: session3 }, source: 'startup' })
  const original = { kind: 'enter', messages: [{ role: 'user' }] }
  const kept = await handlers.get('agent/pre-step')({ agent: { session: session3 }, step: 1 }, async () => original)
  eq('注入失败时返回原决策', kept.messages.length, 1)
  check('注入失败写入 warn', logs.some((line) => line.includes('注入续作提示失败')), logs.slice(-3).join(' | '))

  // 候选被删后 takeResumeNote 不抛
  const session4 = makeSession('hook4444-5555', work)
  handlers.get('agent/created')({ agent: { session: session4 }, source: 'startup' })
  rmSync(join(work, '项目'), { recursive: true, force: true })
  const note = service3.takeResumeNote(session4)
  check('候选消失后不抛', note === undefined || typeof note.text === 'string')
  service3.dispose()

  // ---- 轮次推断：中途加载插件时 state.turn=0，应从会话事件里补上
  const { ctx: ctx4 } = makeCtx({ cwd: join(work, 'proj4') })
  const out4 = join(work, 'proj4', '交接')
  const config4 = loadConfig({ summaryMode: 'deterministic', outputDir: out4, minTurnEvents: 1 }).config
  const service4 = new HandoffService(ctx4, config4, ctx4.logger)
  const sessionTurn = makeSession('turn5555-6666', join(work, 'proj4'))
  sessionTurn.ownEvents = () => [
    { type: 'turn/start', data: { turn: 6 } },
    { type: 'turn/start', data: { turn: 7 } },
  ]
  eq('inferTurn 取最后一个轮次', service4.inferTurn(sessionTurn), 7)
  eq('inferTurn 无 ownEvents 返回 0', service4.inferTurn({}), 0)
  service4.bufferEvent(sessionTurn, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '第七轮' }] } })
  const result4 = await service4.run(sessionTurn, { reason: 'command' })
  eq('命令路径生成成功', result4.ok, true)
  includes('交接单用推断出的轮次', readFileSync(result4.path, 'utf8'), '第 7 轮')
  service4.dispose()

  await sleep(20)
  console.log(`\nwarn 日志条数：${logs.length}`)
}

try {
  await main()
} finally {
  rmSync(work, { recursive: true, force: true })
}

summary('fault')
