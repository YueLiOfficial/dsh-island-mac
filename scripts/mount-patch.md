# 安装步骤（用应用内的插件管理器，不要手改 profile）

> **这个文件原先给出一条走不通的做法**：让你把一段 `- insert:` 追加进
> `~/.dsh/profiles/desktop/cordis.patch.yml`。实测那条路不可能生效，
> 原因见文末「为什么手改 profile 不行」。下面是正确做法。

## 用插件管理器安装

`desktop` profile 由桌面应用独占管理：

```
$ dsh --profile desktop --dump-config
error: profile "desktop" is managed exclusively by the Electron application
```

CLI 拒绝碰它，所以安装必须走应用内的**插件管理器**（Plugin Manager → **添加插件**）。
那个输入框接受四种东西：

| 形态 | 例子 |
|---|---|
| 包名（可带版本） | `dsh-dynamic-island-progress@0.1.0` |
| Git 地址 | `github:you/dsh-dynamic-island` |
| 压缩包 | `/path/to/dsh-dynamic-island-progress-0.1.0.tgz` |
| **本地绝对路径** | `/Users/yueli/Code/dsh_plugins/dsh-dynamic-island` |

开发这个仓库时用**本地绝对路径**：把仓库根目录的绝对路径粘进去。
插件管理器用与 `dsh plugin` 相同的 pnpm 实现安装，把包登记进 profile 的
`dsh.profile.bundles`，然后应用这一层（安装日志里 `hot=true` 表示不必重启）。

**两条路的区别，选错会得到「装上了但不工作」：**

| 填什么 | 需要先做什么 | 说明 |
|---|---|---|
| `.tgz` 文件路径（推荐） | 无 | 包里已经带好编译后的 `lib/` 与 universal helper，最省事 |
| 仓库绝对路径 | **先 `npm run build`** | 本地目录安装不会跑 `prepack`，缺 `lib/` 就会 `failed to import` |

本仓库根目录下已有一份打包好的 `dsh-dynamic-island-progress-0.1.0.tgz`，可以直接用它。
自己重新打包见 [docs/PUBLISHING.md](../docs/PUBLISHING.md)。

**`cordis.patch.yml` 一个字都不用改**：包里的 `dsh.bundle.patch` 在它被登记为
bundle 时会自动作为一层应用。

## 验证装上了

```sh
# 插件 apply() 的第一件事就是写这个标记
cat "$HOME/Library/Application Support/dsh-island/plugin-applied.json"

# helper 是否真的在监听
lsof -U | grep island.sock
```

`plugin-applied.json` 的 `at` 应该是刚才，`helperPath` 应指向本仓库的
`bin/DynamicIslandBridge`。**这是排查「插件没反应」最便宜的一步**：
文件不存在 ⇒ 问题一定在加载层，不必去怀疑 socket、helper 或渲染
（本次就是这么定位的：文件里的 pid 属于离线冒烟测试，说明 `apply()` 从未在真实会话里跑过）。

## 卸载

在插件管理器里禁用或移除该 bundle。

## 关于 `config`

上面用等价的默认 `config`，即全部走默认值：

| 配置项 | 默认值 |
|---|---|
| `socketPath` | `~/Library/Application Support/dsh-island/island.sock` |
| `helperPath` | `<包目录>/bin/DynamicIslandBridge` |
| `connectTimeoutMs` | `10000` |
| `idleTimeoutMs` | `120000` |
| `graceMs` | `3000` |

**警告**：patch 是**整行替换 `config`，不是深度合并**。若要覆盖其中一项，
必须把**所有**想保留的键一并写出，否则未列出的键会退回插件 schema 默认值。
例如只改超时：

```yaml
- insert:
    - id: dynamic-island-progress
      name: dsh-dynamic-island-progress
      config:
        connectTimeoutMs: 20000
```

（这份片段要放进 **`--patch` overlay** 或用户自己的层里才有效；它**不能**替代安装。）

## 为什么手改 profile 不行

两种写法都实测过，都不生效：

| 写法 | 结果 |
|---|---|
| `name: dsh-dynamic-island-progress` | profile 的 `node_modules` 里没有这个包 → Node 模块解析报 `MODULE_NOT_FOUND` → 该行被**静默丢弃**，`--dump-config` 里连痕迹都没有 |
| `name: /abs/path/to/src/index.ts` | profile patch 层的 `name` 不是任意文件路径，同样不生效 |

根本区别是两套机制里 `name` 的语义不同：

- **`--patch` overlay**（`dsh web --patch ./cordis.patch.yml`）中的相对插件路径，
  相对于那个 patch 文件解析 —— 适合指向源码。
- **profile 的 `cordis.patch.yml`** 是组合的最后一层，其中的插件行按**包名**从
  profile 自己的 `node_modules` 解析 —— 前提是「包已经被安装进 profile」。

把 overlay 的写法搬进 profile 层，就得到一行既不安装、也解析不到的死行。

## 另一个坑：`@deepseek-ai/dsh-*` 的 peer 范围会被兼容性门禁求值

安装前，应用会遍历 `peerDependencies` 中所有
`@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 项，把**运行时的 dsh 版本**
（本机 `0.2.0-rc.2`）代进该范围求值；不满足就拒绝安装，
除非为「包名@版本 + 精确运行时版本」授一条豁免。

因此 dsh-* 的 peer 范围必须能被运行时版本满足。已装好的插件都这么写：

| 插件 | dsh-* peer |
|---|---|
| `dsh-ui-ux-pro-max` | `@deepseek-ai/dsh-tools: "*"` |
| `dshmarket` | `@deepseek-ai/dsh-settings: ^0.1.0-rc.7 \|\| ^0.1.1-rc.2 \|\| ^0.1.2-alpha.2 \|\| ^0.2.0-rc.1` |

本插件原先写死 `@deepseek-ai/dsh-tools: "0.2.1-alpha.2"`，而运行时是 `0.2.0-rc.2`
→ 不满足 → 会被门禁拦下。已改为 `"*"`。

**注意**：`devDependencies` 里仍然锁 `0.2.1-alpha.2` —— 那才是类型检查与测试实际使用的副本；
peer 范围只是一份兼容性声明。
