// handoff 工具：让模型在对话里响应「出交接单 / 交接一下」。
import { errorText } from './safe.js'

const textOutput = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
}

function json(value) {
  return JSON.stringify(value, null, 2)
}

export function registerHandoffTool(ctx, service) {
  ctx.effect(() => ctx.tools.register({
    name: 'handoff',
    description:
      '会话交接单：action=write 立即把当前会话刷新成交接单并返回路径；status 查看开关与落盘位置；list 列出最近的交接单；cost 查看生成开销估算。用户说「出交接单」「交接一下」「生成交接」时调用 write。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['write', 'status', 'list', 'cost'],
          description: 'write=立即生成；status=状态；list=最近交接单；cost=生成开销估算',
        },
        note: { type: 'string', description: '可选：给交接单的一句补充说明（当前版本只回显，不写进正文）' },
      },
      required: ['action'],
    },
    output: textOutput,
    async execute(args, exec) {
      try {
        const action = (args && args.action) || 'write'
        const agent = exec && exec.agent
        const session = agent && agent.session
        if (action === 'write') {
          if (!session) throw new Error('该工具需要在 Agent 会话中调用')
          const result = await service.enqueue(session, { reason: 'tool' })
          if (!result || !result.ok) {
            throw new Error(`生成失败：${(result && result.reason) || '未知原因'}`)
          }
          return json({
            ok: true,
            path: result.path,
            mode: result.mode,
            model: result.model || null,
            turn: result.turn,
            chars: result.chars,
            files: result.files,
            note: args && args.note ? String(args.note) : null,
          })
        }
        if (action === 'status') return json(service.status(session))
        if (action === 'list') return json({ items: service.listRecent(10) })
        if (action === 'cost') return json(service.costSummary(session, 10))
        throw new Error(`未知 action：${action}`)
      } catch (error) {
        return json({ ok: false, error: errorText(error) })
      }
    },
  }))
}
