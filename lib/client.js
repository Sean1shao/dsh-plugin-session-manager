/**
 * dsh-plugin-session-manager —— 浏览器面。
 *
 * 这是一个 dsh-client-modules 的「惰性 CJS」bundle：执行文件只注册 factory，
 * 真正的主体在模块首次物化时才跑。可用的 require 说明符只有外壳固定的那张
 * 共享模块表（react、react-dom/client、@deepseek-ai/cordis、
 * @deepseek-ai/dsh-client-ui-slots、@deepseek-ai/dsh-client-ui-primitives …）。
 *
 * 贡献点：`sidebar.workspaces.session.menu.item` —— 会话行「⋯」菜单里的列表槽。
 * 内置项 order 为 100/200/300/400/450，这里用 500 接在「复制 Session ID」之后，
 * 并用 separatorBefore 另起一组。
 *
 * 确认对话框由本文件自己 createRoot 到 document.body：菜单一关，行组件连同它的
 * 状态就会卸载，把对话框挂在行上会一起消失，所以它必须独立于行的生命周期。
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-session-manager',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { createRoot } = require('react-dom/client')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const { MenuItemButton } = primitives
    /** 垃圾桶图标随共享基座提供；取不到就不画，不影响菜单项本身。 */
    const TrashIcon = primitives.IconTrashOutlineRegular

    const h = React.createElement
    const ENDPOINT = '/api/dsh-session-manager/delete'
    const STYLE_ID = 'dsh-session-manager-styles'

    /** 面板用系统色（Canvas/CanvasText）并声明 color-scheme，深浅主题都跟得上。 */
    const STYLES = `
.dsm-backdrop{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(0,0,0,.45)}
.dsm-panel{color-scheme:light dark;background:Canvas;color:CanvasText;border:1px solid rgba(127,127,127,.35);border-radius:14px;box-shadow:0 24px 64px rgba(0,0,0,.32);width:min(420px,100%);padding:22px 22px 18px;font:14px/1.55 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
.dsm-title{margin:0 0 10px;font-size:15px;font-weight:600;letter-spacing:.01em}
.dsm-text{margin:0 0 8px;word-break:break-word}
.dsm-muted{margin:0 0 8px;opacity:.72;font-size:13px;word-break:break-word}
.dsm-warn{margin:0 0 10px;color:#d9372b;font-size:13px}
.dsm-id{margin:0;font:12px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;opacity:.55;word-break:break-all}
.dsm-error{margin:12px 0 0;padding:8px 10px;border-radius:9px;background:rgba(217,55,43,.12);color:#d9372b;font-size:13px;word-break:break-word}
.dsm-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:18px}
.dsm-btn{font:inherit;padding:7px 16px;border-radius:9px;border:1px solid rgba(127,127,127,.4);background:transparent;color:inherit;cursor:pointer}
.dsm-btn:hover:not(:disabled){background:rgba(127,127,127,.14)}
.dsm-btn:disabled{opacity:.55;cursor:default}
.dsm-btn:focus-visible{outline:2px solid #2f6feb;outline-offset:2px}
.dsm-btn-danger{background:#d9372b;border-color:#d9372b;color:#fff}
.dsm-btn-danger:hover:not(:disabled){background:#bd2b20}
`

    /** 样式只注入一次，插件卸载后残留一个空 style 也无害。 */
    function ensureStyles() {
      if (document.getElementById(STYLE_ID) !== null) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = STYLES
      document.head.appendChild(style)
    }

    /**
     * 把失败码翻成一句人话。
     * @param {number} status - HTTP 状态码。
     * @param {any} payload - Host 回的 JSON。
     * @returns {string} 展示用文案。
     */
    function messageFor(status, payload) {
      const message = payload?.message
      if (payload?.code === 'session-active') {
        const count = Array.isArray(payload.activity) ? payload.activity.length : 0
        return `${message ?? '该会话仍在运行'}（${count} 项活动）`
      }
      if (typeof message === 'string' && message.length > 0) return message
      if (status === 401 || status === 403) return '没有权限执行该操作'
      return `删除失败（HTTP ${status}）`
    }

    /**
     * 确认对话框。
     * @param {{ sessionId: string, displayTitle?: string, onClose: () => void }} props - 目标与关闭回调。
     * @returns {object} React 元素。
     */
    function DeleteSessionDialog({ sessionId, displayTitle, onClose }) {
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)
      const dangerRef = React.useRef(null)

      React.useEffect(() => {
        dangerRef.current?.focus()
        const onKeyDown = (event) => {
          if (event.key === 'Escape' && !busy) onClose()
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
      }, [busy, onClose])

      const confirm = async () => {
        setBusy(true)
        setError(null)
        try {
          const response = await fetch(ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId }),
          })
          let payload = null
          try {
            payload = await response.json()
          } catch {
            payload = null
          }
          if (!response.ok || payload?.ok !== true) {
            setError(messageFor(response.status, payload))
            setBusy(false)
            return
          }
          // 侧栏的成员关系来自 Host 的投影流，删文件不会推事件；重载一次拿到干净的列表。
          window.location.reload()
        } catch (cause) {
          setError(`无法连接 DSH Host：${String(cause?.message ?? cause)}`)
          setBusy(false)
        }
      }

      const label = typeof displayTitle === 'string' && displayTitle.trim().length > 0
        ? `「${displayTitle.trim()}」`
        : '该会话'

      return h(
        'div',
        {
          className: 'dsm-backdrop',
          onMouseDown: (event) => {
            if (event.target === event.currentTarget && !busy) onClose()
          },
        },
        h(
          'div',
          { className: 'dsm-panel', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'dsm-title' },
          h('div', { className: 'dsm-title', id: 'dsm-title' }, '删除会话？'),
          h('p', { className: 'dsm-text' }, `将永久删除${label}的全部会话日志与投影缓存。`),
          h('p', { className: 'dsm-warn' }, '此操作无法撤销。工作区文件夹、其他会话都不受影响。'),
          h('p', { className: 'dsm-id' }, `Session ID：${sessionId}`),
          error === null ? null : h('div', { className: 'dsm-error', role: 'alert' }, error),
          h(
            'div',
            { className: 'dsm-actions' },
            h(
              'button',
              { className: 'dsm-btn', type: 'button', disabled: busy, onClick: onClose },
              '取消',
            ),
            h(
              'button',
              {
                className: 'dsm-btn dsm-btn-danger',
                type: 'button',
                disabled: busy,
                ref: dangerRef,
                onClick: confirm,
              },
              busy ? '正在删除…' : '删除',
            ),
          ),
        ),
      )
    }

    /** 同一时刻只允许一个对话框。 */
    let closeActiveDialog = null

    /**
     * 打开对话框：自建宿主节点 + 独立的 React 根。
     * @param {string} sessionId - 目标会话。
     * @param {string | undefined} displayTitle - 行上显示的标题。
     * @returns {void}
     */
    function openDeleteDialog(sessionId, displayTitle) {
      if (closeActiveDialog !== null) return
      ensureStyles()
      const host = document.createElement('div')
      document.body.appendChild(host)
      const root = createRoot(host)
      const close = () => {
        closeActiveDialog = null
        root.unmount()
        host.remove()
      }
      closeActiveDialog = close
      root.render(h(DeleteSessionDialog, { sessionId, displayTitle, onClose: close }))
    }

    /**
     * 会话行菜单项。
     * @param {{ sessionId: string, displayTitle?: string, useMenuOpenState: () => [unknown, (open: boolean) => void] }} props - 槽传入的行身份与菜单开关。
     * @returns {object} React 元素。
     */
    function DeleteSessionMenuItem({ sessionId, displayTitle, useMenuOpenState }) {
      const [, setMenuOpen] = useMenuOpenState()
      return h(
        MenuItemButton,
        {
          danger: true,
          separatorBefore: true,
          ...(TrashIcon === undefined ? {} : { icon: h(TrashIcon, { 'aria-hidden': true }) }),
          onSelect: () => {
            setMenuOpen(false)
            openDeleteDialog(sessionId, displayTitle)
          },
        },
        '删除会话',
      )
    }

    /**
     * 注册菜单项。用 `ctx.slots.inject` 等待槽声明就绪：槽被折叠时条目移除，
     * 恢复时重新注册，插件销毁时一并回收。
     * @param {object} ctx - Client 插件上下文。
     * @returns {void}
     */
    function apply(ctx) {
      ctx.slots.inject('sidebar.workspaces.session.menu.item', function* registerDeleteItem() {
        yield ctx.slots.register(
          {
            name: 'sidebar.workspaces.session.menu.item',
            id: 'session-manager.delete',
            order: 500,
            inject: () => ({}),
          },
          DeleteSessionMenuItem,
        )
      })
    }

    exports.apply = apply
    exports.inject = ['slots']
    return module.exports
  },
})
