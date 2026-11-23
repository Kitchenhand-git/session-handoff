// /handoff 命令面：用户与模型之外的手动入口。
import { errorText } from './safe.js'

function splitFirst(rawInput) {
  const text = String(rawInput === undefined || rawInput === null ? '' : rawInput).trim()
  if (text === '') return ['', '']
  const index = text.indexOf(' ')
  if (index === -1) return [text, '']
  return [text.slice(0, index), text.slice(index + 1).trim()]
}

function success(value) {
  return { kind: 'success', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }
}

function failure(error) {
  return { kind: 'error', text: errorText(error) }
}

const USAGE = [
  '/handoff                 立即刷新本会话交接单，返回路径（不询问）',
  '/handoff ask             就本轮内容先问一次「要不要生成」，答「生成」才写',
  '/handoff status          当前开关、落盘位置、模型模式、候选交接单、最近一次询问',
  '/handoff on | off        本会话启用/停用轮末询问（off 后仍可手动 /handoff）',
  '/handoff list [n]        最近 n 份交接单（默认 10）',
  '/handoff read <绝对路径>  查看某份交接单的表头与正文（截断）',
  '/handoff cost [n]        最近 n 轮生成的 token 估算（按字符数粗估）',
  '/handoff models          可用模型路由，便于在配置里指定 provider/model',
].join('\n')

const ASK_REASONS = {
  declined: '你选了「本轮不生成」',
  'ask-timeout': '等待超时，按「不生成」处理',
  'ask-cancelled': '询问被取消（你发了新消息或会话已结束）',
  'no-answerer': '当前没有可用的提问通道（无 Web 客户端 / 无 userQuestions 服务）',
  'no-agent': '会话已结束或 agent 已销毁',
  superseded: '这期间你已经发了新消息，本轮不再打扰',
  'empty-turn': '本轮没有可生成的内容',
}

export function registerHandoffCommands(ctx, service) {
  ctx.effect(() => ctx.commands.register({
    name: 'handoff',
    description: '会话交接单：轮末询问后生成、立即刷新、开关、列出/查看历史交接单',
    input: { hint: '[ask|status|on|off|list|read|cost|models]' },
    async handler(invocation) {
      try {
        const agent = invocation && invocation.agent
        const session = agent && agent.session
        const [actionRaw, rest] = splitFirst(invocation && invocation.rawInput)
        const action = actionRaw.toLowerCase()

        if (action === '' || action === 'help' || action === 'now' || action === 'write') {
          if (!session) throw new Error('该命令需要 Agent 会话')
          const result = await service.enqueue(session, { reason: 'command' })
          if (!result || !result.ok) {
            return failure(new Error(`生成失败：${(result && result.reason) || '未知原因'}（可看插件日志）`))
          }
          return success([
            `交接单已刷新：${result.path}`,
            `模式：${result.mode}${result.model ? `（${result.model}）` : ''}`,
            `轮次：第 ${result.turn} 轮；${result.chars} 字；识别到 ${result.files} 个文件路径`,
          ].join('\n'))
        }

        if (action === 'ask') {
          if (!session) throw new Error('该命令需要 Agent 会话')
          service.prepareAsk(session)
          const result = await service.enqueue(session, { reason: 'ask' })
          if (result && result.ok) {
            return success([
              `交接单已生成：${result.path}`,
              `模式：${result.mode}${result.model ? `（${result.model}）` : ''}`,
              `轮次：第 ${result.turn} 轮；${result.chars} 字`,
            ].join('\n'))
          }
          const reason = (result && result.reason) || '未知原因'
          return failure(new Error(`未生成：${ASK_REASONS[reason] || reason}`))
        }

        if (action === 'status') {
          return success(service.status(session))
        }

        if (action === 'on' || action === 'off') {
          if (!session) throw new Error('该命令需要 Agent 会话')
          const off = action === 'off'
          service.setOff(session, off)
          return success(off
            ? '本会话已停用自动刷新；需要时仍可 /handoff 手动生成。'
            : '本会话已恢复自动刷新。')
        }

        if (action === 'list') {
          const limit = Number.isInteger(Number(rest)) ? Math.min(50, Math.max(1, Number(rest))) : 10
          const list = service.listRecent(limit)
          if (list.length === 0) return success('没有找到交接单。')
          return success(list.map((item) => `${item.updatedAt}  ${item.project}  ${item.path}`).join('\n'))
        }

        if (action === 'read') {
          const path = rest.trim()
          if (!path) throw new Error('用法：/handoff read <交接单绝对路径>')
          const file = service.readHandoff(path)
          if (!file) throw new Error(`读不到该文件：${path}`)
          const header = file.header || {}
          return success([
            `路径：${file.path}`,
            `大小：${file.size} 字（约）`,
            `项目：${header.project || '未知'}；工作目录：${header.cwd || '未知'}；更新时间：${header.updatedAt || '未知'}`,
            '---',
            service.preview(file.text, 2000),
          ].join('\n'))
        }

        if (action === 'cost') {
          const limit = Number.isInteger(Number(rest)) ? Math.min(50, Math.max(1, Number(rest))) : 10
          return success(service.costSummary(session, limit))
        }

        if (action === 'models') {
          return success(await service.describeModels())
        }

        return failure(new Error(`未知子命令：${actionRaw}\n\n${USAGE}`))
      } catch (error) {
        return failure(error)
      }
    },
  }))
}
