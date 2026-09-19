#!/usr/bin/env node
const cfg = require('../config/index.cjs')
/**
 * gen-capabilities.cjs —— 生成「实例能力清单」
 *
 * 解决什么：agent 每开新会话都要**现场试一遍**才能知道能做什么（实测同一批探测重复 3 轮，
 * 撞同样 4 类墙：/etc 白名单、127.0.0.1 被 SSRF 拒、技能不存在、写边界），用户也跟着反复问
 * "能力有变化吗"。本脚本把**平台事实**固化成两份同源产物：
 *   ① <platform-dir>/state/capabilities.json      —— 给平台 API / 门户（机读）
 *   ② <bundled-skill-dir>/platform-capabilities/SKILL.md —— 给实例内 agent（它可被 skill 机制加载）
 *
 * 用法：node scripts/gen-capabilities.cjs            # 生成
 *       node scripts/gen-capabilities.cjs --print    # 只打印 JSON
 * 幂等、只写上述两个路径；任何探测失败只降级为 "unknown"，不报错退出。
 */
'use strict'
const { execFileSync } = require('node:child_process')
const { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

const STATE = cfg.stateDir()
const OUT_JSON = join(STATE, 'capabilities.json')
const BUNDLED = cfg.bundledSkillsDir()
const USERS = cfg.usersDir()
const PERMISSION_MODE = process.env.DSH_PERMISSION_MODE ?? 'danger-full-access'

const run = (cmd, args) => {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] })
      .trim().split('\n')[0].slice(0, 80)
  } catch {
    return 'MISSING'
  }
}

// ── 1) 工具链（宿主层安装 → 实例经 /usr 只读可见）──────────────
const tools = {
  node: run('node', ['-v']),
  npm: run('npm', ['-v']),
  pnpm: run('pnpm', ['-v']),
  python3: run('python3', ['--version']),
  git: run('git', ['--version']),
  curl: run('curl', ['--version']),
  ripgrep: run('rg', ['--version']),
  jq: run('jq', ['--version']),
  ffmpeg: run('ffmpeg', ['-version']),
  bubblewrap: run('bwrap', ['--version']),
}

// ── 2) 技能清单（共享层 + 各用户个人层）────────────────────────
const listSkills = (dir) => {
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir).filter((n) => {
      try { return statSync(join(dir, n)).isDirectory() } catch { return false }
    })
  } catch {
    return []
  }
}
const sharedSkills = listSkills(BUNDLED)
const perUserSkills = {}
if (existsSync(USERS)) {
  for (const uid of readdirSync(USERS)) {
    const s = listSkills(join(USERS, uid, 'home', 'skills'))
    if (s.length) perUserSkills[uid.slice(0, 8)] = s
  }
}

// ── 3) 能力清单（结论层；每项都可在平台上核对）──────────────────
const capabilities = {
  generatedAt: new Date().toISOString(),
  permissionMode: PERMISSION_MODE,
  note: PERMISSION_MODE === 'danger-full-access'
    ? '当前平台默认档位 = 完全权限（不在实例内叠加文件沙箱、不弹审批）。dsh 界面里可切换。'
    : '当前平台默认档位 = workspace-write（需要可用的沙箱后端；本机不可用时会拒绝任何 shell）。',
  read: {
    allowed: ['/usr（工具链与运行时，只读）', '/etc 白名单（见平台补丁）', '/proc /dev（沙箱内）', '自己的工作区 ws/ 与实例 home/'],
    denied: ['其他用户目录（users/<其他 uuid>/）', '宿主内部路径与凭据', '/etc 白名单以外的配置'],
  },
  write: {
    allowed: ['工作区 ws/**（含子目录）', '实例 home/**（如 home/skills、home/profiles）', '私有 /tmp'],
    denied: ['/usr /etc /var 等系统路径（只读挂载）', '平台策略文件（profile 的 cordis.patch.yml / package.json / pnpm-lock.yaml 为只读）'],
  },
  network: {
    egress: '可出公网（仅封云元数据端点 100.100.100.200）',
    denied: ['宿主 loopback 127.0.0.0/8（含 127.0.0.1:3080 门户、:22 等）', '内网卡与 docker0 网关', '平台公网 EIP'],
    hint: '**不要把 127.0.0.1 当作可用入口**：web_fetch 会以「resolves to a non-public IP」被拒；实例内也不可访问门户。',
  },
  tools,
  skills: {
    shared: sharedSkills,
    perUser: perUserSkills,
    hint: sharedSkills.length === 0 && Object.keys(perUserSkills).length === 0
      ? '当前平台**没有任何已注册技能**（共享层与个人层均为空）→ 调用 skill 工具必然报 unknown，请改用 bash/文件工具完成。'
      : '技能来自共享只读层与用户个人层；调用前先按名字确认存在于上表。',
  },
  fileDelivery: {
    hint: '把产出交给用户时：**用工作区相对路径**（如 `报告.md`），并提示「点会话页右下角『我的文件』可查看/下载」。',
    avoid: ['不要给服务器绝对路径', '不要给 127.0.0.1:<port> 链接（用户浏览器打不开）'],
    howToShare: '用户在会话页右下角「我的文件」面板里可浏览工作区并下载任意文件（平台代理，不暴露宿主路径）。',
  },
}

// ── 4) 写 JSON ────────────────────────────────────────────────
try {
  mkdirSync(STATE, { recursive: true })
} catch { /* 已存在 */ }
if (!process.argv.includes('--print')) {
  writeFileSync(OUT_JSON, JSON.stringify(capabilities, null, 2) + '\n')
}

// ── 5) 写 agent 可读的 SKILL.md（共享只读层）──────────────────
const fmtKV = (o) => Object.entries(o).map(([k, v]) => `| ${k} | ${v} |`).join('\n')
const skillMd = `---
name: platform-capabilities
description: 本 dsh 实例（托管在 dsh_ai1net 平台上）的**能力边界与交付约定**。开工前读它可省去自行探测；包含可读/可写路径、网络边界、可用工具版本、已注册技能清单、以及把文件交给用户的正确方式。
---

# 平台能力清单（由 \`scripts/gen-capabilities.cjs\` 生成 · ${capabilities.generatedAt}）

> **本文件是权威结论，不要靠现场试探推断能力**。若与实测冲突，先按本文件执行，并把差异报告给用户。

## 1. 权限档位
${capabilities.note}

## 2. 可读
| 允许 | 说明 |
|---|---|
${capabilities.read.allowed.map((x) => `| ${x} | — |`).join('\n')}

**不可读**：${capabilities.read.denied.join('；')}

## 3. 可写
**可写**：${capabilities.write.allowed.join('；')}
**不可写**：${capabilities.write.denied.join('；')}

## 4. 网络
- 出网：${capabilities.network.egress}
- **不可达**：${capabilities.network.denied.join('；')}
- ⚠️ ${capabilities.network.hint}

## 5. 可用工具（宿主层安装，全部实例共享）
| 工具 | 版本 |
|---|---|
${fmtKV(tools)}

## 6. 已注册技能
- 共享层（所有人可用）：${sharedSkills.length ? sharedSkills.join(', ') : '**（空）**'}
- 个人层：${Object.keys(perUserSkills).length ? JSON.stringify(perUserSkills) : '**（空）**'}
- ⚠️ ${capabilities.skills.hint}

## 7. 把文件交给用户（重要）
${capabilities.fileDelivery.hint}

- ❌ 不要做：${capabilities.fileDelivery.avoid.join('；')}
- ✅ 怎么做：${capabilities.fileDelivery.howToShare}
`

if (!process.argv.includes('--print')) {
  const dir = join(BUNDLED, 'platform-capabilities')
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), skillMd)
  } catch (e) {
    console.error('写 SKILL.md 失败:', e.message)
  }
}

if (process.argv.includes('--print')) {
  console.log(JSON.stringify(capabilities, null, 2))
} else {
  console.log('已生成:')
  console.log('  ' + OUT_JSON)
  console.log('  ' + join(BUNDLED, 'platform-capabilities', 'SKILL.md'))
  console.log('  工具: ' + Object.entries(tools).map(([k, v]) => `${k}=${v}`).join(' '))
  console.log('  技能: 共享 ' + sharedSkills.length + ' 个，个人层用户 ' + Object.keys(perUserSkills).length + ' 个')
}
