// 换纸确认占用锁：两人同时确认换纸时，先到者占用，后到者只读。
// 跨标签页通过 BroadcastChannel 实时同步，不支持时退化为 localStorage 轮询；
// 持有者心跳续约、退出自动释放；异常掉电由 TTL 兜底，不会永久死锁。

export type PaperLockState = {
  owner: string
  candidateBatchId: string
  acquiredAt: number
  expiresAt: number
  token: string
}

const KEY = 'paper-change-lock-v1'
const TTL_MS = 30_000
const HEARTBEAT_MS = 8_000
const CHANNEL = 'paper-change-lock'

type Listener = (lock: PaperLockState | null) => void
const listeners = new Set<Listener>()

function readRaw(): PaperLockState | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const lock = JSON.parse(raw) as PaperLockState
    if (typeof lock.expiresAt !== 'number' || lock.expiresAt <= Date.now()) {
      localStorage.removeItem(KEY)
      return null
    }
    return lock
  } catch {
    return null
  }
}

let channel: BroadcastChannel | null = null
try {
  channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(CHANNEL) : null
  if (channel) channel.onmessage = () => listeners.forEach((fn) => fn(readRaw()))
} catch {
  // BroadcastChannel 不可用时依赖 storage 事件 + 轮询兜底
  channel = null
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === KEY) listeners.forEach((fn) => fn(readRaw()))
  })
}

let pollTimer: ReturnType<typeof setInterval> | undefined
function ensurePolling() {
  if (channel || pollTimer || typeof window === 'undefined') return
  pollTimer = setInterval(() => listeners.forEach((fn) => fn(readRaw())), 2_500)
}

function writeRaw(lock: PaperLockState | null) {
  if (lock) localStorage.setItem(KEY, JSON.stringify(lock))
  else localStorage.removeItem(KEY)
  listeners.forEach((fn) => fn(lock))
  channel?.postMessage('changed')
}

function nowLock(owner: string, candidateBatchId: string): PaperLockState {
  const ts = Date.now()
  return {
    owner,
    candidateBatchId,
    acquiredAt: ts,
    expiresAt: ts + TTL_MS,
    token: `${ts}-${Math.random().toString(36).slice(2, 8)}`,
  }
}

export const paperLock = {
  TTL_MS,
  HEARTBEAT_MS,
  read: readRaw,
  subscribe(fn: Listener) {
    listeners.add(fn)
    ensurePolling()
    return () => listeners.delete(fn)
  },
  // 先到者占用；同一操作者可重入；后到者拿到当前占用者信息
  acquire(owner: string, candidateBatchId: string): { ok: boolean; lock: PaperLockState | null } {
    const current = readRaw()
    if (current) {
      if (current.owner === owner && current.candidateBatchId === candidateBatchId) return { ok: true, lock: current }
      return { ok: false, lock: current }
    }
    const lock = nowLock(owner, candidateBatchId)
    writeRaw(lock)
    return { ok: true, lock }
  },
  renew(token: string) {
    const current = readRaw()
    if (!current || current.token !== token) return false
    current.expiresAt = Date.now() + TTL_MS
    writeRaw(current)
    return true
  },
  release(token: string) {
    const current = readRaw()
    if (current && current.token === token) writeRaw(null)
  },
  remainingMs(lock: PaperLockState) {
    return Math.max(0, lock.expiresAt - Date.now())
  },
}
