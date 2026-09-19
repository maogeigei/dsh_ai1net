/**
 * 覆盖网络中继（relay）—— **自研、零新增依赖、零新增公网口**（传输方案 §10 定案）。
 *
 * ## 一段话说完它是什么
 * worker 侧 `RelayClient` **只拨出**一条 wss；`RelayServer` **只绑回环**，为每个注册端口在
 * `127.0.0.1` 上开一条监听；Manager 连那条回环口 ⇒ 字节经多路复用跑回 worker 本地端口。
 * 对 Manager 而言地址形态与 sshd 版**完全同形**（`host:port`），所以换它是 env 级动作。
 *
 * ## 三条硬约束（来自实测，改动前先读）
 * 1. **零新增公网口**：47 无本机防火墙（`nft INPUT policy accept`）⇒ 绑 `0.0.0.0` 即公网可达。
 * 2. **worker 只拨出**：任何"在 worker 上开监听"的方案都让暴露面从 O(1) 变 O(N)。
 * 3. **精确 ACK**：注册与开流都必须有确认帧，未确认即断并计数 —— 治的是 SSH 版"静默失败"的病根。
 *
 * @module dsh_ai1net/net/relay
 */

export { RelayServer, RELAY_PATH, DEFAULT_RELAY_PORT, DEFAULT_AUTH_DEADLINE_MS, DEFAULT_AUTH_WINDOW_MS, DEFAULT_IDLE_TIMEOUT_MS, DEFAULT_HB_SEC, DEFAULT_MAX_STREAMS_PER_PORT, DEFAULT_QUEUE_MAX_BYTES, DEFAULT_PRESENCE_GRACE_MS, DEFAULT_PRESENCE_OFFLINE_DEBOUNCE_MS, DEFAULT_PRESENCE_BATCH_MS, DEFAULT_PRESENCE_TTL_FACTOR, DEFAULT_PRESENCE_SUB_MAX } from './server.js'
export type { RelayServerOptions, RelayStatus, PresenceEntry } from './server.js'
export { RelayClient, describeClientStatus, gracefulBurstMsDefault, openedChannelFailedTerminally, waitUpOnStatus } from './client.js'
export type { RelayClientOptions, RelayClientStatus, RelayClientState, WebSocketLike, WebSocketCtor, WaitUpStatusOptions, RelayPresenceEntry, RelayPresenceStatus, RelayPresenceState } from './client.js'
export { RelayRendezvous } from './rendezvous.js'
export type { RelayRendezvousOptions } from './rendezvous.js'
export { RelayDialer } from './dialer.js'
export type { RelayDialerOptions } from './dialer.js'
export { RelayFailoverSupervisor, relayFailoverThresholds } from './switcher.js'
export type {
  RelayChannelHandle,
  RelayFailoverDeps,
  RelayFailoverStats,
  RelayFailoverThresholds,
} from './switcher.js'
export { MuxDuplex } from './duplex.js'
export type { MuxDuplexOptions } from './duplex.js'
export { MUX, WS_CLOSE, acceptWebSocket, encodeMux, decodeMux, encodeJsonFrame, parseJsonPayload, WsConnection } from './wire.js'
export type { MuxFrame, MuxType, WsServerOptions } from './wire.js'
export { OPS_NETWORK, NAME_SEP, assertNetworkId, assertSameNetwork, describeDialers, describeNetwork, isAllowedDialer, isHostId, isNetworkId, logicalName, networkKindOf, normalizeDialers, parseLogicalName, sameNetwork } from './network.js'
export type { NetworkKind } from './network.js'
export { DIRECTORY_PATH, DIRECTORY_PAYLOAD_TAG, DIRECTORY_VERSION, DEFAULT_OVERLAY_SEED, buildDirectoryDocument, directoryPayload, directoryUrlFor, overlayEnvSeeds, overlayEnvTrustedKeys, parseDirectory, publicKeyFrom, publicRelayEntries, readCachedDirectory, resolveOverlayRelay, listOverlayRelayCandidates, signDirectory, toRelayUrl, verifyDirectory, writeCachedDirectory } from './directory.js'
export type { CachedDirectory, DirectoryVerdict, OverlayAddressSource, OverlayDirectory, OverlayRelayCandidates, OverlayRelayResolution, ResolveOverlayRelayOptions } from './directory.js'
export { keyEntryOf, loadKeysFile, parseKeysInline, normalizeKeyRecord, lookupKey, describeKeyEntry, assertKey } from './keys.js'
export type { RelayKeyEntry, RelayKeyMap } from './keys.js'
export {
  IDENTITY_VERSION,
  NODE_GRANT_TAG,
  REVOCATION_TAG,
  SIGNER_SET_TAG,
  PROOF_TAG,
  DEFAULT_NODE_KEY_FILE,
  generateAuthorityKey,
  generateNodeKey,
  identityEnvRequire,
  identityEnvTrustedRoots,
  identityEnvTrustedSigners,
  loadNodeGrant,
  loadOrCreateNodeKey,
  loadRevocations,
  loadTrustedSigners,
  nodeGrantPayload,
  nodeKeyFingerprint,
  normalizePublicKey,
  parseNodeGrant,
  parseRevocationList,
  parseSignerSet,
  proofPayload,
  publicKeyOfPrivate,
  readSignedFile,
  revocationPayload,
  signNodeGrant,
  signProof,
  signRevocations,
  signSignerSet,
  signerSetPayload,
  verifyNodeGrant,
  verifyPeerGrant,
  verifyProof,
  verifyRevocations,
  verifySignerSet,
  writeSignedFile,
} from './identity.js'
export type {
  IdentityReason,
  IdentityVerdict,
  NodeGrant,
  PeerVerifyContext,
  RevocationList,
  SignerSet,
} from './identity.js'
export { chooseNode, describeDecision, rankCandidates, scoreCandidate } from './placement.js'
export type { ChooseOptions, NodeCandidate, PlacementDecision, PlacementScore, PlacementWeights } from './placement.js'
export { relayEndpointTarget, hostNameIndex } from './endpoint-target.js'
export type { RelayEndpointDecision, RelayEndpointTargetInput } from './endpoint-target.js'

// ── 序㉔ 内容分发（块级内容寻址 · 同网段 peer 优先）────────────────────────────
// ⛔ 本段**只做导出**（设计说明 §3.1：`index.ts` 改动仅限导出）。
// 模块职责：`chunker`（切分＋哈希）→ `store`（内容寻址存储）→ `source`（源优先级链）
//           → `peer`（同网段 peer 与分组隔离）。
export {
  DEFAULT_BLOCK_SIZE,
  BLOCK_ID_HEX_LEN,
  blockIdOf,
  contentIdOf,
  isBlockId,
  chunkify,
  planOf,
  reassemble,
} from './content/chunker.js'
export type { Chunk, ChunkedContent, ChunkTransforms } from './content/chunker.js'
export { ContentStore, DEFAULT_MAX_BYTES } from './content/store.js'
export type { ContentStoreCounters, ContentStoreOptions } from './content/store.js'
export { ContentSourceChain, SOURCE_TIERS, DEFAULT_TIER_ORDER, emptySourceCounters } from './content/source.js'
export type {
  SourceTier,
  SourceHitCounters,
  SourceFetchOutcome,
  TierFetchResult,
  TierFetcher,
  ContentSourceChainOptions,
} from './content/source.js'
export { ContentPeerGroup, groupKeyOf, sameGroup, PEER_COUNTER_KEYS } from './content/peer.js'
export type {
  PeerDeclaration,
  PeerCounters,
  PeerCounterKey,
  ContentPeerGroupOptions,
} from './content/peer.js'
export { ContentRuntime } from './content/runtime.js'
export type { ContentRuntimeOptions, ContentSnapshot } from './content/runtime.js'
// 🆕 序㉘ · 单 B：组密钥加密（缺省不启用）—— 走**既有**验签链，⛔ 不新根、不新签名链。
export {
  ContentCipher,
  openContentCipher,
  loadGroupKeyFile,
  describeGroupKey,
  keyIdOf,
  verifyGroupKeyCredential,
  parseGroupKeyCredential,
  groupKeyCredentialPayload,
  CONTENT_CRYPTO_COUNTER_KEYS,
  DEFAULT_GROUP_KEY_FILE,
  DEFAULT_EPOCH_GRACE_MS,
  CONTENT_CIPHER_VERSION,
  GROUP_KEY_TAG,
  IV_LEN,
  TAG_LEN,
  KEY_LEN,
  MIN_BLOB_LEN,
  // 🆕 序㊻ · C（域分离）：块 id 的 per-network 域密钥（⛔ 不新增密钥文件 / 不新增 env）。
  BLOCK_ID_DOMAIN_TAG,
  deriveBlockIdKey,
} from './content/crypto.js'
export type {
  ContentCryptoCounters,
  ContentCryptoCounterKey,
  ContentCipherOptions,
  GroupKeyFile,
  GroupKeyEpochEntry,
  GroupKeyCredential,
  GroupKeyLoadReason,
  GroupKeyLoadResult,
  LoadGroupKeyOptions,
} from './content/crypto.js'

// ── 序㊱ · 「节点一键加入与分组准入」P1（S1–S4）：网注册表 / 准入凭据 / 白名单派生 / join 编排 ──
export {
  NETWORK_INVITE_TAG,
  NODES_REGISTRY_VERSION,
  networkInvitePayload,
  parseNetworkInvite,
  newInviteNonce,
  verifyNetworkInvite,
  noncePath,
  consumeNonce,
  isNonceConsumed,
  emptyRegistry,
  parseRegistry,
  loadRegistry,
  saveRegistry,
  summarizeNetworks,
  listNodes,
  applyApplication,
  approveNode,
  removeNode,
  deriveDialers,
  auditDerivation,
  deriveDropIn,
  dropInPath,
  describeRegistryLine,
} from './registry.js'
export type {
  NetworkInvite,
  InviteReason,
  InviteVerdict,
  NonceLedger,
  NodeStatus,
  NetworkNodeRecord,
  NodesRegistry,
  NetworkSummary,
  DerivationAudit,
  RegistryEdit,
} from './registry.js'
export {
  JOIN_STEPS,
  joinReasonOfInvite,
  defaultHostId,
  runJoin,
  nodeJoinIo,
  readSignedJson,
  describeJoin,
  canWrite,
  maybeRead,
} from './join.js'
export type { JoinStep, JoinReason, StepReport, JoinOutcome, JoinIo, JoinOptions } from './join.js'
export { buildApplication, parseApplication, readApplicationFile } from './join.js'
export type { NodeApplication } from './join.js'

// ── 序㊵ · P2/S5：直连候选交换 ＋ 打洞探测（开关 / 默认值 / 提示 / 观测面）──
export {
  DIRECT_MESSAGE_KIND,
  DIRECT_CAND_MAX_ADDRS,
  DIRECT_CAND_TTL_MS,
  findSecretField,
  isIpv4,
  isIpv6,
  isValidAddress,
  parseDirectMessage,
  normalizeDirectMessage,
  encodeDirectMessage,
  admitCandidate,
  CandidateLedger,
} from './direct/candidate.js'
export type { DirectAddress, DirectCandidateMessage, CandidateReason, CandidateVerdict, CandidateContext, CandidateLedgerSnapshot } from './direct/candidate.js'
export {
  PUNCH_PORT_BASE,
  PUNCH_PORT_SPAN,
  PUNCH_PROBE_INTERVAL_MS,
  DEFAULT_PUNCH_DEADLINE_MS,
  DEFAULT_DIRECT_COOLDOWN_MS,
  DirectCooldown,
  PunchSocket,
  runPunchAttempt,
  pickPunchPort,
  SimulatedNat,
  runPunchPair,
} from './direct/punch.js'
export type { PunchReason, PunchAttempt, PunchOptions, PunchPairResult, SimNatCounters, SimulatedNatOptions } from './direct/punch.js'
export {
  DIRECT_ENV_KEY,
  DEFAULT_DIRECT_ENABLED,
  DIRECT_ON_VALUES,
  DIRECT_OFF_VALUES,
  NODE_CONFIG_FILE_DEFAULT,
  resolveDirectSwitch,
  DIRECT_HINT_PARTS,
  directHintLines,
  directHintText,
  DirectPath,
  directFromNodeConfig,
  readNodeConfig,
  writeNodeConfigDirect,
} from './direct/index.js'
export type { DirectSwitchState, DirectRefusal, NodeConfigWriteOutcome } from './direct/index.js'
