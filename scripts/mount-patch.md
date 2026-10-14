# 手动挂载步骤（由用户自行执行）

本文件只是**交付给你的粘贴片段**。插件不会、也不能自动修改你的 profile 配置。

## 目标位置

- profile 目录：`/Users/yueli/.dsh/profiles/desktop`
- 目标文件：`/Users/yueli/.dsh/profiles/desktop/cordis.patch.yml`

该文件**已包含你既有的模型配置与 UI 设置**，因此：

> ⚠️ **不要覆盖该文件，只追加。**

## 步骤

1. 备份：

   ```sh
   cp ~/.dsh/profiles/desktop/cordis.patch.yml \
      ~/.dsh/profiles/desktop/cordis.patch.yml.bak
   ```

2. 打开 `~/.dsh/profiles/desktop/cordis.patch.yml`。它是一个**顶层 YAML 数组**
   （文件顶部注释已说明）。把下面这两行**追加到数组末尾**，与现有条目同级：

   ```yaml
   - insert:
       - id: dynamic-island-progress
         name: dsh-dynamic-island-progress
         config: {}
   ```

   注意缩进：`- insert:` 要在第 0 列（与其他 `- id:` 条目对齐），其下的
   `- id:` / `name:` / `config:` 缩进 4 个空格。

3. 验证该层已被加载（**不要**用 `--dump-config` 之外的写入操作）：

   ```sh
   dsh --profile desktop --dump-config | grep -i dynamic-island
   ```

   期望看到 `# == dsh-dynamic-island-progress` 层。

## 一次性试验（不改持久配置）

如果只想试一次而不动 profile，用 `--patch` overlay：

```sh
dsh web --patch ./cordis.patch.yml
```

注意：**不要**为验证另起一个服务器来替换你当前正在用的 Web GUI
（`http://127.0.0.1:19387`）——overlay 只在下次启动时生效。

## 关于 `config`

上面用了 `config: {}`，即全部走默认值：

| 配置项 | 默认值 |
|---|---|
| `socketPath` | `~/Library/Application Support/dsh-island/island.sock` |
| `helperPath` | `<包目录>/bin/DynamicIslandBridge` |
| `connectTimeoutMs` | `10000` |
| `idleTimeoutMs` | `120000` |
| `graceMs` | `3000` |

**警告**：patch 是**整行替换 `config`，不是深度合并**。若你要覆盖其中一项，
必须把**所有**想保留的键一并写出，否则未列出的键会退回插件 schema 默认值。
例如只改超时：

```yaml
- insert:
    - id: dynamic-island-progress
      name: dsh-dynamic-island-progress
      config:
        connectTimeoutMs: 20000
```

## 卸载

从 `cordis.patch.yml` 中删除该条目，或（若用 `dsh plugin add` 安装过）
执行 `dsh plugin --profile desktop remove dsh-dynamic-island-progress`。
