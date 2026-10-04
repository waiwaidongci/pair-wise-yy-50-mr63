import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { digestForPages, digestPositions, type DigestPosition } from '../lib/basis'
import { paperLock, type PaperLockState } from '../lib/paperLock'

// ───────────────────────────── 领域模型 ─────────────────────────────

export type Page = { pageNo: number; name: string; width: number; height: number; bleed: number; content: string }
export type PositionStatus = 'confirmed' | 'pending' | 'invalidated'
export type Position = {
  id: string
  pageNo: number
  spreadId: string
  x: number
  y: number
  rotation: number
  front: boolean
  status: PositionStatus
  basisBatchId: string
}
export type SpreadStatus = 'confirmed' | 'pending' | 'invalidated'
export type SpreadGroup = { id: string; label: string; pageNos: number[]; note: string }
export type Validation = { id: string; severity: '错误' | '警告'; pageNo?: number; title: string; detail: string }
export type Proof = {
  id: string
  round: number
  date: string
  sample: string
  deltaE: number
  feedback: string
  correction: string
  owner: string
  decision: '待决定' | '通过' | '退回'
  paperBatchId: string
  paperSnapshot: string
  positionDigest?: string
}
export type ShardStatus = '待写入' | '已确认' | '写入失败'
export type ExportShard = {
  no: number
  name: string
  pageNos: number[]
  status: ShardStatus
  attempts: number
  lastError?: string
  confirmedBatchId?: string
  digest?: string
}
export type TaskStatus = '排队中' | '生成中' | '已完成' | '已中断' | '待复核'
export type ExportTask = {
  id: string
  name: string
  progress: number
  status: TaskStatus
  updatedAt: string
  resumable: boolean
  paperBatchId?: string
  positionDigest?: string
  shards?: ExportShard[]
  reviewReason?: string
}
export type PaperBatch = {
  id: string
  code: string
  supplier: string
  width: number
  height: number
  gsm: number
  registeredAt: string
  registeredBy: string
}
export type PaperChangeEntry = { at: string; operator: string; fromBatchId: string; toBatchId: string; invalidatedSpreads: string[] }

// 版式常量（与 Canvas 像素坐标同构，1 像素 = 1mm 名义尺寸）
export const PAGE_W = 300
export const PAGE_H = 410
const SAFE_MARGIN = 30
export const layoutSpec = {
  bleed: 3,
  safe: 5,
  gutter: 6,
  binding: '骑马订',
  grain: '纵向',
}

// ───────────────────────────── 种子数据 ─────────────────────────────

const seedPages: Page[] = [
  { pageNo: 1, name: '封面', width: 210, height: 297, bleed: 3, content: '潮汐来信 / 节目册' },
  { pageNo: 2, name: '版权页', width: 210, height: 297, bleed: 2, content: '版权与演职人员' },
  { pageNo: 3, name: '序言', width: 210, height: 297, bleed: 3, content: '导演手记' },
  { pageNo: 4, name: '剧照跨页左', width: 210, height: 297, bleed: 3, content: '第一幕剧照' },
  { pageNo: 5, name: '剧照跨页右', width: 210, height: 297, bleed: 3, content: '第一幕剧照延伸' },
  { pageNo: 6, name: '曲目表', width: 210, height: 297, bleed: 3, content: '曲目与时长' },
  { pageNo: 7, name: '创作团队', width: 210, height: 297, bleed: 1, content: '主创与制作团队' },
  { pageNo: 8, name: '封底', width: 210, height: 297, bleed: 3, content: '巡演信息' },
]

export const seedSpreads: SpreadGroup[] = [
  { id: 'SP-1', label: '套版组 A · 封面 / 封底', pageNos: [8, 1], note: '正面第一帖' },
  { id: 'SP-2', label: '套版组 B · 版权 / 创作团队', pageNos: [2, 7], note: '反面第一帖（P7 出血不足）' },
  { id: 'SP-3', label: '套版组 C · 曲目 / 序言', pageNos: [6, 3], note: '正面第二帖' },
  { id: 'SP-4', label: '跨页组 D · 剧照跨页 P4-P5', pageNos: [4, 5], note: '反面第二帖 · 跨页出血敏感' },
]

const spreadOfPage = new Map(seedSpreads.flatMap((spread) => spread.pageNos.map((pageNo) => [pageNo, spread.id] as const)))

const INITIAL_BATCH_ID = 'PB-20260910-01'

function seedPositions(batchId: string): Position[] {
  const raw: Array<[id: string, pageNo: number, x: number, y: number, rotation: number, front: boolean]> = [
    ['P-01', 8, 34, 44, 0, true],
    ['P-02', 1, 372, 44, 180, true],
    ['P-03', 6, 34, 548, 180, true],
    ['P-04', 3, 372, 548, 0, true],
    ['P-05', 2, 34, 44, 0, false],
    ['P-06', 7, 372, 44, 180, false],
    ['P-07', 4, 34, 548, 0, false],
    ['P-08', 5, 372, 548, 180, false],
  ]
  // P7（P-06）自身出血不足，初始即为待处理；其余已在旧批次下确认
  return raw.map(([id, pageNo, x, y, rotation, front]) => ({
    id,
    pageNo,
    spreadId: spreadOfPage.get(pageNo) ?? 'SP-?',
    x,
    y,
    rotation,
    front,
    status: pageNo === 7 ? 'pending' : 'confirmed',
    basisBatchId: batchId,
  }))
}

function buildSeedProofs(digestValue: string): Proof[] {
  const snapshot = '720×1020mm · 128g'
  return [
    { id: 'PRF-01', round: 1, date: '2026-09-18', sample: '数字样张 v1', deltaE: 3.8, feedback: '封面夜空蓝偏紫，剧照暗部层次压缩。', correction: '调整 CMYK 曲线，黑色通道减少 4%。', owner: '周默 / 色彩管理', decision: '退回', paperBatchId: INITIAL_BATCH_ID, paperSnapshot: snapshot, positionDigest: digestValue },
    { id: 'PRF-02', round: 2, date: '2026-09-25', sample: '数字样张 v2', deltaE: 1.9, feedback: '整体色差改善，P7 出血仍不足。', correction: '重排 P7 版位并增加 2mm 出血。', owner: '林青 / 拼版', decision: '待决定', paperBatchId: INITIAL_BATCH_ID, paperSnapshot: snapshot, positionDigest: digestValue },
  ]
}

function seedBatches(): PaperBatch[] {
  return [
    { id: INITIAL_BATCH_ID, code: 'CH-0910-A', supplier: '晨鸣铜版（夜班余料）', width: 720, height: 1020, gsm: 128, registeredAt: '2026-09-10 20:30', registeredBy: '仓管 · 赵启明' },
    { id: 'PB-20261004-01', code: 'CH-1004-B', supplier: '晨鸣铜版（夜班新卷）', width: 710, height: 950, gsm: 157, registeredAt: '2026-10-04 02:10', registeredBy: '仓管 · 赵启明' },
  ]
}

// ───────────────────────────── 导出种子（api 与 store 共用） ─────────────────────────────

export function shardPageNos(front: boolean, index: 0 | 1) {
  const frontSets = [
    [8, 1],
    [6, 3],
  ]
  const backSets = [
    [2, 7],
    [4, 5],
  ]
  return (front ? frontSets : backSets)[index]
}

export function seedExportTasks(digestValue?: string): ExportTask[] {
  const defs: Array<{ no: number; name: string; front: boolean; index: 0 | 1 }> = [
    { no: 1, name: '分片 1 · 封面/封底（正）', front: true, index: 0 },
    { no: 2, name: '分片 2 · 版权/创作（反）', front: false, index: 0 },
    { no: 3, name: '分片 3 · 曲目/序言（正）', front: true, index: 1 },
    { no: 4, name: '分片 4 · 剧照跨页（反）', front: false, index: 1 },
  ]
  const initialPositions = seedPositions(INITIAL_BATCH_ID)
  const initialDigest = digestPositions(initialPositions)
  const shards: ExportShard[] = defs.map((def) => {
    const pageNos = shardPageNos(def.front, def.index)
    return { no: def.no, name: def.name, pageNos, status: '待写入', attempts: 0 }
  })
  // 现代化任务：分片 1/2 已确认，分片 3 写盘失败待恢复（第一次继续仍失败，第二次成功）
  shards[0].status = '已确认'
  shards[0].confirmedBatchId = INITIAL_BATCH_ID
  shards[0].digest = digestForPages(initialPositions, shards[0].pageNos)
  shards[1].status = '已确认'
  shards[1].confirmedBatchId = INITIAL_BATCH_ID
  shards[1].digest = digestForPages(initialPositions, shards[1].pageNos)
  shards[2].status = '写入失败'
  shards[2].attempts = 3
  shards[2].lastError = '临时目录写入中断（磁盘 I/O 超时）'

  return [
    {
      id: 'EXP-0925-01',
      name: '印刷交付包 · PDF/X-4',
      progress: 50,
      status: '已中断',
      updatedAt: '09-25 16:42',
      resumable: true,
      paperBatchId: INITIAL_BATCH_ID,
      positionDigest: digestValue ?? initialDigest,
      shards,
    },
    // 旧任务缺纸批号与版位摘要 → 一律先归待复核，暂不续传
    { id: 'EXP-0925-02', name: '数字样张低分辨率预览', progress: 100, status: '待复核', updatedAt: '09-25 15:18', resumable: false, reviewReason: '旧任务缺少纸批号与版位摘要，无法确认交付包纸张批次' },
    { id: 'EXP-0924-03', name: '巡展物料单页包', progress: 40, status: '待复核', updatedAt: '09-24 21:05', resumable: false, reviewReason: '旧任务缺少纸批号与版位摘要，暂停续传以免混入新纸批次' },
  ]
}

// ───────────────────────────── Store ─────────────────────────────

type PersistShape = {
  version: 2
  pages: Page[]
  positions: Position[]
  proofs: Proof[]
  tasks: ExportTask[]
  batches: PaperBatch[]
  activeBatchId: string
  revision: string
  locked: boolean
  operator: string
  changeLog: PaperChangeEntry[]
}

function nowText() {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export const useImpositionStore = defineStore('imposition', () => {
  const saved = localStorage.getItem('print-imposition-v2') ?? localStorage.getItem('print-imposition-v1')
  const restored: Partial<PersistShape> | null = saved ? JSON.parse(saved) : null

  const pages = ref<Page[]>(restored?.pages ?? structuredClone(seedPages))
  const spreads = ref<SpreadGroup[]>(structuredClone(seedSpreads))
  const batches = ref<PaperBatch[]>((restored?.batches ?? seedBatches()).map((b) => ({ ...b })))
  const activeBatchId = ref<string>(restored?.activeBatchId ?? INITIAL_BATCH_ID)
  const operator = ref<string>(restored?.operator ?? '林青 / 拼版')

  // v1 存档迁移：旧版位没有状态/纸批号，先标待复核（pending）而不是冒充已确认
  const positions = ref<Position[]>(
    (restored?.positions ?? seedPositions(INITIAL_BATCH_ID)).map((p) => ({
      ...p,
      spreadId: p.spreadId ?? spreadOfPage.get(p.pageNo) ?? 'SP-?',
      status: p.status ?? 'pending',
      basisBatchId: p.basisBatchId ?? '',
    })),
  )

  const currentDigest = computed(() => digestPositions(positions.value))

  const proofs = ref<Proof[]>(
    (restored?.proofs ?? buildSeedProofs(currentDigest.value)).map((proof) => ({
      ...proof,
      positionDigest: proof.positionDigest ?? '',
    })),
  )
  const tasks = ref<ExportTask[]>(restored?.tasks ?? seedExportTasks(currentDigest.value))
  const changeLog = ref<PaperChangeEntry[]>(restored?.changeLog ?? [])

  const side = ref<'front' | 'back'>('front')
  const zoom = ref(72)
  const revision = ref(restored?.revision ?? 'R6')
  const locked = ref(restored?.locked ?? false)
  const selectedPosition = ref<string | null>(null)
  const selectedProof = ref('PRF-02')

  // ── 换纸占用锁（跨标签页） ──
  const heldToken = ref<string | null>(null)
  const paperLockState = ref<PaperLockState | null>(paperLock.read())
  paperLock.subscribe((lock) => (paperLockState.value = lock))
  let heartbeat: number | undefined
  watch(heldToken, (token) => {
    window.clearInterval(heartbeat)
    if (token) heartbeat = window.setInterval(() => paperLock.renew(token), paperLock.HEARTBEAT_MS)
  })

  const activeBatch = computed(() => batches.value.find((b) => b.id === activeBatchId.value) ?? batches.value[0])
  const lockHeldByMe = computed(() => paperLockState.value?.owner === operator.value)
  const lockHeldByOther = computed(() => (paperLockState.value ? !lockHeldByMe.value : false))

  // ── 几何校验：版位是否落在当前纸安全区内（含出血间隙） ──
  const paperSafe = computed(() => ({
    minX: SAFE_MARGIN,
    minY: SAFE_MARGIN,
    maxX: activeBatch.value.width - SAFE_MARGIN - PAGE_W,
    maxY: activeBatch.value.height - SAFE_MARGIN - PAGE_H,
  }))

  function pageFits(p: Position, batchId = activeBatchId.value) {
    const batch = batches.value.find((b) => b.id === batchId)
    if (!batch) return false
    return (
      p.x >= SAFE_MARGIN &&
      p.y >= SAFE_MARGIN &&
      p.x + PAGE_W <= batch.width - SAFE_MARGIN &&
      p.y + PAGE_H <= batch.height - SAFE_MARGIN
    )
  }
  function pageMeetsBleed(pageNo: number) {
    const page = pages.value.find((item) => item.pageNo === pageNo)
    return Boolean(page && page.bleed >= layoutSpec.bleed)
  }

  const clampX = (x: number) => Math.max(paperSafe.value.minX, Math.min(paperSafe.value.maxX, Math.round(x)))
  const clampY = (y: number) => Math.max(paperSafe.value.minY, Math.min(paperSafe.value.maxY, Math.round(y)))

  // ── 跨页组状态 ──
  // 已失效：换纸后带旧依据且几何越界（或被显式标记 invalidated）；
  // 待确认：几何在安全区内但出血/组内成员尚未确认（如 P7 出血不足）
  function spreadStatus(spread: SpreadGroup): SpreadStatus {
    const members = positions.value.filter((p) => spread.pageNos.includes(p.pageNo))
    if (members.some((p) => p.status === 'invalidated' || !pageFits(p))) return 'invalidated'
    if (members.some((p) => p.status !== 'confirmed' || !pageMeetsBleed(p.pageNo))) return 'pending'
    return 'confirmed'
  }
  const spreadStates = computed(() =>
    spreads.value.map((spread) => ({ spread, status: spreadStatus(spread) })),
  )
  const affectedSpreads = computed(() => spreadStates.value.filter((item) => item.status !== 'confirmed').map((item) => item.spread))

  // ── 预检验证 ──
  const validations = computed<Validation[]>(() => {
    const issues: Validation[] = []
    const placedPages = positions.value.map((position) => position.pageNo)
    pages.value.forEach((page) => {
      if (!placedPages.includes(page.pageNo)) issues.push({ id: `missing-${page.pageNo}`, severity: '错误', pageNo: page.pageNo, title: `P${page.pageNo} 尚未拼版`, detail: `${page.name} 未出现在正反版位中。` })
      if (page.bleed < layoutSpec.bleed) issues.push({ id: `bleed-${page.pageNo}`, severity: '错误', pageNo: page.pageNo, title: `P${page.pageNo} 出血不足`, detail: `页面出血 ${page.bleed}mm，低于印刷要求 ${layoutSpec.bleed}mm。` })
    })
    positions.value.forEach((position) => {
      if (!pageFits(position)) {
        issues.push({ id: `safe-${position.id}`, severity: '错误', pageNo: position.pageNo, title: `${position.id} 超出 ${activeBatch.value.code} 安全区`, detail: `版位落在 ${activeBatch.value.width}×${activeBatch.value.height}mm 纸边安全区外，需要重算。` })
      }
      if (position.status === 'invalidated') {
        issues.push({ id: `stale-${position.id}`, severity: '错误', pageNo: position.pageNo, title: `${position.id} 依据旧纸批次`, detail: `原依据 ${batchCode(position.basisBatchId)}，换纸后该跨页组已失效，重算后需重新确认。` })
      }
    })
    for (let index = 0; index < positions.value.length; index += 1) {
      for (let next = index + 1; next < positions.value.length; next += 1) {
        const a = positions.value[index]
        const b = positions.value[next]
        if (a.front === b.front && Math.abs(a.x - b.x) < 320 && Math.abs(a.y - b.y) < 430) {
          issues.push({ id: `overlap-${a.id}-${b.id}`, severity: '错误', pageNo: a.pageNo, title: `${a.id} 与 ${b.id} 版位重叠`, detail: '当前纸张尺寸下页面之间不足安全间隙。' })
        }
      }
    }
    const frontOrder = positions.value.filter((item) => item.front).sort((a, b) => a.x - b.x || a.y - b.y).map((item) => item.pageNo)
    if (frontOrder[0] !== 1) issues.push({ id: 'binding-order', severity: '警告', pageNo: 1, title: '骑马订正版页序需要复核', detail: `当前首位为 P${frontOrder[0]}，装订方向规则期望封面位于首版位。` })
    return issues
  })

  function batchCode(id: string) {
    return batches.value.find((b) => b.id === id)?.code ?? '未知批次'
  }

  // 打样依据状态：换纸后旧批次打样仅作历史参考
  function proofBasisState(proof: Proof): '缺依据' | '旧依据' | '当前' {
    if (!proof.paperBatchId || !proof.positionDigest) return '缺依据'
    return proof.paperBatchId === activeBatchId.value && proof.positionDigest === currentDigest.value ? '当前' : '旧依据'
  }

  // ── 持久化 ──
  watch(
    [pages, positions, proofs, tasks, batches, activeBatchId, revision, locked, spreads, operator, changeLog],
    () => {
      const shape: PersistShape = {
        version: 2,
        pages: pages.value,
        positions: positions.value,
        proofs: proofs.value,
        tasks: tasks.value,
        batches: batches.value,
        activeBatchId: activeBatchId.value,
        revision: revision.value,
        locked: locked.value,
        operator: operator.value,
        changeLog: changeLog.value,
      }
      localStorage.setItem('print-imposition-v2', JSON.stringify(shape))
    },
    { deep: true },
  )

  // ── 版位操作 ──
  function updatePosition(id: string, patch: Partial<Position>) {
    if (locked.value || lockHeldByOther.value) return
    const position = positions.value.find((item) => item.id === id)
    if (!position) return
    Object.assign(position, patch)
    // 几何被改动后回到待确认，依据记为当前纸批次
    if ('x' in patch || 'y' in patch || 'rotation' in patch || 'pageNo' in patch) {
      position.status = 'pending'
      position.basisBatchId = activeBatchId.value
    }
  }

  function confirmSpread(spreadId: string) {
    if (lockHeldByOther.value) return
    const spread = spreads.value.find((item) => item.id === spreadId)
    if (!spread || spreadStatus(spread) !== 'pending') return
    // 安全区 + 出血全部达标后才可确认
    const members = positions.value.filter((p) => spread.pageNos.includes(p.pageNo))
    if (!members.every((p) => pageFits(p) && pageMeetsBleed(p.pageNo))) return
    members.forEach((p) => {
      p.status = 'confirmed'
      p.basisBatchId = activeBatchId.value
    })
  }

  // 失效跨页组重算：把版位拉回新纸安全区（出血不足/页面本身的问题仍由预检暴露）
  function recalcSpread(spreadId: string) {
    if (lockHeldByOther.value) return
    const spread = spreads.value.find((item) => item.id === spreadId)
    if (!spread || spreadStatus(spread) !== 'invalidated') return
    positions.value
      .filter((p) => spread.pageNos.includes(p.pageNo))
      .forEach((p) => {
        p.x = clampX(p.x)
        p.y = clampY(p.y)
        p.status = 'pending'
        p.basisBatchId = activeBatchId.value
      })
  }

  function addPosition(pageNo: number) {
    if (locked.value || lockHeldByOther.value) return
    if (positions.value.some((item) => item.pageNo === pageNo && item.front === (side.value === 'front'))) return
    positions.value.push({
      id: `P-${Date.now().toString().slice(-3)}`,
      pageNo,
      spreadId: spreadOfPage.get(pageNo) ?? 'SP-NEW',
      x: paperSafe.value.minX + 4,
      y: paperSafe.value.minY + 4,
      rotation: 0,
      front: side.value === 'front',
      status: 'pending',
      basisBatchId: activeBatchId.value,
    })
  }

  // ── 打样 ──
  function updateProof(id: string, patch: Partial<Proof>) {
    const proof = proofs.value.find((item) => item.id === id)
    if (proof) Object.assign(proof, patch)
  }

  function createProof() {
    proofs.value.push({
      id: `PRF-${String(proofs.value.length + 1).padStart(2, '0')}`,
      round: proofs.value.length + 1,
      date: new Date().toISOString().slice(0, 10),
      sample: `数字样张 v${proofs.value.length + 1}`,
      deltaE: 0,
      feedback: '',
      correction: '',
      owner: operator.value,
      decision: '待决定',
      paperBatchId: activeBatchId.value,
      paperSnapshot: `${activeBatch.value.width}×${activeBatch.value.height}mm · ${activeBatch.value.gsm}g`,
      positionDigest: currentDigest.value,
    })
  }

  function lockBaseline() {
    locked.value = true
    revision.value = `R${Number(revision.value.slice(1)) + 1}`
  }
  function unlock() {
    locked.value = false
  }

  // ── 纸张批次登记：登记后冻结宽/高/克重（只追加，不就地改） ──
  function registerPaperBatch(input: { code: string; supplier: string; width: number; height: number; gsm: number }) {
    const id = `PB-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${String(batches.value.length + 1).padStart(2, '0')}`
    const batch: PaperBatch = {
      id,
      code: input.code,
      supplier: input.supplier,
      width: input.width,
      height: input.height,
      gsm: input.gsm,
      registeredAt: nowText(),
      registeredBy: operator.value,
    }
    batches.value.push(batch)
    return batch
  }

  // ── 换纸影响预览：不写状态，只给出会失效的跨页组 / 分片 / 打样 ──
  function previewPaperChange(candidateBatchId: string) {
    const candidate = batches.value.find((b) => b.id === candidateBatchId)
    const fitsMap = new Map(positions.value.map((p) => [p.id, pageFits(p, candidateBatchId)]))
    const impactedSpreads = spreads.value.filter((spread) =>
      positions.value.some((p) => spread.pageNos.includes(p.pageNo) && fitsMap.get(p.id) === false),
    )
    const impactedPageNos = new Set(positions.value.filter((p) => fitsMap.get(p.id) === false).map((p) => p.pageNo))
    const impactedShards: Array<{ task: ExportTask; shard: ExportShard }> = []
    tasks.value.forEach((task) => {
      if (task.status === '待复核' || !task.shards) return
      task.shards.forEach((shard) => {
        if (shard.pageNos.some((pageNo) => impactedPageNos.has(pageNo))) impactedShards.push({ task, shard })
      })
    })
    const impactedProofs = proofs.value.filter((proof) => proof.paperBatchId === activeBatchId.value)
    return { candidate, impactedSpreads, impactedShards, impactedProofs }
  }

  // ── 换纸确认（先到者已通过 paperLock 占用） ──
  // 返回 false 表示占用已过期/被他人取得，调用方应提示并中止
  function confirmPaperChange(candidateBatchId: string): boolean {
    const currentLock = paperLock.read()
    if (!heldToken.value || !currentLock || currentLock.token !== heldToken.value || currentLock.owner !== operator.value) {
      heldToken.value = null
      paperLockState.value = currentLock
      return false
    }
    if (candidateBatchId === activeBatchId.value) return false
    const preview = previewPaperChange(candidateBatchId)
    const invalidIds = new Set(preview.impactedSpreads.map((s) => s.id))
    positions.value.forEach((p) => {
      const spread = spreads.value.find((s) => s.pageNos.includes(p.pageNo))
      if (spread && invalidIds.has(spread.id)) {
        p.status = 'invalidated'
        // 保留 p.basisBatchId 不动：失效版位必须带着旧依据，便于审计"因何失效"
      }
    })
    // 纸批次一变，受影响跨页组之外的版位原样保留（仍是 confirmed + 旧 basis，几何合格即继续可用）
    const fromBatchId = activeBatchId.value
    activeBatchId.value = candidateBatchId
    revision.value = `R${Number(revision.value.slice(1)) + 1}`
    locked.value = false
    // 运行中的导出任务依据变为旧批次 → 中断到分片级，等待按新依据续传
    tasks.value.forEach((task) => {
      if (task.status === '待复核') return
      if (task.paperBatchId && task.paperBatchId !== candidateBatchId && task.status !== '已完成') {
        task.status = '已中断'
        task.resumable = true
        task.updatedAt = nowText()
        task.shards?.forEach((shard) => {
          if (shard.status === '待写入') {
            shard.status = '写入失败'
            shard.lastError = '换纸中断：依据批次变更，等待按新纸批次续传'
          }
        })
      }
    })
    changeLog.value.unshift({
      at: nowText(),
      operator: operator.value,
      fromBatchId,
      toBatchId: candidateBatchId,
      invalidatedSpreads: preview.impactedSpreads.map((s) => s.id),
    })
    return true
  }

  // ── 占用锁动作 ──
  function acquirePaperLock(candidateBatchId: string): { ok: boolean; lock: PaperLockState | null } {
    const current = paperLock.read()
    const result = paperLock.acquire(operator.value, candidateBatchId)
    if (result.ok && result.lock?.owner === operator.value) {
      heldToken.value = result.lock.token
    } else if (current?.owner !== operator.value) {
      // 被他人占用：本会话不再持有任何有效 token
      heldToken.value = null
    }
    paperLockState.value = paperLock.read()
    return result
  }
  function releasePaperLock() {
    if (heldToken.value) paperLock.release(heldToken.value)
    heldToken.value = null
    paperLockState.value = paperLock.read()
  }

  // ── 导出任务（服务端为事实源，本地引用原地合并以保持响应式） ──
  function syncTasks(remote: ExportTask[]) {
    remote.forEach((incoming) => {
      const local = tasks.value.find((task) => task.id === incoming.id)
      if (local) Object.assign(local, incoming)
      else tasks.value.push({ ...incoming })
    })
    const remoteIds = new Set(remote.map((task) => task.id))
    tasks.value = tasks.value.filter((task) => remoteIds.has(task.id))
  }
  function findTask(id: string) {
    return tasks.value.find((task) => task.id === id)
  }
  function createExportTask(): ExportTask {
    const defs: Array<{ no: number; name: string; front: boolean; index: 0 | 1 }> = [
      { no: 1, name: '分片 1 · 封面/封底（正）', front: true, index: 0 },
      { no: 2, name: '分片 2 · 版权/创作（反）', front: false, index: 0 },
      { no: 3, name: '分片 3 · 曲目/序言（正）', front: true, index: 1 },
      { no: 4, name: '分片 4 · 剧照跨页（反）', front: false, index: 1 },
    ]
    const shards: ExportShard[] = defs.map((def) => {
      const pageNos = shardPageNos(def.front, def.index)
      return {
        no: def.no,
        name: def.name,
        pageNos,
        status: '待写入',
        attempts: 0,
        confirmedBatchId: activeBatchId.value,
        digest: digestForPages(positions.value, pageNos),
      }
    })
    const task: ExportTask = {
      id: `EXP-${Date.now().toString().slice(-6)}`,
      name: '印刷交付包 · PDF/X-4',
      progress: 0,
      status: '排队中',
      updatedAt: '刚刚',
      resumable: true,
      paperBatchId: activeBatchId.value,
      positionDigest: currentDigest.value,
      shards,
    }
    return task
  }

  const invalidatedPositions = computed(() => positions.value.filter((p) => p.status === 'invalidated' || !pageFits(p)))
  const canExport = computed(
    () => positions.value.length > 0
      && !invalidatedPositions.value.length
      && !lockHeldByOther.value
      && activeBatchId.value != null,
  )

  const digestOfPages = (pageNos: number[]) => digestForPages(positions.value, pageNos)

  return {
    // 常量
    PAGE_W,
    PAGE_H,
    layoutSpec,
    // 状态
    pages,
    positions,
    spreads,
    spreadStates,
    affectedSpreads,
    proofs,
    tasks,
    batches,
    activeBatch,
    activeBatchId,
    operator,
    changeLog,
    side,
    zoom,
    revision,
    locked,
    selectedPosition,
    selectedProof,
    validations,
    currentDigest,
    paperSafe,
    paperLockState,
    lockHeldByMe,
    lockHeldByOther,
    canExport,
    // 派生
    pageFits,
    pageMeetsBleed,
    spreadStatus,
    batchCode,
    proofBasisState,
    clampX,
    clampY,
    digestOfPages,
    // 动作
    updatePosition,
    addPosition,
    confirmSpread,
    recalcSpread,
    updateProof,
    createProof,
    lockBaseline,
    unlock,
    registerPaperBatch,
    previewPaperChange,
    confirmPaperChange,
    acquirePaperLock,
    releasePaperLock,
    syncTasks,
    findTask,
    createExportTask,
  }
})
