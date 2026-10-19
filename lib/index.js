/**
 * dsh-plugin-session-manager —— Node 面。
 *
 * DSH 的持久化层刻意不提供删除接口（session-persistence：「无删除或保留接口，
 * 剪枝已存储会话属于带外后端维护」），所以这里做的正是那次带外维护：
 *
 *   1. 先问 `workspace/session-activity` 瀑布，仍在跑工作的会话直接拒绝；
 *   2. 在会话根目录下定位 `<root>/<项目目录>/<sessionId>/`；
 *   3. 删除该目录（会话日志是唯一权威数据）；
 *   4. 尽力清掉 `storages/session_projcache/sessions/<id>.json`。
 *
 * 对外只有一条 HTTP 路由：POST /api/dsh-session-manager/delete
 * 它挂在 Connection 的精确 Fetch 路由表上，因此自动获得浏览器认证、
 * Host/Origin 栅栏，以及 fiber 作用域的生命周期（插件卸载即摘除）。
 *
 * @module dsh-plugin-session-manager
 */

import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 稳定插件名（供 Loader 与日志识别）。 */
export const name = 'session-manager'

/** Connection 提供 `ctx.connection.fetch`，没有它就无从挂路由。 */
export const inject = ['connection']

/** 删除路由的路径；必须落在 `/api` 下，段只允许 `[A-Za-z0-9_$.-]`。 */
export const DELETE_PATH = '/api/dsh-session-manager/delete'

/**
 * 会话 id 的安全形态。真实 id 形如 `session-<uuid>`；这里只做防穿越的宽松校验，
 * 真正的定位用的是目录名全等比较。
 * @param {unknown} value - 待校验的值。
 * @returns {value is string} 是否是安全可用的会话 id。
 */
export function isSessionId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)
}

/**
 * 解析会话根目录：显式配置 > 持久化后端的 root > `$DSH_HOME/sessions`。
 * @param {object} ctx - Host 插件上下文。
 * @param {string | undefined} configured - 插件配置里的 sessionsRoot。
 * @returns {string} 绝对路径。
 */
export function resolveSessionsRoot(ctx, configured) {
  if (typeof configured === 'string' && configured.length > 0) return configured
  const persistence = ctx.get('sessionPersistence')
  if (persistence !== undefined && typeof persistence.root === 'string' && persistence.root.length > 0) {
    return persistence.root
  }
  return join(dshHome(), 'sessions')
}

/**
 * 解析 `$DSH_HOME`（与 dsh-home-paths 相同的两级优先级，见其 README）。
 * @returns {string} DSH 主目录。
 */
export function dshHome() {
  const configured = process.env.DSH_HOME
  if (typeof configured === 'string' && configured.trim().length > 0) return configured
  return join(homedir(), '.dsh')
}

/**
 * 在会话根目录下按目录名定位一个会话目录。
 *
 * 磁盘布局是 `<root>/<从 cwd 编码出的项目目录>/<从 id 编码出的会话目录>/`。
 * 这里不重算 cwd 的编码（那是后端的私有实现），而是在两层结构里找名字完全等于
 * 会话 id 的目录；`session-<uuid>` 本身就是合法路径段，编码是恒等变换。
 *
 * @param {string} root - 会话根目录。
 * @param {string} sessionId - 已通过 {@link isSessionId} 的 id。
 * @returns {Promise<string | undefined>} 找到的会话目录，未找到为 undefined。
 */
export async function findSessionDirectory(root, sessionId) {
  let projects
  try {
    projects = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return undefined
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue
    if (project.name.startsWith('.')) continue
    const candidate = join(root, project.name, sessionId)
    try {
      const stats = await fs.stat(candidate)
      if (stats.isDirectory()) return candidate
    } catch {
      // 该会话不在这一个项目目录里，继续找。
    }
  }
  return undefined
}

/**
 * 询问所有活动提供方该会话是否还有工作在进行。
 * @param {object} ctx - Host 插件上下文。
 * @param {string} sessionId - 会话 id。
 * @returns {Promise<unknown[]>} 活动条目；空数组表示空闲。
 */
async function sessionActivity(ctx, sessionId) {
  const activity = await ctx.waterfall('workspace/session-activity', { sessionId }, () => Promise.resolve([]))
  return Array.isArray(activity) ? activity : []
}

/**
 * 把活动条目压成可回传的 JSON 描述，不假设提供方的具体字段。
 * @param {unknown} entry - 提供方给出的一项活动。
 * @returns {object} 稳定形状的摘要。
 */
function describeActivity(entry) {
  if (entry === null || typeof entry !== 'object') return { kind: String(entry) }
  const record = /** @type {Record<string, unknown>} */ (entry)
  const summary = { kind: typeof record.kind === 'string' ? record.kind : 'unknown' }
  if (typeof record.name === 'string') summary.name = record.name
  else if (typeof record.title === 'string') summary.name = record.title
  return summary
}

/**
 * 尽力清掉该会话的投影缓存记录。
 *
 * 缓存是 fail-soft 的：记录读不出来、或与日志对不上时消费方会自行冷折叠，
 * 所以这里任何失败都只记日志，绝不影响删除结果。
 *
 * @param {object} ctx - Host 插件上下文。
 * @param {string} sessionId - 会话 id。
 * @returns {Promise<void>} 完成即返回。
 */
async function purgeProjectionCache(ctx, sessionId) {
  const file = join(dshHome(), 'storages', 'session_projcache', 'sessions', `${sessionId}.json`)
  try {
    await fs.rm(file, { force: true })
  } catch (error) {
    ctx.logger?.warn?.(`session-manager: 清理投影缓存失败（${file}）：${String(error)}`)
  }
}

/**
 * 退回一个结构化的失败响应。
 * @param {number} status - HTTP 状态码。
 * @param {string} code - 机器可读的失败码。
 * @param {string} message - 面向人的说明。
 * @param {object} [extra] - 额外字段。
 * @returns {Response} JSON 响应。
 */
function fail(status, code, message, extra = {}) {
  return Response.json({ ok: false, code, message, ...extra }, { status })
}

/**
 * 处理一次删除请求。
 * @param {object} ctx - Host 插件上下文。
 * @param {Request} request - 已认证的 Fetch 请求。
 * @param {{ sessionsRoot: string, purgeCache: boolean }} options - 解析后的配置。
 * @returns {Promise<Response>} JSON 响应。
 */
export async function handleDelete(ctx, request, options) {
  let payload
  try {
    payload = await request.json()
  } catch {
    return fail(400, 'invalid-request', '请求体不是合法 JSON')
  }

  const sessionId = payload?.sessionId
  if (!isSessionId(sessionId)) return fail(400, 'invalid-session-id', '会话 ID 不合法')

  let activity
  try {
    activity = await sessionActivity(ctx, sessionId)
  } catch (error) {
    // 问不出「是否空闲」就不动数据：宁可拒绝，也不要删掉一个正在跑的会话。
    return fail(500, 'activity-check-failed', `无法确认该会话是否空闲：${String(error?.message ?? error)}`)
  }
  if (activity.length > 0) {
    return fail(409, 'session-active', '该会话仍有进行中的工作，请先停止后再删除', {
      activity: activity.map(describeActivity),
    })
  }

  const directory = await findSessionDirectory(options.sessionsRoot, sessionId)
  if (directory === undefined) {
    return fail(404, 'not-found', '找不到该会话的日志目录，可能已被删除')
  }

  try {
    await fs.rm(directory, { recursive: true, force: false, maxRetries: 3, retryDelay: 100 })
  } catch (error) {
    const code = /** @type {{ code?: string }} */ (error)?.code
    const locked = code === 'EBUSY' || code === 'EPERM' || code === 'EACCES'
    return fail(locked ? 409 : 500, locked ? 'locked' : 'delete-failed', locked
      ? '会话日志被占用，请关闭该会话后再试'
      : `删除失败：${String(error?.message ?? error)}`)
  }

  if (options.purgeCache) await purgeProjectionCache(ctx, sessionId)
  ctx.logger?.info?.(`session-manager: 已删除会话 ${sessionId}（${directory}）`)

  return Response.json({ ok: true, sessionId, deleted: directory })
}

/**
 * 挂载 Node 面：注册唯一的删除路由。
 * @param {object} ctx - Host 插件上下文。
 * @param {{ sessionsRoot?: string, purgeCache?: boolean }} [config] - 插件配置。
 * @returns {void}
 */
export function apply(ctx, config) {
  const options = {
    sessionsRoot: resolveSessionsRoot(ctx, config?.sessionsRoot),
    purgeCache: config?.purgeCache !== false,
  }

  ctx.connection.fetch.register({
    path: DELETE_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: (request) => handleDelete(ctx, request, options),
  })
}
