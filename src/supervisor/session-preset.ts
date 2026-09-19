/**
 * 会话权限档位读取。
 *
 * 背景：档位由 `DSH_PERMISSION_MODE` 决定，但 **dsh 在"会话创建时"把它播种进会话**，
 * 之后平台改默认值**不会**更新既有会话 → 老会话仍停在 `workspace-write`，而本机沙箱
 * 后端不可用（内核无 Landlock、bwrap 在平台合成根内探测失败）→ dsh **fail-closed 拒绝
 * 任何 shell**。用户只会看到「bash 不可用」，无从判断原因。
 *
 * 本模块从会话事件流里读出**最近修改的那个会话**的 `permission/preset`，交给路由层
 * 判断"是否与平台默认不一致"，从而在实例页面上给出提示。
 *
 * 只读：仅解压文件头部的若干 zstd 帧，不写任何东西。
 * @module dsh_ai1net/supervisor/session-preset
 */
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

/** zstd 帧魔数：会话文件是**多帧拼接**，必须按它切分后逐帧解压。 */
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 解压文件头部若干帧（够覆盖 session 元信息与 permission/preset 记录，通常在第 1 帧）。 */
function headFrames(buf: Buffer, maxFrames = 6): string {
  const offsets: number[] = []
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf.compare(MAGIC, 0, 4, i, i + 4) === 0) offsets.push(i)
  }
  const list = offsets.length > 0 ? offsets.slice(0, maxFrames) : [0]
  let out = ''
  for (let f = 0; f < list.length; f++) {
    const start = list[f]
    const end = f + 1 < list.length ? list[f + 1] : buf.length
    try {
      out += zstdDecompressSync(buf.subarray(start, end)).toString('utf8')
    } catch {
      /* 单帧损坏/被截断：忽略，继续下一帧 */
    }
  }
  return out
}

export interface SessionPreset {
  /** 会话目录名（`session-<uuid>` 或裸 uuid）。 */
  sessionId: string
  /** 该会话当前生效的权限档位（取最后一次 `permission/preset` 记录）。 */
  preset: string
  /** 会话文件最后修改时间（ms）。 */
  updatedAt: number
}

/** 用户数据根下的会话目录：`<userRoot>/home/sessions`。 */
export function sessionsDir(homeRoot: string): string {
  return join(homeRoot, 'sessions')
}

/**
 * 读一个 `session.jsonl.zstd` 的权限档位。
 * 取**最后一条** `permission/preset`（用户在 UI 里切换档位会追加新记录）。
 */
function readPreset(file: string): string | undefined {
  let text: string
  try {
    const st = statSync(file)
    const HEAD = 256 * 1024
    const TAIL = 64 * 1024
    if (st.size <= 4 * 1024 * 1024) {
      // 常见会话 < 4MB：直接整读（切换档位的记录可能在文件尾）
      text = headFrames(readFileSync(file), 12)
    } else {
      const fd = openSync(file, 'r')
      try {
        const head = Buffer.allocUnsafe(HEAD)
        const readHead = readSync(fd, head, 0, HEAD, 0)
        const tailLen = Math.min(TAIL, st.size)
        const tail = Buffer.allocUnsafe(tailLen)
        readSync(fd, tail, 0, tailLen, st.size - tailLen)
        text = headFrames(head.subarray(0, readHead), 6) + headFrames(tail, 6)
      } finally {
        closeSync(fd)
      }
    }
  } catch {
    return undefined
  }
  const re = /"type":"permission\/preset"[^\n]*?"preset":"([^"]+)"/g
  let last: string | undefined
  for (const m of text.matchAll(re)) last = m[1]
  return last
}

/** 该用户**最近修改的**会话及其档位（跨全部工作区），无会话则返回 undefined。 */
export function latestSessionPreset(homeRoot: string): SessionPreset | undefined {
  const dir = sessionsDir(homeRoot)
  if (!existsSync(dir)) return undefined
  let best: { file: string; id: string; mtime: number } | undefined
  for (const slug of readdirSync(dir)) {
    let sids: string[]
    try {
      sids = readdirSync(join(dir, slug))
    } catch {
      continue
    }
    for (const sid of sids) {
      const file = join(dir, slug, sid, 'session.jsonl.zstd')
      try {
        const st = statSync(file)
        if (!st.isFile()) continue
        if (best === undefined || st.mtimeMs > best.mtime) best = { file, id: sid, mtime: st.mtimeMs }
      } catch {
        /* 无会话文件（空目录）→ 跳过 */
      }
    }
  }
  if (best === undefined) return undefined
  const preset = readPreset(best.file)
  if (preset === undefined) return undefined
  return { sessionId: best.id, preset, updatedAt: best.mtime }
}
