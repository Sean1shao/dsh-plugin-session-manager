/**
 * Node 面的行为测试：不看 DSH 内部实现，只按公开约定驱动注册进来的路由。
 *
 *   node --test test/
 */

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { apply, handleDelete, isSessionId, findSessionDirectory, resolveSessionsRoot } from '../lib/index.js'

/** 造一个最小可用的假 Host 上下文，记录注册进来的路由。 */
function fakeContext({ activity = [], persistence } = {}) {
  const routes = []
  const ctx = {
    routes,
    logger: { info() {}, warn() {} },
    get: (key) => (key === 'sessionPersistence' ? persistence : undefined),
    effect: (fn) => fn(),
    waterfall: async () => activity,
    connection: { fetch: { register: (route) => { routes.push(route); return () => {} } } },
  }
  return ctx
}

/** 造一棵假的会话根目录。 */
async function fakeSessionsRoot() {
  const root = await mkdtemp(join(tmpdir(), 'dsm-'))
  const project = join(root, '--D-workplace-demo--')
  const session = join(project, 'session-abc')
  await mkdir(session, { recursive: true })
  await writeFile(join(session, 'session.v4.jsonl.zstd'), 'log')
  return { root, project, session }
}

/** 发一次删除请求。 */
function deletionRequest(body) {
  return new Request('http://127.0.0.1/api/dsh-session-manager/delete', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

test('apply 注册的是一条 POST 精确路由，路径在 /api 下', () => {
  const ctx = fakeContext()
  apply(ctx, { sessionsRoot: join(tmpdir(), 'unused') })
  assert.equal(ctx.routes.length, 1)
  const route = ctx.routes[0]
  assert.equal(route.path, '/api/dsh-session-manager/delete')
  assert.deepEqual(route.methods, ['POST'])
  assert.equal(route.requestBody, 'buffered')
  assert.equal(typeof route.fetch, 'function')
})

test('删除成功：日志目录消失，返回 deleted 路径', async (t) => {
  const { root, session } = await fakeSessionsRoot()
  t.after(() => rm(root, { recursive: true, force: true }))

  const ctx = fakeContext()
  apply(ctx, { sessionsRoot: root })
  const response = await ctx.routes[0].fetch(deletionRequest({ sessionId: 'session-abc' }))

  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.ok, true)
  assert.equal(body.sessionId, 'session-abc')
  assert.equal(existsSync(session), false)
})

test('会话仍在跑工作时拒绝删除，且不动磁盘', async (t) => {
  const { root, session } = await fakeSessionsRoot()
  t.after(() => rm(root, { recursive: true, force: true }))

  const ctx = fakeContext({ activity: [{ kind: 'turn' }] })
  apply(ctx, { sessionsRoot: root })
  const response = await ctx.routes[0].fetch(deletionRequest({ sessionId: 'session-abc' }))

  assert.equal(response.status, 409)
  const body = await response.json()
  assert.equal(body.code, 'session-active')
  assert.equal(body.activity[0].kind, 'turn')
  assert.equal(existsSync(session), true)
})

test('活动提供方报错时同样拒绝，宁可不动数据', async (t) => {
  const { root, session } = await fakeSessionsRoot()
  t.after(() => rm(root, { recursive: true, force: true }))

  const ctx = fakeContext()
  ctx.waterfall = async () => { throw new Error('provider exploded') }
  apply(ctx, { sessionsRoot: root })
  const response = await ctx.routes[0].fetch(deletionRequest({ sessionId: 'session-abc' }))

  assert.equal(response.status, 500)
  assert.equal((await response.json()).code, 'activity-check-failed')
  assert.equal(existsSync(session), true)
})

test('找不到会话时返回 404', async (t) => {
  const { root } = await fakeSessionsRoot()
  t.after(() => rm(root, { recursive: true, force: true }))

  const ctx = fakeContext()
  apply(ctx, { sessionsRoot: root })
  const response = await ctx.routes[0].fetch(deletionRequest({ sessionId: 'session-missing' }))

  assert.equal(response.status, 404)
  assert.equal((await response.json()).code, 'not-found')
})

test('非法会话 id 与坏 JSON 都在 400 停止', async () => {
  const ctx = fakeContext()
  apply(ctx, { sessionsRoot: '/nowhere' })

  const bad = await ctx.routes[0].fetch(deletionRequest({ sessionId: '../../etc' }))
  assert.equal(bad.status, 400)
  assert.equal((await bad.json()).code, 'invalid-session-id')

  const broken = await ctx.routes[0].fetch(
    new Request('http://127.0.0.1/api/dsh-session-manager/delete', { method: 'POST', body: 'not json' }),
  )
  assert.equal(broken.status, 400)
  assert.equal((await broken.json()).code, 'invalid-request')
})

test('isSessionId 拒绝一切可能穿越路径的输入', () => {
  assert.equal(isSessionId('session-1a2b3c'), true)
  assert.equal(isSessionId('session-1a2b3c.d'), true)
  assert.equal(isSessionId('.hidden'), false)
  assert.equal(isSessionId('a/b'), false)
  assert.equal(isSessionId('a\\b'), false)
  assert.equal(isSessionId('..'), false)
  assert.equal(isSessionId(''), false)
  assert.equal(isSessionId(42), false)
})

test('resolveSessionsRoot：配置 > 持久化后端 > $DSH_HOME', () => {
  assert.equal(resolveSessionsRoot(fakeContext(), 'C:\\custom'), 'C:\\custom')
  assert.equal(
    resolveSessionsRoot(fakeContext({ persistence: { root: 'C:\\from-backend' } })),
    'C:\\from-backend',
  )

  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = join(tmpdir(), 'dsh-home-probe')
  try {
    assert.equal(resolveSessionsRoot(fakeContext()), join(tmpdir(), 'dsh-home-probe', 'sessions'))
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

test('findSessionDirectory 只认同名目录，不跨出一层项目目录', async (t) => {
  const { root, session } = await fakeSessionsRoot()
  t.after(() => rm(root, { recursive: true, force: true }))

  assert.equal(await findSessionDirectory(root, 'session-abc'), session)
  assert.equal(await findSessionDirectory(root, 'session'), undefined)
  assert.equal(await findSessionDirectory(join(root, 'missing'), 'session-abc'), undefined)
})

test('投影缓存按 <DSH_HOME>/storages/session_projcache/sessions/<id>.json 清理', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'dsm-home-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(async () => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  })

  const root = join(home, 'sessions')
  const session = join(root, '--proj--', 'session-x')
  await mkdir(session, { recursive: true })
  await writeFile(join(session, 'session.v4.jsonl.zstd'), 'log')
  const cacheDir = join(home, 'storages', 'session_projcache', 'sessions')
  await mkdir(cacheDir, { recursive: true })
  const cache = join(cacheDir, 'session-x.json')
  await writeFile(cache, JSON.stringify({ checkpoint: true }))

  const ctx = fakeContext()
  const response = await handleDelete(ctx, deletionRequest({ sessionId: 'session-x' }), {
    sessionsRoot: root,
    purgeCache: true,
  })
  assert.equal(response.status, 200)
  assert.equal(existsSync(session), false)
  assert.equal(existsSync(cache), false)
})

test('purgeCache=false 时保留缓存记录', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'dsm-home-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(async () => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  })

  const root = join(home, 'sessions')
  const session = join(root, '--proj--', 'session-y')
  await mkdir(session, { recursive: true })
  const cacheDir = join(home, 'storages', 'session_projcache', 'sessions')
  await mkdir(cacheDir, { recursive: true })
  const cache = join(cacheDir, 'session-y.json')
  await writeFile(cache, '{}')

  const ctx = fakeContext()
  const response = await handleDelete(ctx, deletionRequest({ sessionId: 'session-y' }), {
    sessionsRoot: root,
    purgeCache: false,
  })
  assert.equal(response.status, 200)
  assert.equal(await readFile(cache, 'utf8'), '{}')
})
