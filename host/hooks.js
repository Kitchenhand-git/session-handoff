// 四个监听器。每条都遵守故障隔离硬约束：
//   1) 内部 try/catch，绝不把异常抛回 DSH（agent/created 抛错=会话创建失败，pre-step 抛错=step 失败）
//   2) agent/created 只做有界、同步、本地的事（扫描目录，缓存 10s），不 await、不读文件内容、不调模型
//   3) agent/pre-step 只 await next() 后拼字符串，无 I/O
//
// createUserMessage 用「可选依赖」方式引入；拿不到时用本地等价实现兜底。
// 注意：宿主插件运行期并不保证能裸解析 `@deepseek-ai/dsh-llm`（真机上拿到的是 undefined），
// 所以本地兜底才是常态路径，import 成功只是锦上添花。兜底实现与 dsh-llm 同构：
//   deepFreeze(structuredClone({ ...input, id: randomUUID(), role: 'user' }))
import { randomUUID } from 'node:crypto'
import { errorText } from './safe.js'

let defaultCreateUserMessage
try {
  const mod = await import('@deepseek-ai/dsh-llm')
  defaultCreateUserMessage = mod.createUserMessage
} catch {
  defaultCreateUserMessage = undefined
}

/** 与 `@deepseek-ai/dsh-llm` 的 createUserMessage 同构的本地实现（无宿主依赖）。 */
export function builtinCreateUserMessage(input) {
  return Object.freeze(structuredClone({ ...input, id: randomUUID(), role: 'user' }))
}

/**
 * @param ctx - 插件上下文
 * @param service - HandoffService
 * @param deps - 可选依赖注入（测试用）：{ createUserMessage }
 */
export function registerHandoffHooks(ctx, service, deps = {}) {
  const logger = service.logger
  const createUserMessage = deps.createUserMessage || defaultCreateUserMessage || builtinCreateUserMessage
  const factoryName = deps.createUserMessage ? 'injected' : defaultCreateUserMessage ? 'dsh-llm' : 'builtin'
  service.noteResumeFactory(factoryName)

  // 1) 会话事件：缓冲本轮 + turn/end 触发刷新
  ctx.effect(() => ctx.on('session/event', (session, event) => {
    try {
      if (!session || !event) return
      service.bufferEvent(session, event)
      // 用户自己开口了：收起上一轮的「要不要生成交接单」卡片（不影响新一轮）
      if (event.type === 'user/message' && event.data && event.data.source && event.data.source.kind === 'user') {
        service.abortAsk(session, 'superseded')
      }
      if (event.type === 'turn/end') service.onTurnEnd(session)
    } catch (error) {
      logger.warn('session/event 处理失败：%s', errorText(error))
    }
  }))

  // 2) 会话关闭：清掉该会话的定时器与缓冲
  ctx.effect(() => ctx.on('session/disposed', (session) => {
    try {
      if (session && session.id !== undefined) {
        service.abortAsk(session, 'session-disposed')
        service.states.delete(session.id)
      }
    } catch (error) {
      logger.warn('session/disposed 清理失败：%s', errorText(error))
    }
  }))

  // 3) 新会话创建：记录来源（诊断用）；startup 时先算好候选交接单（有界同步扫描，失败就当没有）
  ctx.effect(() => ctx.on('agent/created', (payload) => {
    try {
      const agent = payload && payload.agent
      const source = payload && payload.source
      if (!agent || !agent.session) return
      const state = service.states.get(agent.session, true)
      if (!state) return
      state.agent = agent
      state.createdSource = String(source || '')
      state.startup = source === 'startup'
      if (!state.startup) return
      state.candidateScanned = true
      state.candidate = service.config.newSessionAsk ? service.latestCandidate() : undefined
    } catch (error) {
      logger.warn('agent/created 预扫描失败：%s', errorText(error))
    }
  }))

  // 4) 第一个 step：把续作提示塞进本步消息（waterfall，任何异常都退化为原决策）
  //
  // 触发条件只看「这是不是本会话的第一个 step」（turn=1 且 step=1），不再依赖
  // `agent/created` 的 source：插件中途加载/热重载时 created 已经错过了，
  // 旧写法会静默失效。子会话（subagent）一律不注入。
  ctx.effect(() => ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    try {
      if (!decision || decision.kind !== 'enter') return decision
      const agent = payload && payload.agent
      const step = payload && payload.step
      const turn = payload && payload.turn
      if (agent && agent.session) {
        service.rememberAgent(agent.session, agent)
        service.notePreStep(agent.session, { turn, step })
      }
      if (step !== 1) return decision
      if (turn !== undefined && Number(turn) > 1) return decision
      if (!agent || !agent.session) return decision
      const header = agent.session.header || {}
      if (header.origin === 'subagent' || Number(header.delegationDepth) > 0) return decision
      if (typeof createUserMessage !== 'function') {
        service.noteResumeReason(agent.session, 'no-createUserMessage')
        return decision
      }
      const note = service.takeResumeNote(agent.session, { firstStep: true })
      if (!note) return decision
      const message = createUserMessage({
        content: [{ type: 'text', text: note.text }],
        source: {
          kind: 'session-handoff',
          form: 'notice',
          summary: `续作：${note.project}`,
        },
      })
      logger.info('已向新会话注入续作提示（项目 %s）', note.project)
      return { ...decision, messages: [...decision.messages, message] }
    } catch (error) {
      logger.warn('注入续作提示失败（不影响本轮）：%s', errorText(error))
      return decision
    }
  }))

  // 5) agent 销毁：清引用并收起未决询问
  ctx.effect(() => ctx.on('agent/disposed', (payload) => {
    try {
      const agent = payload && payload.agent
      if (agent && agent.session) service.forgetAgent(agent.session)
    } catch (error) {
      logger.warn('agent/disposed 清理失败：%s', errorText(error))
    }
  }))

  // 6) 插件卸载：清定时器/控制器（service.dispose 只做内存清理，不抛）
  ctx.effect(() => () => {
    try {
      service.dispose()
    } catch {
      /* 卸载路径不再抛 */
    }
  })
}
