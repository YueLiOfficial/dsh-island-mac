# 第三方组件与素材声明

本包的 TypeScript 部分为 MIT（见 [LICENSE](../LICENSE)）。随包分发的
`bin/DynamicIslandBridge` 把下面的第三方代码**静态链接**进了同一个可执行文件，
因此需要在此声明。

## DynamicNotchKit

- 用途：SwiftUI 的刘海/浮动窗口与动画；`bin/DynamicIslandBridge` 静态链接了它。
- 版本：1.1.0（`swift/DynamicIslandBridge/Package.resolved` 锁定）
- 许可证：MIT
- 主页：https://github.com/MrKai77/DynamicNotchKit
- 版权：Copyright (c) Kai Azim

其 MIT 许可证全文与本包 [LICENSE](../LICENSE) 的条款一致。

## DeepSeek 鲸鱼标识

`swift/DynamicIslandBridge/Sources/DynamicIslandBridge/WhaleMarkData.swift` 里内嵌的
鲸鱼剪影**提取自 DeepSeek Harness 应用自带的图标**
（`/Applications/DeepSeek Harness.app/Contents/Resources/icon.png`，
经 `scripts/make-whale-mark.py` 阈值化处理），它是 DeepSeek 的商标/品牌标识。

- 本包的 MIT 许可证**不**涵盖这个标识——商标不是代码，不随代码授权。
- 自用（把它显示在自己机器上的 dsh 里）没有问题。
- 若要公开发布或再分发，请自行确认你有权在该场景下使用 DeepSeek 的品牌标识；
  如果不需要它，删掉 `WhaleMarkData.swift` 并把 `WhaleMark` 换回 `EmptyView()`
  即可，其余功能不受影响。

## 附：本包不包含的依赖

`src/` 依赖的 `@deepseek-ai/cordis`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/schemastery`
由 dsh 运行时提供（声明在 `peerDependencies`，不随本包分发）。
