# 发布这个插件

发布物是一个 **dsh bundle**（一个 npm 包），用户通过应用内的**插件管理器**安装。
本文记录发布步骤，以及踩过的坑 —— 它们都会让「装上了但不工作」。

## 发布前必须成立的三件事

| 要求 | 为什么 | 谁保证 |
|---|---|---|
| `main` 指向**编译后的 JS** | Node 拒绝为 `node_modules` 下的文件剥离 TypeScript 类型（`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`）。`main: src/index.ts` 在 linked checkout 里能跑，一装进 node_modules 就 `failed to import` | `scripts/build-bundle.sh`（`prepack` 会跑） |
| `bin/DynamicIslandBridge` 是 **universal**（arm64 + x86_64），且 helper 自包含 | 只编本机架构 → Intel Mac 直接装不上；helper 若依赖同目录的 `.bundle`，复制/打包后就崩 | `scripts/build-helper.sh`（默认 universal，并断言 minos/架构）；图标以 base64 内嵌在 `WhaleMarkData.swift` |
| `@deepseek-ai/dsh-*` 的 peer 范围能被**运行时版本**满足 | 安装前应用会把运行时 dsh 版本代进这些范围求值，不满足就拒绝安装（除非授精确版本豁免） | `package.json` 里 `dsh-tools: "*"`；`cordis`、`schemastery` 不匹配 `dsh-*` 前缀，不参与门禁 |

## 两条发布渠道

先本地验证，再发。两种渠道都会触发 `prepack`：

```sh
bash scripts/verify-packed-tarball.sh --boot     # 打包 → 装进一次性 profile → 启动 → 验证真的加载
```

### 1. 本地 tarball / GitHub Release

```sh
npm run build                       # 编译 lib/ + universal helper
npx pnpm pack                       # 产出 dsh-dynamic-island-progress-<version>.tgz
```

把 `.tgz` 交给使用者，他们在**插件管理器 → 添加插件**里填这个文件路径即可。

⚠️ `pnpm pack` **不保留可执行位**（`npm pack` 会保留）：tarball 里 `bin/DynamicIslandBridge`
的权限是 `0644`。插件在 spawn 之前会自己补上这一位
（`src/helper.ts`，由 `test/helper.test.ts` 的
「helper 缺少可执行位时（pnpm pack 会丢掉它）插件在 spawn 前补回来」钉住）。
如果哪天那条 chmod 被删掉，所有 tarball 安装都会以 `helper not reachable` 失败。

### 2. 发布到 npm

```sh
npm publish        # prepack 会先构建；files 白名单决定装什么
```

之后用户只需在插件管理器里填包名：

```
dsh-dynamic-island-progress
```

发布前建议先确认包名在 registry 上可用，并想清楚
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 里那条商标说明：
包里内嵌了 DeepSeek 的鲸鱼标识。

## 包白名单（`files`）

```
lib/                      编译后的 JS —— main 指向 lib/index.js
src/                      源码，便于对照阅读
cordis.patch.yml          bundle 的配置层
bin/DynamicIslandBridge   universal 原生 helper
THIRD_PARTY_NOTICES.md    DynamicNotchKit(MIT) 与商标声明
```

`LICENSE` 与 `README.md` 由 npm 自动包含。`lib/` 与 `bin/` 都是 git-ignored 的构建产物，
所以**必须靠 `prepack` 现场构建**，不能指望仓库里有。

## 从本地目录安装（开发时）

插件管理器也接受**本地绝对路径**。注意这条路径下 pnpm 不会跑 `prepack`，
所以**先手动构建**，否则装进去的包缺 `lib/`，加载会失败：

```sh
npm run build
# 然后在插件管理器 → 添加插件里填：/path/to/dsh-dynamic-island
```

若插件管理器提示需要授权构建脚本（pnpm ≥10 对本地/git 依赖的默认行为），
那一步是在授权「该包的代码在你的机器上执行」；本包不需要任何安装期脚本，
所以更省事的做法是改用上面的 tarball 渠道。

## 版本兼容性

- dsh 运行时：`0.2.0-rc.2`（本次验证所用）
- macOS：声明下限 13.0（`Package.swift` 的 `platforms`，`build-helper.sh` 会断言
  两个 slice 的 `minos` 都是 13.0）；**实测只在 macOS 26 / Apple Silicon 上跑过**
- 仅支持 macOS（`os: ["darwin"]`）：装到 Linux/Windows 会明确报错，而不是装上一个死插件

## 不要做的事

- **不要把手改 profile 当作安装方式。** 详见 [scripts/mount-patch.md](../scripts/mount-patch.md)：
  profile 层里的插件行按包名从 profile 自己的 `node_modules` 解析，
  而包没被安装时那一行会被**静默丢弃**（没有报错、没有日志）。
- **不要把图标挪回 `Resources/`。** 那会重新引入「可执行文件旁边必须有 .bundle」的依赖，
  复制或打包后 helper 会在第一次渲染时崩掉。
- **不要用 `cp` 覆盖 `bin/DynamicIslandBridge`。** 有旧 helper 进程占着该路径时，
  macOS 会杀掉下一个 exec 这个路径的进程（表现为 `Killed: 9`）；
  `build-helper.sh` 用 rename 原子替换来避免这一点。
