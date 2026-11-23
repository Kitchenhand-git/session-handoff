// Host entry for the session-handoff plugin.
//
// 模块用 revision 查询串导入，让运行中的应用在代码改动后仍能加载新版本：
// shim 包带上 `?v=<rev>` 导入本文件，本文件再用同一个 rev 导入 host/*。
// 改代码后同步修改 HOST_REV 并换一个 shim（或改 shim 的 rev）。
const HOST_REV = '20261123-1045'

const { loadConfig } = await import(`./host/config.js?v=${HOST_REV}`)
const { createLogger } = await import(`./host/safe.js?v=${HOST_REV}`)
const { HandoffService } = await import(`./host/service.js?v=${HOST_REV}`)
const { registerHandoffHooks } = await import(`./host/hooks.js?v=${HOST_REV}`)
const { registerHandoffCommands } = await import(`./host/commands.js?v=${HOST_REV}`)
const { registerHandoffTool } = await import(`./host/tools.js?v=${HOST_REV}`)

export const name = 'session-handoff'
// workingDirectory 不放进 inject：拿不到时用 session.header.cwd 兜底，
// 这样在缺少该服务的 profile 里插件仍能工作，而不是整行不激活。
export const inject = ['tools', 'commands']

/** 挂载交接单插件的 Host 半边。任何初始化异常都只降级，不抛给加载器。 */
export function apply(ctx, rawConfig) {
  const logger = createLogger(ctx)
  let loaded
  try {
    loaded = loadConfig(rawConfig)
  } catch (error) {
    logger.warn('[session-handoff] 配置解析失败，使用默认值：%s', String(error && error.message ? error.message : error))
    loaded = loadConfig({})
  }
  const { config, warnings } = loaded
  for (const warning of warnings) logger.warn('[session-handoff] %s', warning)

  if (!config.enabled) {
    logger.info('[session-handoff] 已在配置中禁用（enabled: false），不注册任何监听器')
    return
  }

  try {
    const service = new HandoffService(ctx, config, logger)
    registerHandoffHooks(ctx, service)
    registerHandoffCommands(ctx, service)
    registerHandoffTool(ctx, service)
    logger.info(
      '[session-handoff] ready: turnEnd=%s summaryMode=%s newSessionAsk=%s roots=%s',
      String(config.turnEndEnabled),
      config.summaryMode,
      String(config.newSessionAsk),
      config.searchRoots.join(','),
    )
  } catch (error) {
    // 初始化失败只让本插件空转：绝不把异常抛回加载器变成整行 FAILED。
    logger.warn('[session-handoff] 初始化失败，本插件不生效：%s', String(error && error.message ? error.message : error))
  }
}
