/**
 * 跨标签页倒罐互斥锁。
 *
 * 场景：两个人各开一个页面同时对同一批次做倒罐。
 * - 先打开倒罐单的页面拿到该批次的排他锁，可以正常提交；
 * - 后到的页面拿不到锁，只能查看罐位，提交入口被禁用并收到明确提示；
 * - 持锁页面提交后，分罐 / 罐位变化通过 liveQuery 自动推送到其它页面。
 *
 * 实现：
 * - 优先 Web Locks API（同源多标签由浏览器原子裁决，只有一个标签能拿到）；
 * - 非安全上下文降级为 localStorage 租约 + storage 事件心跳；
 * - BroadcastChannel 广播编辑开始 / 结束，新打开的页面会主动 ping 询问在编者；
 * - 持久化层另有 rackVersion 乐观版本号与事务内容量复核作为最终防线。
 */
import { computed, onScopeDispose, reactive, ref, type ComputedRef } from 'vue'
import { createId } from './uuid'

const CHANNEL_NAME = 'gbwinetank-racking-lock'
const LS_PREFIX = 'gbwinetank-racking:'
const LEASE_MS = 30_000
const HEARTBEAT_MS = 8_000

type LockMessage =
  | { kind: 'edit-start'; batchId: string; tabId: string; at: number }
  | { kind: 'edit-end'; batchId: string; tabId: string }
  | { kind: 'ping'; batchId: string; tabId: string }

/** 全应用共享的「正在编辑的批次 → 标签 id 集合」 */
const peersEditing = reactive(new Map<string, Set<string>>())

let channel: BroadcastChannel | null = null
const selfTabId = createId('tab')

/** 本浏览器上下文内当前持有的锁（用于应答其它标签的 ping） */
const heldLocks = new Set<string>()

function ensureChannel(): BroadcastChannel | null {
  if (channel) return channel
  if (typeof BroadcastChannel === 'undefined') return null
  channel = new BroadcastChannel(CHANNEL_NAME)
  channel.onmessage = (event: MessageEvent<LockMessage>) => {
    const msg = event.data
    if (!msg || msg.tabId === selfTabId) return
    if (msg.kind === 'edit-start') {
      addPeer(msg.batchId, msg.tabId)
    } else if (msg.kind === 'edit-end') {
      removePeer(msg.batchId, msg.tabId)
    } else if (msg.kind === 'ping' && heldLocks.has(msg.batchId)) {
      post({ kind: 'edit-start', batchId: msg.batchId, tabId: selfTabId, at: Date.now() })
    }
  }
  if (typeof window !== 'undefined') window.addEventListener('storage', onStorage)
  return channel
}

function addPeer(batchId: string, tabId: string): void {
  const set = peersEditing.get(batchId) ?? new Set<string>()
  set.add(tabId)
  peersEditing.set(batchId, set)
}

function removePeer(batchId: string, tabId: string): void {
  const set = peersEditing.get(batchId)
  if (!set) return
  set.delete(tabId)
  if (set.size === 0) peersEditing.delete(batchId)
  else peersEditing.set(batchId, set)
}

function post(msg: LockMessage): void {
  ensureChannel()?.postMessage(msg)
}

/* --------------------------- localStorage 降级 --------------------------- */

function readLease(batchId: string): { tabId: string } | null {
  try {
    const raw = window.localStorage.getItem(LS_PREFIX + batchId)
    if (!raw) return null
    const [tabId, expireText] = raw.split('|')
    if (!tabId || Date.now() > Number(expireText)) return null
    return { tabId }
  } catch {
    return null
  }
}

function writeLease(batchId: string): void {
  try {
    window.localStorage.setItem(LS_PREFIX + batchId, `${selfTabId}|${Date.now() + LEASE_MS}`)
  } catch {
    /* 隐私模式等场景忽略：仍有 DB 版本号兜底 */
  }
}

function clearLease(batchId: string): void {
  try {
    if (readLease(batchId)?.tabId === selfTabId) {
      window.localStorage.removeItem(LS_PREFIX + batchId)
    }
  } catch {
    /* ignore */
  }
}

function onStorage(event: StorageEvent): void {
  if (!event.key || !event.key.startsWith(LS_PREFIX)) return
  const batchId = event.key.slice(LS_PREFIX.length)
  const lease = readLease(batchId)
  if (lease && lease.tabId !== selfTabId) addPeer(batchId, lease.tabId)
  else removePeer(batchId, lease?.tabId ?? '')
}

/* -------------------------------- 锁本体 -------------------------------- */

export interface RackingLock {
  /** 本作用域当前持有的批次锁（响应式） */
  heldBatchIds: ComputedRef<ReadonlySet<string>>
  /** 尝试获取某批次的倒罐排他锁；拿不到（其它页面正在编辑）返回 false */
  acquire: (batchId: string) => Promise<boolean>
  /** 释放锁并广播编辑结束 */
  release: (batchId: string) => Promise<void>
  /** 是否有其它页面正在编辑该批次（响应式） */
  isHeldByOther: (batchId: string) => boolean
}

export function useRackingLock(): RackingLock {
  ensureChannel()
  const held = ref<Set<string>>(new Set())
  /** Web Locks 门闩：调用即释放；降级方案下是空操作 */
  const gates = new Map<string, () => void>()
  const heartbeats = new Map<string, number>()

  function onAcquired(batchId: string, releaseGate: () => void): void {
    gates.set(batchId, releaseGate)
    held.value = new Set(held.value).add(batchId)
    heldLocks.add(batchId)
    writeLease(batchId)
    const timer = window.setInterval(() => writeLease(batchId), HEARTBEAT_MS)
    heartbeats.set(batchId, timer)
    post({ kind: 'edit-start', batchId, tabId: selfTabId, at: Date.now() })
  }

  async function acquireWithWebLocks(batchId: string): Promise<boolean> {
    const locks = navigator.locks
    if (!locks) return acquireWithLease(batchId)
    let granted = false
    const finished = locks.request(
      `gbwinetank-racking-${batchId}`,
      { ifAvailable: true },
      () =>
        new Promise<void>((resolve) => {
          granted = true
          onAcquired(batchId, resolve)
        })
    )
    await finished.catch(() => undefined)
    return granted
  }

  /** 无 Web Locks 时的降级方案：localStorage 租约抢占 */
  async function acquireWithLease(batchId: string): Promise<boolean> {
    const lease = readLease(batchId)
    if (lease && lease.tabId !== selfTabId) return false
    onAcquired(batchId, () => {})
    return true
  }

  async function release(batchId: string): Promise<void> {
    if (!held.value.has(batchId)) return
    const next = new Set(held.value)
    next.delete(batchId)
    held.value = next
    heldLocks.delete(batchId)
    const timer = heartbeats.get(batchId)
    if (timer) {
      window.clearInterval(timer)
      heartbeats.delete(batchId)
    }
    clearLease(batchId)
    gates.get(batchId)?.()
    gates.delete(batchId)
    removePeer(batchId, selfTabId)
    post({ kind: 'edit-end', batchId, tabId: selfTabId })
  }

  function isHeldByOther(batchId: string): boolean {
    for (const tabId of peersEditing.get(batchId) ?? []) {
      if (tabId !== selfTabId) return true
    }
    // 广播延迟时以 localStorage 租约为准再判一次
    const lease = readLease(batchId)
    return !!lease && lease.tabId !== selfTabId
  }

  onScopeDispose(() => {
    for (const batchId of held.value) void release(batchId)
  })

  const heldBatchIds = computed<ReadonlySet<string>>(() => held.value)

  return {
    heldBatchIds,
    acquire: async (batchId: string) => {
      const ok = await acquireWithWebLocks(batchId)
      if (!ok) {
        // 主动询问一次，让已在编辑的页面补广播，保证后到页面立刻看到占用提示
        post({ kind: 'ping', batchId, tabId: selfTabId })
        await new Promise((resolve) => window.setTimeout(resolve, 60))
      }
      return ok
    },
    release,
    isHeldByOther
  }
}
