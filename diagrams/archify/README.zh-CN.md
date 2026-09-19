> **English (primary): [README.md](README.md)** ｜ **[中文文档](README.zh-CN.md)（当前）**

[← 返回仓库 README](../../README.zh-CN.md)

# 交互式图示

这里是与本平台相关的 **12 张自包含 HTML 图示** —— 6 个主题，每个都有中英两份。每张都是单文件、不请求任何外部资源：用浏览器直接打开即可，离线可用，自带明暗主题切换、缩放平移、搜索、聚焦，以及 PNG / SVG / JPEG 导出。

它们由 **[Archify](https://github.com/tt-a1i/archify)**（MIT）生成 —— 一个把带类型的 JSON 规格编译成经过校验的自包含 SVG/HTML 产物的渲染器。

## 架构

| 图示 | 讲的是什么 |
|---|---|
| **[architecture.zh-CN.html](architecture.zh-CN.html)** | 单机部署：请求链路、每用户隔离，以及围绕它的护栏与治理 |
| **[cluster-architecture.zh-CN.html](cluster-architecture.zh-CN.html)** | 集群模式如何把同一套部署拆到多台主机，以及「按租约归属」改变了什么 |
| **[overlay-architecture.zh-CN.html](overlay-architecture.zh-CN.html)** | NAT 之后的节点如何互通：每台一条出向连接、中继只绑回环、直连可选，以及身份与地址从哪来 |

## 行为

| 图示 | 类型 | 讲的是什么 |
|---|---|---|
| **[instance-wake.zh-CN.html](instance-wake.zh-CN.html)** | 时序 | 用户回到一个空闲时已被回收的实例，会发生什么 |
| **[instance-lifecycle.zh-CN.html](instance-lifecycle.zh-CN.html)** | 生命周期 | 实例经过哪些状态，崩溃如何就地修复 |
| **[plugin-admission.zh-CN.html](plugin-admission.zh-CN.html)** | 流程 | 插件从提交到出现在用户启用列表里，中间在哪里被拦下，以及**预检不通过后如何改造并重新提交** |

每张图示都配有一份英文版，文件名不带 `.zh-CN` 后缀。

> 上一层的**手绘 SVG 图**（`diagrams/*.svg`）保持原样，README 仍用它们做内嵌展示。这里的 HTML 图是它们的**交互式对照版，不是替代品**。

## 怎么打开

用任意现代浏览器直接打开文件即可 —— 不需要构建，也不需要安装任何东西。

## 怎么重新生成或修改

每张图对应的规格文件在 [`sources/`](sources/) 下。**JSON 是可编辑的源，HTML 是编译产物** —— 要改请改 JSON，不要改 HTML。

```bash
# 在 tt-a1i/archify 的检出目录里执行
node bin/archify.mjs validate architecture sources/architecture.architecture.json --quality showcase --json
node bin/archify.mjs deliver  architecture sources/architecture.architecture.json architecture.html --quality showcase
```

`validate` 给出构图检查回执；`deliver` 会重新渲染、重新检查，**只在全部通过后**才原子替换输出。这里每张图都以 `showcase` 质量档交付，**9/9 项检查通过、0 错 0 警**。

## 关于手写画布尺寸

每张图都显式设置了 `meta.viewBox`。默认情况下渲染器按内容自算画布，而那些偏高的图型算出来的画布偏窄，导致查看器把它**放大**到 1:1 以上 —— 于是桌面尺寸下页面高度溢出。显式给一块更宽的画布，能把缩放压到 ≤1，从而适配首屏。这个窗口不是无限的：**画布太宽，节点文字又会小于可读下限**，所以画布宽度和卡片文字长度需要一起权衡。

> 图示以概括方式描述本平台自身的架构。它们是**图，不是部署清单** —— 权威描述见 [manual/architecture.zh-CN.md](../../manual/architecture.zh-CN.md)。
