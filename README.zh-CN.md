# dsh-plugin-session-manager

[![CI](https://github.com/Sean1shao/dsh-plugin-session-manager/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Sean1shao/dsh-plugin-session-manager/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）侧栏的会话行菜单加一个「**删除会话**」动作。

DSH 只提供「归档（隐藏）」——数据一个字节都不少——而没有删除。会话日志只能靠带外维护来剪除。本插件把这件事包装成一个正常的侧栏菜单项：带确认对话框，并由 Host 侧先确认会话确实空闲，再动磁盘。

[English](README.md)

```
会话行 → ⋯
├── 置顶会话            100
├── 重命名              200
├── 分叉会话            300
├── 归档会话            400
├── 复制 Session ID     450
└── 删除会话            500  ← 本插件（危险色，独立分组）
```

## 环境要求

**状态：** 0.1.0，还年轻。Host 路由、删除逻辑、浏览器 bundle 的加载都有测试覆盖，也在真实 profile 上验证过解析与注册；菜单项本身靠手工验证。DSH 的插件接口仍在演进，请以你实测过的 DSH 版本为准。

- DSH 桌面版或 `dsh --profile web`。开发基准为 **DSH 0.2.2-rc.1**。
- Windows 下安装脚本需要 PowerShell 5.1+；macOS / Linux 用手工安装。
- 运行时零依赖：Node 面只 import `node:fs`、`node:os`、`node:path`。

## 安装

插件装进一个 DSH **profile**：`package.json` 记录组合包，`cordis.patch.yml` 记录组合行。

### Windows

```powershell
# 1) 完全退出 DSH（托盘菜单退出；关窗口可能只是最小化）
# 2) 克隆并安装进当前 profile
git clone https://github.com/Sean1shao/dsh-plugin-session-manager.git
cd dsh-plugin-session-manager
powershell -ExecutionPolicy Bypass -File .\install.ps1
# 3) 重新启动 DSH
```

脚本会把本目录复制到 `<profile>\node_modules\dsh-plugin-session-manager`，并在 `<profile>\cordis.patch.yml` 末尾追加一段带标记的 `insert` 行。两步都是幂等的，`-Uninstall` 精确撤销。

```powershell
# 指定别的 profile
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Profile 'D:\dsh-home\profiles\web'
# 卸载
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall
```

### macOS / Linux（手工）

```bash
# 在克隆下来的仓库目录里执行
git clone https://github.com/Sean1shao/dsh-plugin-session-manager.git
cd dsh-plugin-session-manager
PROFILE="${DSH_HOME:-$HOME/.dsh}/profiles/desktop"
mkdir -p "$PROFILE/node_modules"
cp -R . "$PROFILE/node_modules/dsh-plugin-session-manager"
cat >> "$PROFILE/cordis.patch.yml" <<'YAML'

- insert:
    - id: session-manager
      name: 'dsh-plugin-session-manager'
YAML
```

重启 DSH。profile 目录默认是 Windows 的 `%USERPROFILE%\.dsh\profiles\desktop`、其他平台的 `~/.dsh/profiles/desktop`；不确定就看 `DSH_PROFILE_DIR`。

## 使用

把指针停在某个会话行上 → `⋯` → **删除会话** → 确认。

- 会话**仍在跑工作**（回合进行中、子智能体、后台任务、定时提醒）时 Host 会拒绝，并告诉你还有几项活动 —— 先停止或等它结束。
- 删除成功后，侧栏会移除该会话。如果正在查看的是被删会话，主聊天区会退出该会话。
- 日志文件被占用（例如该会话正开着且在写）时返回 `409 locked`，关掉该会话再试。

## 删了什么

| 路径 | 是什么 |
|---|---|
| `<会话根目录>\<项目目录>\<会话 id>\` | 追加式会话日志，唯一权威数据 |
| `~/.dsh/storages/session_projcache/sessions/<id>.json` | 该会话的投影检查点（尽力而为；缓存本身是 fail-soft 的） |

会话根目录默认是 `$DSH_HOME/sessions`（通常是 `~/.dsh/sessions`）。

Host 通过 DSH 工作区注册表更新被删会话的成员关系。

## 安全模型

删除不可逆，所以 Host 面不信任客户端：

1. `sessionId` 必须匹配 `[A-Za-z0-9][A-Za-z0-9._-]{0,127}` —— 杜绝路径穿越；
2. 先问 `workspace/session-activity` 瀑布：有任何活动 → `409 session-active`，**一个字节都不动**；连问都问不出来 → `500`，同样不动；
3. 确认空闲后，Host 按目录名全等定位日志目录，归档会话后删除日志；
4. 投影缓存记录尽力清理，失败只记日志，不影响删除结果。

整条路由挂在 Connection 的 `/api` 上，因此自动继承浏览器认证、Host/Origin 栅栏和 fiber 生命周期（插件卸载即摘除路由）。

## 配置

```yaml
- id: session-manager
  config:
    # 显式指定会话根目录；缺省依次取 sessionPersistence.root、$DSH_HOME/sessions
    sessionsRoot: 'D:\somewhere\sessions'
    # 是否连带清理投影缓存记录，默认 true
    purgeCache: true
```

## 实现

一行 Loader 承载两面：

| 面 | 文件 | 职责 |
|---|---|---|
| Host | [`lib/index.js`](lib/index.js) | 在 Connection 的精确 Fetch 路由表上注册删除及删除记录接口 |
| 浏览器 | [`lib/client.js`](lib/client.js) | `__ModuleLoader__` 惰性 CJS bundle，向 `sidebar.workspaces.session.menu.item` 槽贡献菜单项 |

为什么不用 Typert Remote？单个动作不值得引入生成式描述符与编解码器；DSH 自己就用同一条精确 Fetch 通道做会话日志下载与原始文件上传。细节见 [ARCHITECTURE.md](ARCHITECTURE.md)。

## 已知限制

- **删除不可恢复**，没有回收站。要留后路就先备份 `%USERPROFILE%\.dsh\sessions`。
- **附件孤儿对象不回收**（保守优先，与官方「归档不删数据」的取向一致）。
- **subagent 会话不在侧栏显示**，因此没有对应菜单项。
- 会话 id 的目录名按原样匹配（`session-<uuid>` 编码后是恒等变换）。将来若 id 形态变化、需要转义，`findSessionDirectory` 会返回 `404` 而不是误删。

## 故障排查

| 现象 | 处理 |
|---|---|
| `GetFullPath` 报「路径的形式不合法」 | 0.1.0 的初版脚本在 PowerShell 5.1 下会踩到：`[CmdletBinding()]` 脚本的 `param()` 默认值求值时 `$PSScriptRoot` 仍为空。现已改为在脚本体里解析；旧版在报错前没有写入任何文件，重跑即可。 |
| `无法加载文件 … 未对文件进行数字签名` | 执行策略拦截，用 `powershell -ExecutionPolicy Bypass -File .\install.ps1`（只对这次调用放宽）。 |
| 装好了但菜单里没有 | ① 是否完全退出并重启了 DSH；② `<profile>\cordis.patch.yml` 里是否有 `session-manager` 行；③ 打开侧栏「插件」页看是否有加载失败。 |
| `404 not-found` | 会话已被删除，或 id 需要转义而本插件未解码。 |
| `409 session-active` | 先停止该会话的工作（回合 / 子智能体 / 后台任务 / 定时提醒）。 |

## 开发

```
lib/index.js      Node 面：路由 + 删除逻辑
lib/client.js     浏览器面：__ModuleLoader__ bundle、菜单项、对话框
cordis.patch.yml  组合行（作为 bundle 安装时使用）
test/             node:test 测试
```

```bash
npm test
# 或逐个跑：
node test/host.test.mjs
node test/client.test.mjs
```

两个测试都不需要 DSH 在跑：Node 面用假 ctx 驱动注册进来的路由，浏览器面用假 `__ModuleLoader__` 与假共享模块表加载 bundle。改动前请先读 [CONTRIBUTING.md](CONTRIBUTING.md) 里那两条不能破的约定。

## 许可

[MIT](LICENSE)
