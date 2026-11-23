// 编排层：事件缓冲 → 轮末生成 → 写盘；新会话候选交接单；命令/工具共用的查询接口。
//
// 全部方法都保证「不抛」：内部异常收敛成 {ok:false, reason}，由调用方决定是否记日志。
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'

import { buildDigest, collectFiles } from './digest.js'
import { BUILD } from './config.js'
import {
  atomicWrite,
  discoverHandoffs,
  localLabel,
  projectDirOf,
  projectNameOf,
  readHandoffHeader,
  resolveHandoffPath,
  resolveOutputDir,
  safeStat,
  taskSlug,
} from './paths.js'
import { SessionStates } from './state.js'
import { renderFooter, renderHandoff, renderResumeNote, renderSkeleton } from './template.js'
import { clip, errorText, oneLine } from './safe.js'
import { getLlm, resolveRoute, summarize } from './summarizer.js'

/** 从 message.content 里取纯文本。 */
function messageText(message) {
  if (!message || !Array.isArray(message.content)) return ''
  const parts = []
  for (const block of message.content) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n').trim()
}

function messageSourceKind(message) {
  if (!message || typeof message.source !== 'object' || message.source === null) return ''
  return typeof message.source.kind === 'string' ? message.source.kind : ''
}

/** 轮末询问的固定选项文案（答案也按这两句判定）。 */
const ACCEPT_LABEL = '生成本轮交接单'
const DECLINE_LABEL = '本轮不生成'

/** 从 ask_user_question 的返回值里取出用户挑的那个选项/自定义答案。 */
function firstAnswerText(answer) {
  const item = answer && Array.isArray(answer.answers) ? answer.answers[0] : undefined
  if (!item) return ''
  if (Array.isArray(item.selected) && item.selected.length > 0) return String(item.selected[0])
  if (typeof item.custom === 'string') return item.custom.trim()
  return ''
}

export class HandoffService {
  constructor(ctx, config, logger) {
    this.ctx = ctx
    this.config = config
    this.logger = logger
    this.states = new SessionStates(config)
    this.candidateCache = { at: 0, value: undefined }
    this.disposed = false
    this.resumeFactory = ''
    this.workingDirectory = (() => {
      try {
        if (typeof ctx.get === 'function') return ctx.get('workingDirectory') || null
      } catch {
        /* 继续 */
      }
      try {
        return ctx.workingDirectory || null
      } catch {
        return null
      }
    })()
  }

  dispose() {
    this.disposed = true
    this.states.disposeAll()
  }

  // ---------------------------------------------------------------- 事件缓冲

  /** 把一条会话事件压成轻量记录；未知类型直接忽略。 */
  bufferEvent(session, event) {
    if (!event || typeof event !== 'object') return
    const state = this.states.get(session, true)
    if (!state) return
    const data = event.data || {}
    try {
      switch (event.type) {
        case 'user/message': {
          const kind = messageSourceKind(data)
          if (kind !== 'user') return // 插件注入的 notice / 系统提示不算用户输入
          state.lastUserMessageAt = Date.now()
          const text = messageText(data)
          if (text) this.states.push(state, { type: 'user', text })
          return
        }
        case 'assistant/message': {
          const text = messageText(data.message)
          if (text) this.states.push(state, { type: 'assistant', text })
          return
        }
        case 'tool/call': {
          this.states.push(state, {
            type: 'tool',
            name: String(data.name || 'tool'),
            args: String(data.arguments || ''),
          })
          return
        }
        case 'tool/result': {
          const message = data.message
          const isError = Boolean(data.error) || Boolean(message && message.isError)
          if (!isError) return
          const text = messageText(message) || (data.error && (data.error.reason || data.error.code)) || '工具失败'
          this.states.push(state, { type: 'error', name: data.name || '', text: String(text) })
          return
        }
        case 'working-directory/change': {
          if (typeof data.cwd === 'string' && data.cwd) state.cwd = data.cwd
          return
        }
        case 'turn/start': {
          if (typeof data.turn === 'number' && data.turn > state.turn) state.turn = data.turn
          return
        }
        case 'turn/end': {
          if (typeof data.turn === 'number' && data.turn > state.turn) state.turn = data.turn
          this.states.push(state, { type: 'turn-end', reason: data.reason })
          return
        }
        default:
          return
      }
    } catch (error) {
      this.logger.warn('缓冲事件失败（%s）：%s', String(event.type), errorText(error))
    }
  }

  /** 取本轮快照并放进 pending，等待去抖后统一生成。 */
  onTurnEnd(session) {
    const state = this.states.get(session, true)
    if (!state) return
    const snapshot = this.states.takeTurn(state)
    if (!Array.isArray(state.pending)) state.pending = []
    state.pending.push(snapshot)
    if (state.pending.length > 20) state.pending.shift()
    this.schedule(session)
  }

  schedule(session) {
    const state = this.states.get(session, true)
    if (!state) return
    this.states.clearTimer(state)
    const delay = this.config.debounceMs
    state.timer = setTimeout(() => {
      state.timer = undefined
      this.enqueue(session, { reason: 'turn-end' })
    }, delay)
    if (state.timer && typeof state.timer.unref === 'function') state.timer.unref()
  }

  /** 每会话串行队列：同一会话的生成永不并发，异常被吞掉只记日志。 */
  enqueue(session, options = {}) {
    const state = this.states.get(session, true)
    if (!state) return Promise.resolve({ ok: false, reason: 'no-state' })
    const next = state.chain.then(() => this.run(session, options)).catch((error) => {
      this.logger.warn('生成交接单失败：%s', errorText(error))
      return { ok: false, reason: 'exception' }
    })
    state.chain = next.then(() => undefined, () => undefined)
    return next
  }

  takePending(state) {
    const pending = Array.isArray(state.pending) ? state.pending : []
    state.pending = []
    const records = []
    let dropped = 0
    let turn = 0
    let reason
    for (const snapshot of pending) {
      dropped += snapshot.dropped || 0
      if (snapshot.turn > turn) turn = snapshot.turn
      for (const record of snapshot.records || []) {
        records.push(record)
        if (record.type === 'turn-end') reason = record.reason
      }
    }
    return { records, dropped, turn, reason }
  }

  /** 会话工作目录：workingDirectory 服务优先，其次事件里记录的 cwd / header.cwd。 */
  resolveCwd(session, state) {
    try {
      if (this.workingDirectory && typeof this.workingDirectory.get === 'function') {
        const value = this.workingDirectory.get(session)
        if (typeof value === 'string' && value) return value
      }
    } catch {
      /* 服务未就绪或未绑定会话：走兜底 */
    }
    if (state.cwd) return state.cwd
    const headerCwd = session && session.header && session.header.cwd
    if (typeof headerCwd === 'string' && headerCwd) return headerCwd
    try {
      return process.cwd()
    } catch {
      return ''
    }
  }

  // ---------------------------------------------------------------- 生成写盘

  async run(session, options = {}) {
    if (this.disposed) return { ok: false, reason: 'disposed' }
    const state = this.states.get(session, true)
    if (!state) return { ok: false, reason: 'no-state' }
    const skip = (reason) => {
      this.noteResult(state, false, reason)
      return { ok: false, reason }
    }

    const isCommand = options.reason === 'command' || options.reason === 'tool'
    const forceAsk = options.reason === 'ask'
    if (!isCommand && !forceAsk && !this.config.turnEndEnabled) return skip('turn-end-disabled')
    if (state.off && !isCommand) return skip('off')
    const origin = session && session.header && session.header.origin
    if (origin === 'subagent') return skip('subagent')

    const merged = this.takePending(state)
    const userCount = merged.records.filter((record) => record.type === 'user').length
    const activity = merged.records.filter((record) => record.type === 'assistant' || record.type === 'tool').length
    // 只有「既没有用户消息、也没有助手正文/工具调用」的空轮才跳过。
    // 插件中途加载、热重载后本轮的用户消息可能不在缓冲里，但这一轮确实干了活，必须照样出单。
    if (!isCommand && userCount === 0 && activity === 0) return skip('empty-turn')
    if (!isCommand && !forceAsk && merged.records.length < this.config.minTurnEvents) return skip('too-few-events')

    const cwd = this.resolveCwd(session, state)
    const project = projectNameOf(cwd)
    const projectDir = projectDirOf(cwd)
    const dir = resolveOutputDir({ cwd, outputDir: this.config.outputDir })
    const at = Date.now()
    const task = taskSlug(merged.records, this.config.nameMaxChars)
    let filePath = resolveHandoffPath({
      dir,
      at,
      task,
      maxChars: this.config.nameMaxChars,
      sessionId: session.id,
    })
    // 手动刷新但本轮没有新内容：改写上一份，而不是新建一个空壳
    if (isCommand && merged.records.length === 0 && state.lastFilePath) filePath = state.lastFilePath

    // 轮末先问后写：只有用户点「生成」才继续；命令/工具（显式指令）直接写。
    if (!isCommand && (this.config.confirmBeforeWrite || forceAsk)) {
      const asked = await this.askBeforeWrite(session, state, {
        task,
        name: basename(filePath),
        takenAt: at,
        turn: merged.turn,
        skipDelay: forceAsk,
      })
      if (!asked.accepted) return skip(asked.reason)
    }

    const files = collectFiles(merged.records, this.config.maxFilesPerFile)
    const digest = buildDigest({ records: merged.records, chars: 0, dropped: merged.dropped, turn: merged.turn, cwd }, {
      maxChars: this.config.maxDigestChars,
      cwd,
      files,
    })

    let previous = ''
    const prevPath = state.lastFilePath && state.lastFilePath !== filePath ? state.lastFilePath : ''
    if (prevPath) {
      try {
        previous = readFileSync(prevPath, 'utf8').slice(0, this.config.maxPrevChars)
      } catch {
        previous = ''
      }
    }

    const turn = merged.turn || state.turn || this.inferTurn(session) || 0
    let text = renderHandoff({
      sessionId: session.id,
      createdAt: state.createdAt,
      mode: 'deterministic',
      project,
      cwd,
      projectDir,
      snapshot: { records: merged.records, turn, dropped: merged.dropped },
      digest,
      turn,
      reason: merged.reason,
      eventCount: merged.records.length,
    })
    let mode = 'deterministic'
    let model = ''

    if (this.config.summaryMode === 'llm') {
      const controller = new AbortController()
      this.states.abort(state)
      state.controller = controller
      const reasonKind = (merged.reason && (merged.reason.kind || merged.reason)) || '未知'
      const facts = [
        `交接时间：${localLabel(Date.now())}`,
        `项目：${project}`,
        `工作目录：${cwd || '未知'}`,
        `项目目录：${projectDir}`,
        `轮次：第 ${turn} 轮结束；结束原因：${reasonKind}`,
        `本轮事件：${merged.records.length} 条；识别到文件路径：${files.length} 个；会话 id：${session.id}`,
      ].join('\n')
      try {
        const llm = getLlm(this.ctx)
        const route = await resolveRoute(llm, this.config, session)
        const refined = await summarize({
          llm,
          route,
          previous,
          digest: digest.text,
          facts,
          skeleton: renderSkeleton(),
          timeoutMs: this.config.timeoutMs,
          signal: controller.signal,
        })
        if (refined) {
          text = `${refined.text}\n${renderFooter({ sessionId: session.id, turn, mode: 'llm' })}\n`
          mode = 'llm'
          model = `${refined.provider}/${refined.model}`
        } else {
          state.degraded.push(localLabel())
          if (state.degraded.length > 20) state.degraded.shift()
        }
      } catch (error) {
        this.logger.warn('润色交接单失败，已用确定性稿：%s', errorText(error))
      } finally {
        state.controller = undefined
      }
    }

    if (this.disposed) return { ok: false, reason: 'disposed' }

    try {
      atomicWrite(filePath, text)
    } catch (error) {
      this.logger.warn('写交接单失败（%s）：%s', filePath, errorText(error))
      this.noteResult(state, false, 'write-failed', { path: filePath })
      return { ok: false, reason: 'write-failed', path: filePath }
    }

    state.filePath = filePath
    state.lastFilePath = filePath
    state.lastWriteAt = Date.now()
    state.lastMode = mode
    this.states.recordCost(state, {
      turn,
      mode,
      at: Date.now(),
      digestChars: digest.text.length,
      previousChars: previous.length,
      outChars: text.length,
      model,
    })
    this.logger.info(
      '交接单已刷新：%s（%s，%d 字，%s）',
      filePath,
      mode,
      text.length,
      model || '未调用模型',
    )
    this.noteResult(state, true, 'written', { path: filePath, mode })
    return {
      ok: true,
      path: filePath,
      mode,
      model,
      turn,
      chars: text.length,
      files: files.length,
      digestChars: digest.text.length,
    }
  }

  // ---------------------------------------------------------------- 轮末询问

  /**
   * 轮末问一次「要不要生成」。不阻塞对话：在 turn/end 之后的后台队列里等，
   * 用户不答（超时 / 关掉卡片 / 直接发下一句）就当作不生成。
   * @returns {Promise<{accepted: boolean, reason: string}>}
   */
  async askBeforeWrite(session, state, proposal) {
    const decide = (accepted, reason) => {
      this.noteAsk(state, {
        outcome: reason,
        proposedName: proposal.name,
        task: proposal.task,
        turn: proposal.turn,
      })
      return { accepted, reason }
    }

    // 给用户先打字的窗口；期间发了新消息就不问了（「不影响本轮结束」）
    const delay = proposal.skipDelay ? 0 : this.config.askDelayMs
    if (delay > 0) {
      await new Promise((resolve) => {
        setTimeout(resolve, delay)
      })
      if (state.lastUserMessageAt > proposal.takenAt) return decide(false, 'superseded')
      if (this.disposed) return decide(false, 'disposed')
      if (state.off) return decide(false, 'off')
    }

    let uq
    try {
      uq = typeof this.ctx.get === 'function' ? this.ctx.get('userQuestions') : undefined
    } catch {
      uq = undefined
    }
    if (!uq || typeof uq.ask !== 'function') return decide(false, 'no-answerer')

    const agent = state.agent
    if (!agent || !agent.session) return decide(false, 'no-agent')
    try {
      const agents = this.ctx.get('agents')
      if (agents && typeof agents.get === 'function' && agents.get(agent.id) !== agent) {
        return decide(false, 'no-agent')
      }
    } catch {
      /* 校验不了就继续，uq.ask 内部还会再校验一次 */
    }

    const controller = new AbortController()
    state.askController = controller
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try {
        controller.abort(new Error('ask-timeout'))
      } catch {
        /* 忽略 */
      }
    }, this.config.askTimeoutMs)

    try {
      const answer = await uq.ask({
        agent,
        questions: [
          {
            id: 'handoff-write',
            header: '交接单',
            question: `本轮对话结束，要生成交接单吗？（${proposal.name}）`,
            options: [{ label: ACCEPT_LABEL, description: proposal.name }, { label: DECLINE_LABEL }],
          },
        ],
        signal: controller.signal,
      })
      const picked = firstAnswerText(answer)
      if (picked === DECLINE_LABEL) return decide(false, 'declined')
      if (picked === ACCEPT_LABEL) return decide(true, 'accepted')
      if (picked && picked.includes('生成') && !picked.includes('不生成')) return decide(true, 'accepted')
      return decide(false, 'declined')
    } catch (error) {
      if (timedOut) return decide(false, 'ask-timeout')
      if (controller.signal.aborted) return decide(false, 'ask-cancelled')
      const code = error && error.code ? String(error.code) : ''
      this.logger.warn('轮末询问失败（%s）：%s', code || 'unknown', errorText(error))
      return decide(false, 'no-answerer')
    } finally {
      clearTimeout(timer)
      if (state.askController === controller) state.askController = undefined
    }
  }

  /** 记下会话的 live agent 引用（轮末询问要用它作为提问的 owner）。 */
  rememberAgent(session, agent) {
    const state = this.states.get(session, true)
    if (state && agent) state.agent = agent
  }

  /** agent 销毁：清引用并打断未决询问。 */
  forgetAgent(session) {
    const state = this.states.get(session)
    if (state) state.agent = undefined
    this.abortAsk(session, 'agent-disposed')
  }

  /** /handoff ask 用：把当前已缓冲但还没轮末的内容也纳入本次询问（复制，不清空缓冲）。 */
  prepareAsk(session) {
    const state = this.states.get(session, true)
    if (!state) return
    if (Array.isArray(state.pending) && state.pending.length > 0) return
    if (!Array.isArray(state.records) || state.records.length === 0) return
    state.pending = [
      { records: state.records.slice(), chars: state.chars, dropped: state.dropped, turn: state.turn, cwd: state.cwd },
    ]
  }

  /** 中途打断未决询问（用户发了新消息 / 会话或 agent 销毁）。 */
  abortAsk(session, reason) {
    const state = this.states.get(session)
    if (!state || !state.askController) return false
    try {
      state.askController.abort(new Error(String(reason || 'ask-cancelled')))
    } catch {
      /* 忽略 */
    }
    return true
  }

  /** 记录最近一次轮末询问的结果，供 /handoff status 诊断。 */
  noteAsk(state, info) {
    if (!state) return
    state.ask = { at: Date.now(), label: localLabel(Date.now()), ...info }
  }

  /** 记录最近一次生成的结果（含被跳过的原因），供 /handoff status 诊断。 */
  noteResult(state, ok, reason, extra = {}) {
    if (!state) return
    state.lastResult = { ok, reason, at: Date.now(), label: localLabel(Date.now()), ...extra }
  }

  /** 从会话事件里推断最后一个轮次（中途加载插件 / 恢复旧会话时 state.turn 为 0）。纯内存，有界。 */
  inferTurn(session) {
    try {
      if (!session || typeof session.ownEvents !== 'function') return 0
      const events = session.ownEvents()
      if (!Array.isArray(events)) return 0
      for (let index = events.length - 1, seen = 0; index >= 0 && seen < 200; index -= 1, seen += 1) {
        const data = events[index] && events[index].data
        if (data && typeof data.turn === 'number' && data.turn > 0) return data.turn
      }
    } catch {
      /* 会话已释放：当作不知道 */
    }
    return 0
  }

  // ---------------------------------------------------------------- 新会话候选

  /** 最近一份交接单（进程内缓存 10s，避免每个新会话都扫盘）。 */
  latestCandidate() {
    const now = Date.now()
    if (now - this.candidateCache.at < this.config.candidateCacheMs) return this.candidateCache.value
    let value
    try {
      value = discoverHandoffs({
        searchRoots: this.config.searchRoots,
        maxAgeDays: this.config.maxAgeDays,
        now,
      })[0]
    } catch (error) {
      this.logger.warn('发现候选交接单失败：%s', errorText(error))
      value = undefined
    }
    this.candidateCache = { at: now, value }
    return value
  }

  /**
   * 新会话第一个 step 要注入的提示文本（纯内存，无 I/O）。
   * 只对 `agent/created` 且 source==='startup' 的会话生效；每个会话只返回一次。
   * @returns {{text: string, project: string} | undefined}
   */
  takeResumeNote(session, opts = {}) {
    const state = this.states.get(session, true)
    if (!state) return undefined
    if (state.adopted || state.off) return undefined
    if (!this.config.newSessionAsk || !this.config.enabled) {
      state.adopted = true
      state.resumeReason = 'disabled'
      return undefined
    }
    // 只有「新开对话」才询问：created 时 source=startup，或第一个 step（turn=1、step=1）。
    // resume / clear / compact 的会话不会落在第一个 step 上，一律不问。
    if (!state.startup && !opts.firstStep) {
      state.adopted = true
      state.resumeReason = `not-new-session:${state.createdSource || 'unknown'}`
      return undefined
    }
    if (!state.candidateScanned) {
      state.candidateScanned = true
      try {
        state.candidate = this.latestCandidate()
      } catch {
        state.candidate = undefined
      }
    }
    const candidate = state.candidate
    if (!candidate || !candidate.path) {
      state.adopted = true
      state.resumeReason = 'no-candidate'
      return undefined
    }
    state.adopted = true
    state.resumeAsked = true
    state.resumeReason = 'asked'
    // 提示里的「项目」优先用交接单表头里写的项目名：候选是按目录推的，
    // 新建会话时目录可能是「其他」，而交接单正文写的是真实项目（如 DSH）。
    let label = candidate.project || '未知'
    try {
      const header = readHandoffHeader(candidate.path)
      if (header && header.project) label = header.project
    } catch {
      /* 读不到表头就用目录名兜底 */
    }
    try {
      return { text: renderResumeNote({ ...candidate, project: label }), project: label }
    } catch (error) {
      this.logger.warn('生成续作提示失败：%s', errorText(error))
      state.resumeReason = 'render-failed'
      return undefined
    }
  }

  /** 记下「为什么没有注入续作提示」（诊断用，只写内存）。 */
  noteResumeReason(session, reason) {
    const state = this.states.get(session, true)
    if (!state) return
    state.adopted = true
    state.resumeReason = String(reason || '')
  }

  /** 记下消息工厂来源（诊断用）：injected / dsh-llm / builtin。 */
  noteResumeFactory(name) {
    this.resumeFactory = String(name || '')
  }

  /** 记下本会话最近见到的 pre-step（诊断用，只留最后 4 条）。 */
  notePreStep(session, info) {
    const state = this.states.get(session, true)
    if (!state) return
    const list = Array.isArray(state.preSteps) ? state.preSteps : []
    list.push({ turn: info && info.turn, step: info && info.step })
    while (list.length > 4) list.shift()
    state.preSteps = list
  }

  // ---------------------------------------------------------------- 查询接口

  status(session) {
    const state = this.states.get(session)
    const candidate = this.latestCandidate()
    const cwd = state ? this.resolveCwd(session, state) : ''
    return {
      build: BUILD,
      enabled: this.config.enabled,
      turnEndEnabled: this.config.turnEndEnabled,
      summaryMode: this.config.summaryMode,
      newSessionAsk: this.config.newSessionAsk,
      confirmBeforeWrite: this.config.confirmBeforeWrite,
      askDelayMs: this.config.askDelayMs,
      askTimeoutMs: this.config.askTimeoutMs,
      sessionOff: Boolean(state && state.off),
      sessionId: session ? String(session.id) : '',
      cwd,
      project: projectNameOf(cwd),
      filePath: state ? state.filePath : undefined,
      lastWriteAt: state && state.lastWriteAt ? localLabel(state.lastWriteAt) : undefined,
      lastMode: state ? state.lastMode : undefined,
      lastResult: state && state.lastResult ? state.lastResult : undefined,
      lastAsk: state && state.ask ? state.ask : undefined,
      degradedCount: state ? state.degraded.length : 0,
      pendingTurns: state && Array.isArray(state.pending) ? state.pending.length : 0,
      resume: state
        ? {
            startup: Boolean(state.startup),
            createdSource: state.createdSource || '',
            asked: Boolean(state.resumeAsked),
            reason: state.resumeReason || '',
            factory: this.resumeFactory || '',
            preSteps: Array.isArray(state.preSteps) ? state.preSteps : [],
          }
        : { factory: this.resumeFactory || '' },
      candidate: candidate ? { path: candidate.path, project: candidate.project, updatedAt: localLabel(candidate.mtime) } : undefined,
      searchRoots: this.config.searchRoots,
    }
  }

  /** 最近的交接单列表（按 mtime 倒序），带表头信息。 */
  listRecent(limit = 10) {
    let list = []
    try {
      list = discoverHandoffs({ searchRoots: this.config.searchRoots, maxAgeDays: this.config.maxAgeDays })
    } catch (error) {
      this.logger.warn('列出交接单失败：%s', errorText(error))
      return []
    }
    return list.slice(0, Math.max(1, limit)).map((item) => ({
      path: item.path,
      project: item.project,
      projectDir: item.projectDir,
      updatedAt: localLabel(item.mtime),
      mtime: item.mtime,
    }))
  }

  readHandoff(path) {
    const info = safeStat(path)
    if (!info) return undefined
    if (info.size > 2_000_000) return undefined
    let text
    try {
      text = readFileSync(path, 'utf8')
    } catch {
      return undefined
    }
    return { path, size: info.size, mtime: info.mtimeMs, header: readHandoffHeader(path), text }
  }

  setOff(session, off) {
    const state = this.states.get(session, true)
    if (!state) return false
    state.off = Boolean(off)
    if (state.off) {
      this.states.clearTimer(state)
      state.pending = []
    }
    return true
  }

  /** 进程内成本账：字符数 + 估算 token。 */
  costSummary(session, limit = 10) {
    const state = session ? this.states.get(session) : undefined
    const entries = state && Array.isArray(state.cost) ? state.cost.slice(-limit) : []
    let digestChars = 0
    let previousChars = 0
    let outChars = 0
    for (const entry of entries) {
      digestChars += entry.digestChars || 0
      previousChars += entry.previousChars || 0
      outChars += entry.outChars || 0
    }
    const inputChars = digestChars + previousChars + 1200 * entries.length
    return {
      rounds: entries.length,
      entries: entries.map((entry) => ({
        turn: entry.turn,
        mode: entry.mode,
        at: localLabel(entry.at),
        digestChars: entry.digestChars,
        previousChars: entry.previousChars,
        outChars: entry.outChars,
        model: entry.model || '',
      })),
      estimate: {
        inputChars,
        outputChars: outChars,
        inputTokens: Math.round(inputChars / 1.8),
        outputTokens: Math.round(outChars / 1.8),
        note: 'token 为按字符数 /1.8 的粗估，只统计本进程内的生成；单价以账号账单为准',
      },
      degraded: state ? state.degraded.slice(-5) : [],
    }
  }

  /** /handoff models：列出可用路由，便于用户指定 provider/model。 */
  async describeModels() {
    const llm = getLlm(this.ctx)
    if (!llm) return { available: false, providers: [], route: null }
    let providers = []
    try {
      providers = (await llm.listProviders?.()) || []
    } catch {
      providers = []
    }
    const summary = []
    for (const entry of providers.slice(0, 10)) {
      const id = typeof entry === 'string' ? entry : entry && (entry.id || entry.provider || entry.name)
      if (!id) continue
      let models = []
      try {
        models = ((await llm.listModels?.(id)) || []).slice(0, 8).map((item) => (typeof item === 'string' ? item : item && (item.id || item.model || item.name)))
      } catch {
        models = []
      }
      summary.push({ provider: id, models: models.filter(Boolean) })
    }
    return { available: summary.length > 0, providers: summary, route: await resolveRoute(llm, this.config) }
  }

  /** 给命令/工具用的一行摘要。 */
  shortStatus(session) {
    const info = this.status(session)
    return `${info.project}${info.filePath ? ` · ${info.filePath}` : ' · 尚无交接单'}`
  }

  /** 安全的一行文本截断（供命令输出用）。 */
  preview(text, max = 400) {
    return clip(oneLine(text), max)
  }
}
