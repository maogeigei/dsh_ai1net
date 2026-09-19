/**
 * 块级切分 —— **内容寻址的第一块地基**（覆盖网络线 序㉔ · 内容分发）。
 *
 * ## 一句话说清它是什么
 * 把一段字节流按**固定大小**切成块，**每块的 id 是它自己内容的哈希**。
 * ⇒ 同一份内容切两次，块 id 序列**逐字节一致**；改 1 字节，**只有落在那一个块里的 id 变**
 *   （其余块的 id 不变 ⇒ 对端已持有的那几块**不用重传**）。
 *
 * ## 为什么必须是"块级"而不是"包级"
 * 包级（Peer Cache 式）的 id 挂在**整个包**上 ⇒ 内容一变，**全部 peer 源同时失效**，
 * 每台设备只能各自回源 —— 这正是本线已实证过的「**版本一发就全量重拉**」风暴成因。
 * 块级（BranchCache 式）的 id 挂在**块**上、**与文件无关** ⇒
 *   · **只拿到一部分也能开始共享**（E2）；
 *   · 版本更新**只传变化的块**（E3）。
 *
 * ## 两条设计决定（**已定项，可推翻**）
 * 1. **固定块 + 不引入 CDC（内容定义切分）**：固定块实现简单、零依赖、可复算；
 *    代价是"在块边界插入/删除 1 字节"会让其后所有块 id 改变（CDC 能缓解）。
 *    ⚠️ 之所以敢先不做 CDC：本场景的内容是**构建产物**（版本发布刷新），
 *    变更形态是"整文件替换"而非"文中插字" ⇒ 固定块的边界漂移**在实践中不触发**。
 *    若将来出现"差量只有几字节却全量重传"的实测证据，再上 CDC（登记为回头条件）。
 * 2. **块 id = `sha256(块字节)` 的前 32 hex 位**：够长到碰撞不可能（128 bit），
 *    又短到 URL / 索引友好。⚠️ **不掺入内容长度、不掺入序号** ——
 *    id 必须**只由字节内容决定**，否则"同内容不同来源 ⇒ 不同 id"会让共享失效（这是本线的核心判据）。
 *
 * ## 🆕 序㉘ · 单 B：**可选的编解码钩子**（缺省 ⇒ 本模块行为**逐字不变**）
 * 组密钥加密（`content/crypto.ts`）落地后，块 id 的口径从"明文哈希"改成
 * **密文哈希**（"β′"，见该单 §7.3）。做法**不是**在切分层里嵌加密逻辑，而是把
 * "字节变换"作为**注入的纯函数**传进来：
 * - `encode`（写侧）：`明文块 → 落库字节`。给了它 ⇒ `Chunk.bytes` 是**落库字节**（密文）、
 *   `Chunk.id = sha256(落库字节)`；⛔ 不传 ⇒ 与序㉔ **完全一致**（27 个既有用例一行不改）。
 * - `decode`（读侧，在 `reassemble`）：`落库字节 → 明文块`。**恢复**原始内容的那一步。
 *
 * 🔑 为什么"加密"必须挂在这里而不是 `store`：`store` 的键就是 id，而 id 是**由字节算出来的**
 * ⇒ 口径只能有一个地方定义（本模块）。`crypto.ts` 只提供 `encode/decode`，⛔ 不知道块的概念。
 * ⚠️ 唯一例外是**解密实现**本身（`crypto.decodeBlock`）——它是**一处实现、两个调用位**
 * （`source.ts` 链的统一返回点 / 本模块的重组位），同一批字节**只过其中一处**。
 *
 * ## 🆕 序㊻ · C（域分离）：**per-network keyed hash**
 * 块 id / 内容 id 从"裸哈希"升级为 **`HMAC-SHA256(netKey, bytes)`**，输出仍取前
 * `BLOCK_ID_HEX_LEN` = 32 hex。`netKey` 是**域密钥**（由 `crypto.ts` 从组密钥按 network
 * 维度派生），经与 `encode` / `decode` **同一个注入通道**（`ChunkTransforms.netKey`）传进来。
 * - **治**：跨 network 的 COF / LRI（同一块 id 在 A / B 两个网同时出现 ⇒ 推出跨租户相关性）。
 * - ⛔ **不治**：同一 network 内部持钥者枚举（那是 `04-133 §3.2` 写死的口径）。
 * - 🔴 **缺省不传 / 传空 ⇒ 回落裸 `sha256`** —— 这既是**回滚路径**，也是"既有单测语义不变"的保证。
 *
 * ## ⛔ 本模块**不做**的事（故意）
 * - 不做 IO、不读文件、不网络 —— **纯函数**，可单测、可在任何进程里跑；
 * - 不做压缩；⛔ **不自己实现加解密**（只调用注入的 `encode` / `decode`）；
 * - 🔑 **不自己派生 `netKey`**（本模块不认识"组密钥"这个概念 —— 派生在 `crypto.ts`）；
 * - 不做"块 → 来源"的映射（那是 `store.ts` / `source.ts` 的事）。
 *
 * @module dsh_ai1net/net/relay/content/chunker
 */

import { createHash, createHmac } from 'node:crypto'

/**
 * 默认块大小（字节）—— **1 MiB**。
 *
 * 定这个数的依据（S0 P1 实测）：单份首屏合并脚本 **11,363,655 B ≈ 10.8 MB**，
 * 取 1 MiB ⇒ **一份包约 11 块**。这个粒度同时满足三件事：
 * - **够粗**：块数少 ⇒ 索引 / 广播 / 请求的**控制面开销**可控（block 级元数据 ≈ 11 条/份）；
 * - **够细**：改一个文件（典型几百 KB）**只影响 1–2 块** ⇒ E3「只传变化块」成立；
 * - **对齐友好**：1 MiB 是 2 的幂 ⇒ 定长切分的边界可手算复现。
 *
 * ⚠️ 值是**常量而非配置**：块大小一变，历史块的 id 全部失效 ⇒
 * 它必须是"全集群唯一一个版本"的口径。要改就整体换代（见 §9 回头条件）。
 */
export const DEFAULT_BLOCK_SIZE = 1024 * 1024

/** 块 id 的 hex 长度（`sha256` 前 32 位 = 128 bit）。 */
export const BLOCK_ID_HEX_LEN = 32

/** 块 id 的合法形状（纯小写 hex）。 */
const BLOCK_ID_RE = new RegExp(`^[0-9a-f]{${BLOCK_ID_HEX_LEN}}$`)

/** 一个块（内容 + 它的内容寻址 id + 在原流中的序号）。 */
export interface Chunk {
  /** 内容寻址 id = `sha256(bytes)` 前 `BLOCK_ID_HEX_LEN` 位。**只由字节决定**。
   * ⚠️ 给了 `encode`（加密）时，`bytes` 是**落库字节**（密文）⇒ id 也挂密文（"β′"）。 */
  id: string
  /** 该块在原流中的**序号**（0 起）。⚠️ 序号**不参与** id 计算 —— 它只是重组用的坐标。 */
  index: number
  /** 该块在原流中的起始字节偏移。 */
  offset: number
  /** 块字节（`index` 为最后一块时可能 < 块大小）。给了 `encode` ⇒ 这里是**落库字节**。 */
  bytes: Buffer
}

/** 切分结果：块序列 + 整体指纹。 */
export interface ChunkedContent {
  /** 块序列（按 `index` 升序）。 */
  chunks: Chunk[]
  /** 整份内容的 id。⚠️ 给了 `encode` ⇒ 挂在**落库字节流**上（组外不可见）；缺省 = 明文哈希。 */
  contentId: string
  /** 整份内容长度（字节，**明文口径**）。 */
  size: number
  /** 本份内容**去重后**的块 id 列表（顺序 = 首次出现序）。⚠️ 同内容重复出现时只算一次。 */
  ids: string[]
}

/**
 * 可选的**字节变换钩子**（序㉘ · 单 B）。
 *
 * ⚠️ 两个都必须是**纯函数且确定性**：同输入必须给同输出。给了非确定性实现（例如随机 iv），
 * 块 id 会次次不同 ⇒ 去重与 peer 命中**全废**（`E1` 从 1.00× 退回 4.00×）。
 */
export interface ChunkTransforms {
  /** 写侧：`明文块 → 落库字节`（加密）。缺省 = 恒等（⛔ 与序㉔ 逐字一致）。 */
  encode?: (plain: Buffer) => Buffer
  /** 读侧：`落库字节 → 明文块`（解密）。失败 ⇒ 返回 `undefined`（由调用方**具名**处置）。 */
  decode?: (stored: Buffer) => Buffer | undefined
  /**
   * 🆕 序㊻ · C（域分离）：块 id 的**域密钥**（per-network keyed hash）。
   *
   * 给了它 ⇒ `blockIdOf` / `contentIdOf` 走 `HMAC-SHA256(netKey, bytes)`（输出仍取前
   * `BLOCK_ID_HEX_LEN` 位）；⛔ **缺省 / 空 ⇒ 回落裸 `sha256`**（= 回滚路径）。
   *
   * ⚠️ 必须是**确定性**的：它只由「组密钥 ＋ network」派生（`crypto.ts#deriveBlockIdKey`）。
   * ⛔ **不许把 network 之外的随机量塞进来** —— 那会让块 id 次次不同 ⇒ 去重与 peer 命中全废
   * （`E1` 退回 `4.00×`，与 `encode` 非确定性的后果**同一条路径**）。
   */
  netKey?: Buffer
}

/**
 * 两个 id 函数的**唯一实现**（口径只能有一处）。
 *
 * ⚠️ 刻意写成"两条整句分支"而不是"选一个 Hash 对象再链式调用"：后者的联合类型在
 * `strict` 下会漂，而这个函数是**全集群块 id 口径的唯一定义处** ⇒ 宁可啰嗦、不要巧。
 */
function idDigestOf(bytes: Buffer, netKey?: Buffer): string {
  const hex =
    netKey === undefined || netKey.length === 0
      ? createHash('sha256').update(bytes).digest('hex')
      : createHmac('sha256', netKey).update(bytes).digest('hex')
  return hex.slice(0, BLOCK_ID_HEX_LEN)
}

/**
 * 块 id。
 *
 * - ⛔ 不传 `netKey`（或缺省 / 空）⇒ **裸 `sha256(块字节)`** 前 `BLOCK_ID_HEX_LEN` 位（与序㉔ 逐字一致）；
 * - ✅ 传了 `netKey` ⇒ **`HMAC-SHA256(netKey, 块字节)`** 前同样位数（序㊻ · C 域分离）。
 */
export function blockIdOf(bytes: Buffer, netKey?: Buffer): string {
  return idDigestOf(bytes, netKey)
}

/**
 * 整份内容的 id。
 *
 * - ⛔ 不传 `netKey` ⇒ 裸 `sha256(全部字节)`（与序㉔ 逐字一致）；
 * - ✅ 传了 `netKey` ⇒ `HMAC-SHA256(netKey, 全部字节)`（序㊻ · C 域分离）。
 */
export function contentIdOf(bytes: Buffer, netKey?: Buffer): string {
  return idDigestOf(bytes, netKey)
}

/** 块 id 是否合法（纯小写 hex、长度恰好 `BLOCK_ID_HEX_LEN`）。 */
export function isBlockId(raw: string): boolean {
  return BLOCK_ID_RE.test(raw)
}

/**
 * 按**固定块大小**切分一段内容。
 *
 * 三条不变量（单测的判据）：
 * 1. **确定性**：同一份字节重复切 ⇒ 块 id 序列**完全一致**；
 * 2. **局部性**：改 1 字节 ⇒ **只有 1 个块**的 id 变（其余 id 逐位相同）；
 * 3. **可重组**：`offset` 连续且 `sum(len(chunks)) === size`。
 *
 * @param bytes 待切分内容
 * @param blockSize 块大小（缺省 `DEFAULT_BLOCK_SIZE`）。必须 > 0。
 * @param transforms 可选的 `encode`（加密）—— 给了它 ⇒ `Chunk.bytes` / id 全部挂**落库字节**。
 * @throws 当 `blockSize <= 0` 时抛错（⛔ 静默取默认会把"配错"伪装成"切出来的块不对"）
 */
export function chunkify(
  bytes: Buffer,
  blockSize: number = DEFAULT_BLOCK_SIZE,
  transforms?: ChunkTransforms,
): ChunkedContent {
  if (!Number.isInteger(blockSize) || blockSize <= 0) {
    throw new Error(`chunker: 块大小必须是正整数，收到 ${String(blockSize)}`)
  }
  const encode = transforms?.encode
  const netKey = transforms?.netKey
  const chunks: Chunk[] = []
  const seen = new Set<string>()
  const ids: string[] = []
  for (let offset = 0, index = 0; offset < bytes.length; offset += blockSize, index += 1) {
    const slice = bytes.subarray(offset, Math.min(offset + blockSize, bytes.length))
    // ⚠️ 必须 `Buffer.from(...)` 复制：`subarray` 是**视图**，原 buffer 被复用时会**内容漂移**
    //    （块已落盘、id 却是按旧内容算的 ⇒ 校验必红且极难定位）。
    const own = encode === undefined ? Buffer.from(slice) : encode(Buffer.from(slice))
    const id = blockIdOf(own, netKey)
    chunks.push({ id, index, offset, bytes: own })
    if (!seen.has(id)) {
      seen.add(id)
      ids.push(id)
    }
  }
  // 整体指纹：给了 `encode` ⇒ 挂**落库字节流**（⛔ 否则整份内容的指纹会继续暴露给中继）。
  const contentId =
    encode === undefined
      ? contentIdOf(bytes, netKey)
      : contentIdOf(Buffer.concat(chunks.map((c) => c.bytes)), netKey)
  return { chunks, contentId, size: bytes.length, ids }
}

/**
 * 只取"切分坐标"（**不含块字节**）—— 给"我知道整份内容要什么块"的场景用
 * （例如先查本地 / peer 有没有，再决定去哪取）。
 *
 * ⚠️ 与 `chunkify` 的 id 算法**必须同源**；两者由 `chunkifyOfPlan` 一致性单测锁住。
 * ⚠️ 给了 `encode` ⇒ 这里算出的 id 是**落库 id**（查本地 / peer 时必须用这一套）。
 */
export function planOf(
  bytes: Buffer,
  blockSize: number = DEFAULT_BLOCK_SIZE,
  transforms?: ChunkTransforms,
): { ids: string[]; size: number } {
  if (!Number.isInteger(blockSize) || blockSize <= 0) {
    throw new Error(`chunker: 块大小必须是正整数，收到 ${String(blockSize)}`)
  }
  const encode = transforms?.encode
  const netKey = transforms?.netKey
  const ids: string[] = []
  for (let offset = 0; offset < bytes.length; offset += blockSize) {
    const slice = bytes.subarray(offset, Math.min(offset + blockSize, bytes.length))
    ids.push(blockIdOf(encode === undefined ? slice : encode(Buffer.from(slice)), netKey))
  }
  return { ids, size: bytes.length }
}

/**
 * 按一份**块 id 计划**重组内容。
 *
 * ⚠️ **每个块取回后必须自行复算 id 并与计划比对** —— 这就是 `E4` 的落点：
 * 篡改块 ⇒ 复算 id ≠ 计划 id ⇒ **丢弃并报错**（⛔ 不落盘、⛔ 不拼接）。
 * ⇒ "中间节点被控也改不了块"（设计说明 §7 的"完整性"那一半）。
 *
 * 🆕 序㉘ · 单 B：`parts` 是**落库字节**（加密启用时即密文）；给了 `transforms.decode`
 * ⇒ **先验 id（对落库字节）、再解密、后拼接**。判据顺序刻意如此：
 * 完整性必须在**密文层**先成立（否则"解出来是乱码"会伪装成"块被篡改"）。
 *
 * @throws 当某个块缺失 / id 不符 / 解密失败时抛错（附带 `index` 与 `expected`/`actual`，便于定位）
 */
export function reassemble(plan: string[], parts: Map<string, Buffer>, transforms?: ChunkTransforms): Buffer {
  const decode = transforms?.decode
  const netKey = transforms?.netKey
  const out: Buffer[] = []
  for (let index = 0; index < plan.length; index += 1) {
    const expected = plan[index]
    if (expected === undefined) throw new Error(`chunker: 计划在第 ${index} 项处断裂`)
    const got = parts.get(expected)
    if (got === undefined) throw new Error(`chunker: 缺少块 index=${index} id=${expected}`)
    // 🔴 复算必须用**同一把域密钥**（`netKey`）。⛔ 漏传 ⇒ 启用域分离后**每个块都判校验失败**
    //    （现场表现 = "取回的块全被丢弃"，而块本身是好的 —— 这正是本线要根治的难定位形态）。
    const actual = blockIdOf(got, netKey)
    if (actual !== expected) {
      throw new Error(`chunker: 块校验失败 index=${index} expected=${expected} actual=${actual}（丢弃）`)
    }
    if (decode === undefined) {
      out.push(got)
      continue
    }
    const plain = decode(got)
    if (plain === undefined) {
      // ⛔ 不许静默跳过、⛔ 不许拼半截：解密失败 = 这块不可用 ⇒ 与"缺少块"同等处置（但**点名**）
      throw new Error(`chunker: 块解密失败 index=${index} id=${expected}（认证未过 ⇒ 丢弃）`)
    }
    out.push(plain)
  }
  return Buffer.concat(out)
}
