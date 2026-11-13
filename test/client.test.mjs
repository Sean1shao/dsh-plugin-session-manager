/**
 * 浏览器面的契约测试：按 dsh-client-modules 的「惰性 CJS」格式加载 bundle，
 * 用假的 require 提供共享模块表，检查注册项形状、菜单项渲染与对话框挂载。
 *
 *   node test/client.test.mjs
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

const captured = { entries: [], registrations: [], disposers: [], renders: [], roots: [] }

/** 假的 react：只需要 createElement/useState/useEffect/useRef。 */
const React = {
  createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children } }),
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  useRef: () => ({ current: null }),
}

const MenuItemButton = function MenuItemButton() { return null }
const IconTrashOutlineRegular = function IconTrashOutlineRegular() { return null }
const primitives = { MenuItemButton, IconTrashOutlineRegular }

/** 共享模块表里这一份 bundle 会 require 的说明符。 */
const modules = {
  'react': React,
  'react-dom/client': {
    createRoot: (host) => {
      const root = {
        host,
        render: (element) => { captured.renders.push(element) },
        unmount: () => {},
      }
      captured.roots.push(root)
      return root
    },
  },
  '@deepseek-ai/dsh-client-ui-primitives': primitives,
}

/** 足够让 openDeleteDialog 跑完的假 DOM。 */
function fakeElement() {
  return {
    children: [],
    id: '',
    className: '',
    style: {},
    textContent: '',
    appendChild(child) { this.children.push(child); return child },
    remove() {},
    setAttribute() {},
  }
}
const body = fakeElement()
const head = fakeElement()
globalThis.document = {
  body,
  head,
  getElementById: () => null,
  createElement: () => fakeElement(),
}

globalThis.window = {
  __ModuleLoader__: { load: (entry) => captured.entries.push(entry) },
  location: { reload: () => { captured.reloaded = true } },
  addEventListener: () => {},
  removeEventListener: () => {},
}

await import(new URL('../lib/client.js', import.meta.url).href)

test('bundle 以 __ModuleLoader__.load 注册一次，id 与包名一致', () => {
  assert.equal(captured.entries.length, 1)
  assert.equal(captured.entries[0].id, 'dsh-plugin-session-manager')
  assert.equal(typeof captured.entries[0].factory, 'function')
})

test('factory 产出 apply 与 inject，apply 注册到会话行菜单', () => {
  const entry = captured.entries[0]
  const exports = entry.factory((specifier) => {
    if (!(specifier in modules)) throw new Error(`unexpected module request: ${specifier}`)
    return modules[specifier]
  })
  assert.equal(typeof exports.apply, 'function')
  assert.deepEqual(exports.inject, ['slots', 'sessions'])

  const ctx = {
    effect: () => {},
    on: () => {},
    slots: {
      inject: (name, register) => {
        captured.injectName = name
        // 真实实现会消费这个生成器：每个 yield 都是要挂载的注册项。
        for (const disposer of register()) captured.disposers.push(disposer)
      },
      register: (registration, component) => {
        captured.registrations.push({ registration, component })
        return () => {}
      },
    },
  }
  exports.apply(ctx)

  assert.equal(captured.injectName, 'sidebar.workspaces.session.menu.item')
  assert.equal(captured.registrations.length, 1)
  const { registration, component } = captured.registrations[0]
  assert.equal(registration.name, 'sidebar.workspaces.session.menu.item')
  assert.equal(registration.id, 'session-manager.delete')
  assert.equal(registration.order, 500)
  assert.equal(typeof component, 'function')
})

test('菜单项是 danger 的 MenuItemButton，带分隔线与垃圾桶图标', () => {
  const { component } = captured.registrations[0]
  const element = component({
    sessionId: 'session-abc',
    displayTitle: '示例会话',
    useMenuOpenState: () => [null, () => {}],
  })
  assert.equal(element.type, MenuItemButton)
  assert.equal(element.props.danger, true)
  assert.equal(element.props.separatorBefore, true)
  assert.equal(element.props.icon.type, IconTrashOutlineRegular)
  assert.deepEqual(element.props.children, ['删除会话'])
  assert.equal(typeof element.props.onSelect, 'function')
})

test('点击菜单项：关菜单并挂载独立的确认对话框', () => {
  const { component } = captured.registrations[0]
  let menuClosed = false
  const element = component({
    sessionId: 'session-abc',
    displayTitle: '示例会话',
    useMenuOpenState: () => [null, (open) => { menuClosed = open === false }],
  })

  element.props.onSelect()

  assert.equal(menuClosed, true)
  assert.equal(captured.roots.length, 1)
  assert.equal(body.children.length, 1, '对话框宿主被挂到 body')
  assert.equal(captured.renders.length, 1, '对话框被渲染一次')

  // 再点一次不会叠出第二个对话框。
  element.props.onSelect()
  assert.equal(captured.roots.length, 1)
})

test('确认对话框渲染出目标标题、免责声明与两个按钮', () => {
  const dialog = captured.renders[0]
  assert.equal(typeof dialog.type, 'function')
  const tree = dialog.type(dialog.props)

  const flat = []
  const walk = (node) => {
    if (node === null || typeof node !== 'object') return
    flat.push(node)
    for (const child of node.props?.children ?? []) walk(child)
  }
  walk(tree)

  const text = flat
    .map((node) => (typeof node.props?.children?.[0] === 'string' ? node.props.children[0] : ''))
    .join('\n')

  assert.match(text, /删除会话？/)
  assert.match(text, /示例会话/)
  assert.match(text, /无法撤销/)
  assert.match(text, /取消/)
  assert.match(text, /删除/)
  assert.match(text, /session-abc/)
  dialog.props.onClose()
})

test('确认删除后关闭对话框并从列表移除目标，不刷新当前页面', async (t) => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  const ids = new Set(['session-abc', 'session-other'])
  const urls = []
  globalThis.fetch = async (url, options) => {
    urls.push(url)
    if (options?.method === 'POST') return Response.json({ ok: true, sessionId: 'session-abc' })
    return Response.json({ sessionIds: [] })
  }
  let component
  const exports = captured.entries[0].factory((specifier) => modules[specifier])
  exports.apply({
    effect: (fn) => fn(),
    on: () => {},
    sessions: {
      list: {
        getSnapshot: () => ({ ids: [...ids] }),
        subscribe: () => () => {},
      },
      handleSessionRemoved: (id) => ids.delete(id),
    },
    slots: {
      inject: (_name, register) => [...register()],
      register: (registration, item) => {
        component = (props) => item({ ...props, ...registration.inject() })
      },
    },
  })
  const menu = component({ sessionId: 'session-abc', useMenuOpenState: () => [null, () => {}] })
  menu.props.onSelect()
  const dialog = captured.renders.at(-1)
  const tree = dialog.type(dialog.props)
  const panel = tree.props.children[0]
  const buttons = panel.props.children.at(-1)
  await buttons.props.children.at(-1).props.onClick()

  assert.ok(urls.includes('/api/dsh-session-manager/delete'))
  assert.deepEqual([...ids], ['session-other'])
  assert.equal(captured.reloaded, undefined)
  menu.props.onSelect()
  assert.notEqual(captured.renders.at(-1), dialog)
  captured.renders.at(-1).props.onClose()
})

test('删除记录读取失败后重试，列表重载后仍移除已删除会话', async (t) => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  let reads = 0
  globalThis.fetch = async () => {
    reads++
    return reads === 1
      ? new Response(null, { status: 503 })
      : Response.json({ sessionIds: ['session-abc'] })
  }
  let onListChanged
  const ids = new Set(['session-abc', 'session-other'])
  const exports = captured.entries[0].factory((specifier) => modules[specifier])
  exports.apply({
    effect: (fn) => fn(),
    on: () => {},
    sessions: {
      list: {
        getSnapshot: () => ({ ids: [...ids] }),
        subscribe: (listener) => {
          onListChanged = listener
          return () => {}
        },
      },
      handleSessionRemoved: (id) => ids.delete(id),
    },
    slots: { inject: () => {} },
  })
  const settle = () => new Promise((resolve) => setImmediate(resolve))
  await settle()
  assert.deepEqual([...ids], ['session-abc', 'session-other'])
  onListChanged()
  await settle()
  assert.equal(reads, 2)
  assert.deepEqual([...ids], ['session-other'])
  ids.add('session-abc')
  onListChanged()
  assert.deepEqual([...ids], ['session-other'])
})
