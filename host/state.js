// 每会话运行态：事件缓冲、turn 结束的去抖定时器、串行队列、取消控制器、文件路径复认。
//
// 只用内存：会话是唯一真相，这里是可丢的派生缓存（进程重启后重建即可）。

/** 一条被压扁的缓冲记录。原始事件对象不入库，避免长会话把内存撑爆。 */
export function makeRecord(type, payload) {
  return { type, ...payload }
}

export class SessionStates {
  constructor(config) {
    this.config = config
    this.map = new Map()
  }

  /** 取（必要时创建）某会话的状态。任何异常都不向外抛。 */
  get(session, created = false) {
    const id = session && session.id !== undefined ? String(session.id) : ''
    if (!id) return undefined
    let state = this.map.get(id)
    if (state) return state
    if (!created) return undefined
    state = {
      id,
      createdAt: Number(session && session.header && session.header.createdAt) || Date.now(),
      createdAtKnown: Boolean(session && session.header && session.header.createdAt),
      cwd: '',
      startedAt: Date.now(),
      // 本轮缓冲
      records: [],
      chars: 0,
      dropped: 0,
      turn: 0,
      // 行为开关
      off: false,
      adopted: false,
      startup: false,
      createdSource: '',
      resumeAsked: false,
      resumeReason: '',
      preSteps: [],
      candidate: undefined,
      candidateScanned: false,
      // 轮末询问（先问后写）
      agent: undefined,
      lastFilePath: '',
      ask: undefined,
      askController: undefined,
      // 生成链路
      timer: undefined,
      controller: undefined,
      chain: Promise.resolve(),
      filePath: undefined,
      lastWriteAt: 0,
      lastMode: undefined,
      lastResult: undefined,
      // 成本账（仅本次进程内）
      cost: [],
      degraded: [],
    }
    this.map.set(id, state)
    return state
  }

  /** 追加一条缓冲记录，按条数与字数上限丢弃最旧的。 */
  push(state, record) {
    if (!state) return
    const size = JSON.stringify(record).length
    state.records.push(record)
    state.chars += size
    while (state.records.length > this.config.maxBufferedEvents || state.chars > this.config.maxBufferedChars) {
      const dropped = state.records.shift()
      if (!dropped) break
      state.chars -= JSON.stringify(dropped).length
      state.dropped += 1
    }
  }

  /** 一轮结束：取走本轮记录并重置缓冲，返回快照。 */
  takeTurn(state) {
    const snapshot = {
      records: state.records,
      chars: state.chars,
      dropped: state.dropped,
      turn: state.turn,
      cwd: state.cwd,
    }
    state.records = []
    state.chars = 0
    state.dropped = 0
    return snapshot
  }

  clearTimer(state) {
    if (state && state.timer !== undefined) {
      try {
        clearTimeout(state.timer)
      } catch {
        /* 忽略 */
      }
      state.timer = undefined
    }
  }

  abort(state) {
    if (state && state.controller) {
      try {
        state.controller.abort()
      } catch {
        /* 忽略 */
      }
      state.controller = undefined
    }
  }

  delete(sessionId) {
    const state = this.map.get(String(sessionId))
    if (!state) return
    this.clearTimer(state)
    this.abort(state)
    this.map.delete(String(sessionId))
  }

  /** 插件卸载/session 关闭时清空全部定时器与控制器。 */
  disposeAll() {
    for (const state of this.map.values()) {
      this.clearTimer(state)
      this.abort(state)
    }
    this.map.clear()
  }

  /** 进程内成本账：记录一次生成的输入/输出规模（字符数，token 为估算）。 */
  recordCost(state, entry) {
    if (!state) return
    state.cost.push(entry)
    while (state.cost.length > 50) state.cost.shift()
  }
}
