import { computed, ref, watch } from 'vue'
import { defineStore, getActivePinia } from 'pinia'

export type Page = { pageNo: number; name: string; width: number; height: number; bleed: number; content: string }
export type PositionStatus = '正常' | '待重算'
export type Position = { id: string; pageNo: number; x: number; y: number; rotation: number; front: boolean; groupId?: string; status: PositionStatus }
export type Validation = { id: string; severity: '错误' | '警告'; pageNo?: number; title: string; detail: string }
export type Proof = { id: string; round: number; date: string; sample: string; deltaE: number; feedback: string; correction: string; owner: string; decision: '待决定' | '通过' | '退回'; batchId: string; stale: boolean }
export type FragmentStatus = '已完成' | '待重算' | '写入失败'
export type ExportFragment = { id: string; label: string; pages: number[]; status: FragmentStatus; basisHash: string; attempts: number; confirmedAt?: string; reused?: boolean }
export type TaskStatus = '排队中' | '生成中' | '已完成' | '已中断' | '待复核'
export type ExportTask = { id: string; name: string; progress: number; status: TaskStatus; updatedAt: string; resumable: boolean; batchId?: string; positionSummary?: string; fragments: ExportFragment[]; reviewReason?: string }
export type PaperBatch = { id: string; width: number; height: number; grammage: number; grain: '纵向' | '横向'; registeredAt: string; registeredBy: string; status: '当前' | '历史' }

/** 印刷要求（不因换纸改变）：出血、安全区、叼口等工艺常量 */
export const sheetSpec = {
  bleed: 3,
  safe: 5,
  gutter: 6,
  binding: '骑马订',
} as const

/** 换纸占用锁有效期：先到者占用，超时自动释放 */
export const CHANGE_LOCK_TTL = 30_000

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

const seedPositions: Position[] = [
  { id: 'P-01', pageNo: 8, x: 34, y: 44, rotation: 0, front: true, status: '正常' },
  { id: 'P-02', pageNo: 1, x: 372, y: 44, rotation: 180, front: true, status: '正常' },
  { id: 'P-03', pageNo: 6, x: 34, y: 548, rotation: 180, front: true, status: '正常' },
  { id: 'P-04', pageNo: 3, x: 372, y: 548, rotation: 0, front: true, status: '正常' },
  { id: 'P-05', pageNo: 2, x: 34, y: 44, rotation: 0, front: false, status: '正常' },
  { id: 'P-06', pageNo: 7, x: 372, y: 44, rotation: 180, front: false, status: '正常' },
  { id: 'P-07', pageNo: 4, x: 34, y: 548, rotation: 0, front: false, groupId: 'G-SPREAD-45', status: '正常' },
  { id: 'P-08', pageNo: 5, x: 372, y: 548, rotation: 180, front: false, groupId: 'G-SPREAD-45', status: '正常' },
]

const seedProofs: Proof[] = [
  { id: 'PRF-01', round: 1, date: '2026-09-18', sample: '数字样张 v1', deltaE: 3.8, feedback: '封面夜空蓝偏紫，剧照暗部层次压缩。', correction: '调整 CMYK 曲线，黑色通道减少 4%。', owner: '周默 / 色彩管理', decision: '退回', batchId: 'PAPER-2609-01', stale: false },
  { id: 'PRF-02', round: 2, date: '2026-09-25', sample: '数字样张 v2', deltaE: 1.9, feedback: '整体色差改善，P7 出血仍不足。', correction: '重排 P7 版位并增加 2mm 出血。', owner: '林青 / 拼版', decision: '待决定', batchId: 'PAPER-2609-01', stale: false },
]

const seedPaperBatches: PaperBatch[] = [
  { id: 'PAPER-2609-01', width: 720, height: 1020, grammage: 157, grain: '纵向', registeredAt: '2026-09-20 10:24', registeredBy: '系统初始化', status: '当前' },
  { id: 'PAPER-2608-02', width: 720, height: 1020, grammage: 128, grain: '纵向', registeredAt: '2026-08-15 09:10', registeredBy: '夜班-老周', status: '历史' },
]

/** 旧任务种子：缺纸批号与版位摘要，启动时归待复核、不续传 */
const seedTasks: ExportTask[] = [
  { id: 'EXP-0925-01', name: '印刷交付包 · PDF/X-4', progress: 72, status: '已中断', updatedAt: '09-25 16:42', resumable: true, fragments: [] },
  { id: 'EXP-0925-02', name: '数字样张低分辨率预览', progress: 100, status: '已完成', updatedAt: '09-25 15:18', resumable: false, fragments: [] },
]

/** FNV-1a 32 位哈希，用于版位摘要与分片依据 */
function hashBasis(parts: string): string {
  let h = 0x811c9dc5
  for (let index = 0; index < parts.length; index += 1) {
    h ^= parts.charCodeAt(index)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36).padStart(7, '0')
}

/** 版位摘要：按页号排序的版面几何（坐标、旋转、正反面、页面出血） */
function positionSummaryFor(pages: Page[], positions: Position[], pageNos?: number[]): string {
  return positions
    .filter((position) => (pageNos ? pageNos.includes(position.pageNo) : true))
    .slice()
    .sort((a, b) => a.pageNo - b.pageNo)
    .map((position) => {
      const page = pages.find((item) => item.pageNo === position.pageNo)
      return `p${position.pageNo}:${position.x},${position.y},r${position.rotation},${position.front ? 'F' : 'B'},bl${page?.bleed ?? 0}`
    })
    .join('|')
}

/** 分片依据：纸宽纸高克重 + 该分片的版位摘要；一致时已完成分片可复用 */
function basisFor(batch: PaperBatch, pages: Page[], positions: Position[], pageNos: number[]): string {
  return hashBasis(`${batch.width}x${batch.height}g${batch.grammage}|${positionSummaryFor(pages, positions, pageNos)}`)
}

/** 版位在指定纸张批次下的安全区/出血适配（画布坐标与 mm 同构：752×1072 对应 720×1020mm） */
function fitAgainst(position: Position, page: Page, batch: PaperBatch): { ok: boolean; reasons: string[] } {
  const reasons: string[] = []
  const sheetW = (batch.width * 752) / 720
  const sheetH = (batch.height * 1072) / 1020
  const safe = sheetSpec.safe
  const left = 24 + safe
  const top = 24 + safe
  const right = 24 + sheetW - safe
  const bottom = 24 + sheetH - safe
  const px = position.x
  const py = position.y + 20
  if (px < left || py < top || px + 300 > right || py + 410 > bottom) reasons.push('版位超出新纸张安全区')
  if (page.bleed < sheetSpec.bleed) reasons.push(`页面出血 ${page.bleed}mm 未达 ${sheetSpec.bleed}mm 要求`)
  return { ok: reasons.length === 0, reasons }
}

export type AffectedGroup = { groupId: string; pageNos: number[]; positionIds: string[]; reasons: string[] }
export type AffectedFragment = { taskId: string; taskName: string; fragmentId: string; label: string; reason: string }
export type Impact = {
  affectedGroups: AffectedGroup[]
  keptPositionIds: string[]
  affectedFragments: AffectedFragment[]
  reusedFragments: AffectedFragment[]
  staleProofIds: string[]
}

/** 换纸影响分析：失效跨页组、保留版位、待重算/可复用分片、待复核打样 */
function analyzeImpact(batch: PaperBatch, pages: Page[], positions: Position[], proofs: Proof[], tasks: ExportTask[]): Impact {
  const groupMap = new Map<string, Position[]>()
  positions.forEach((position) => {
    if (!position.groupId) return
    const list = groupMap.get(position.groupId) ?? []
    list.push(position)
    groupMap.set(position.groupId, list)
  })

  const affectedGroups: AffectedGroup[] = []
  const affectedPositionIds = new Set<string>()
  groupMap.forEach((groupPositions, groupId) => {
    const reasons = new Set<string>()
    groupPositions.forEach((position) => {
      const page = pages.find((item) => item.pageNo === position.pageNo)
      if (!page) return
      const fit = fitAgainst(position, page, batch)
      if (!fit.ok) fit.reasons.forEach((reason) => reasons.add(reason))
    })
    if (reasons.size > 0) {
      affectedGroups.push({
        groupId,
        pageNos: groupPositions.map((item) => item.pageNo),
        positionIds: groupPositions.map((item) => item.id),
        reasons: [...reasons],
      })
      groupPositions.forEach((item) => affectedPositionIds.add(item.id))
    }
  })

  const affectedFragments: AffectedFragment[] = []
  const reusedFragments: AffectedFragment[] = []
  tasks.forEach((task) => {
    if (task.status === '待复核') return
    task.fragments.forEach((fragment) => {
      const basis = basisFor(batch, pages, positions, fragment.pages)
      if (fragment.status === '已完成' && fragment.basisHash === basis) {
        reusedFragments.push({ taskId: task.id, taskName: task.name, fragmentId: fragment.id, label: fragment.label, reason: '依据一致，分片复用' })
      } else if (fragment.status === '已完成' && fragment.basisHash !== basis) {
        affectedFragments.push({ taskId: task.id, taskName: task.name, fragmentId: fragment.id, label: fragment.label, reason: '纸张规格或版位摘要变化' })
      } else if (fragment.status === '待重算' || fragment.status === '写入失败') {
        affectedFragments.push({ taskId: task.id, taskName: task.name, fragmentId: fragment.id, label: fragment.label, reason: fragment.status === '写入失败' ? '上次写盘失败' : '分片待重算' })
      }
    })
  })

  const staleProofIds = proofs.filter((proof) => proof.batchId !== batch.id).map((proof) => proof.id)

  return {
    affectedGroups,
    keptPositionIds: positions.filter((position) => !affectedPositionIds.has(position.id)).map((position) => position.id),
    affectedFragments,
    reusedFragments,
    staleProofIds,
  }
}

/** 旧任务迁移：缺纸批号或版位摘要的任务归待复核、暂不续传 */
function normalizeTasks(raw: unknown, batches: PaperBatch[]): ExportTask[] {
  const list = Array.isArray(raw) ? raw : []
  return list.map((item) => {
    const task = item as ExportTask
    if (task.batchId && Array.isArray(task.fragments) && task.fragments.length >= 0) return task
    return {
      ...task,
      status: '待复核' as const,
      resumable: false,
      batchId: undefined,
      positionSummary: undefined,
      fragments: Array.isArray(task.fragments) ? task.fragments : [],
      reviewReason: '旧任务缺纸批号与版位摘要，先归待复核，暂不续传',
    }
  })
}

function normalizePositions(raw: unknown): Position[] {
  const list = Array.isArray(raw) ? raw : []
  return list.map((item) => {
    const position = item as Position
    return { ...position, status: position.status ?? '正常' }
  })
}

function normalizeProofs(raw: unknown, batches: PaperBatch[]): Proof[] {
  const list = Array.isArray(raw) ? raw : []
  const fallbackBatch = batches[0]?.id ?? ''
  return list.map((item) => {
    const proof = item as Proof
    return { ...proof, batchId: proof.batchId ?? fallbackBatch, stale: proof.stale ?? false }
  })
}

export const useImpositionStore = defineStore('imposition', () => {
  const saved = localStorage.getItem('print-imposition-v2')
  const restored = saved ? JSON.parse(saved) : null

  const pages = ref<Page[]>(restored?.pages ?? structuredClone(seedPages))
  const positions = ref<Position[]>(normalizePositions(restored?.positions ?? structuredClone(seedPositions)))
  const proofs = ref<Proof[]>(normalizeProofs(restored?.proofs ?? structuredClone(seedProofs), restored?.paperBatches ?? seedPaperBatches))
  const paperBatches = ref<PaperBatch[]>(restored?.paperBatches ?? structuredClone(seedPaperBatches))
  const currentBatchId = ref<string>(restored?.currentBatchId ?? paperBatches.value[0]?.id ?? '')
  const tasks = ref<ExportTask[]>(normalizeTasks(restored?.tasks ?? structuredClone(seedTasks), paperBatches.value))
  const side = ref<'front' | 'back'>('front')
  const zoom = ref(72)
  const revision = ref(restored?.revision ?? 'R6')
  const locked = ref(restored?.locked ?? false)
  const selectedPosition = ref<string | null>(null)
  const selectedProof = ref('PRF-02')
  const operatorName = ref(restored?.operatorName ?? '夜班操作员')
  const changeLock = ref<{ by: string; at: number; batchId: string } | null>(restored?.changeLock ?? null)
  const paperDialogOpen = ref(false)
  /** 写盘失败模拟：auto=换纸后首个分片写盘失败一次；off=不模拟；force=下一次写盘强制失败 */
  const writeFailureMode = ref<'auto' | 'off' | 'force'>('auto')

  const currentBatch = computed<PaperBatch>(() => paperBatches.value.find((batch) => batch.id === currentBatchId.value) ?? paperBatches.value[0])

  const validations = computed<Validation[]>(() => {
    const issues: Validation[] = []
    const placedPages = positions.value.map((position) => position.pageNo)
    pages.value.forEach((page) => {
      if (!placedPages.includes(page.pageNo)) issues.push({ id: `missing-${page.pageNo}`, severity: '错误', pageNo: page.pageNo, title: `P${page.pageNo} 尚未拼版`, detail: `${page.name} 未出现在正反版位中。` })
      if (page.bleed < sheetSpec.bleed) issues.push({ id: `bleed-${page.pageNo}`, severity: '错误', pageNo: page.pageNo, title: `P${page.pageNo} 出血不足`, detail: `页面出血 ${page.bleed}mm，低于印刷要求 ${sheetSpec.bleed}mm。` })
    })
    positions.value.forEach((position) => {
      const page = pages.value.find((item) => item.pageNo === position.pageNo)
      if (position.status === '待重算') issues.push({ id: `stale-position-${position.id}`, severity: '错误', pageNo: position.pageNo, title: `${position.id} 版位待重算`, detail: '纸张批次变更后跨页组失效，需重算版位后方可导出。' })
      if (page && currentBatch.value) {
        const fit = fitAgainst(position, page, currentBatch.value)
        if (!fit.ok) issues.push({ id: `safe-${position.id}`, severity: '错误', pageNo: position.pageNo, title: `${position.id} 超出安全区`, detail: fit.reasons.join('；') + '。' })
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

  watch([pages, positions, proofs, tasks, revision, locked, paperBatches, currentBatchId, operatorName, changeLock], () => {
    localStorage.setItem('print-imposition-v2', JSON.stringify({
      pages: pages.value,
      positions: positions.value,
      proofs: proofs.value,
      tasks: tasks.value,
      revision: revision.value,
      locked: locked.value,
      paperBatches: paperBatches.value,
      currentBatchId: currentBatchId.value,
      operatorName: operatorName.value,
      changeLock: changeLock.value,
    }))
  }, { deep: true })

  function updatePosition(id: string, patch: Partial<Position>) {
    if (locked.value) return
    const position = positions.value.find((item) => item.id === id)
    if (position) Object.assign(position, patch)
  }

  function addPosition(pageNo: number) {
    if (locked.value || positions.value.some((item) => item.pageNo === pageNo && item.front === (side.value === 'front'))) return
    positions.value.push({ id: `P-${Date.now().toString().slice(-3)}`, pageNo, x: 34, y: 44, rotation: 0, front: side.value === 'front', status: '正常' })
  }

  function updateProof(id: string, patch: Partial<Proof>) {
    const proof = proofs.value.find((item) => item.id === id)
    if (proof) Object.assign(proof, patch)
  }

  function createProof() {
    proofs.value.push({ id: `PRF-${String(proofs.value.length + 1).padStart(2, '0')}`, round: proofs.value.length + 1, date: new Date().toISOString().slice(0, 10), sample: `数字样张 v${proofs.value.length + 1}`, deltaE: 0, feedback: '', correction: '', owner: operatorName.value, decision: '待决定', batchId: currentBatch.value?.id ?? '', stale: false })
  }

  function lockBaseline() {
    locked.value = true
    revision.value = `R${Number(revision.value.slice(1)) + 1}`
  }

  function unlock() {
    locked.value = false
  }

  function openPaperDialog() { paperDialogOpen.value = true }
  function closePaperDialog() { paperDialogOpen.value = false }

  /** 登记新批次：登记后纸宽、纸高、克重冻结，不可再改 */
  function registerBatch(input: { width: number; height: number; grammage: number; grain: '纵向' | '横向' }): PaperBatch {
    const now = new Date()
    const pad = (value: number) => String(value).padStart(2, '0')
    const batch: PaperBatch = {
      id: `PAPER-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${String(paperBatches.value.length + 1).padStart(2, '0')}`,
      width: input.width,
      height: input.height,
      grammage: input.grammage,
      grain: input.grain,
      registeredAt: `${now.toISOString().slice(0, 10)} ${pad(now.getHours())}:${pad(now.getMinutes())}`,
      registeredBy: operatorName.value,
      status: '历史',
    }
    paperBatches.value.push(batch)
    return batch
  }

  /** 换纸影响分析（不写入状态） */
  function impactOf(batchId: string): Impact {
    const batch = paperBatches.value.find((item) => item.id === batchId) ?? currentBatch.value
    return analyzeImpact(batch, pages.value, positions.value, proofs.value, tasks.value)
  }

  /**
   * 确认换纸：先到者占用锁，后到者拿到冲突与受影响的版位/分片。
   * 占用成功后：切换当前批次，失效受影响跨页组（其他版位保留），
   * 打样结论标待复核，导出分片按依据一致性标记复用或重算。
   */
  function confirmPaperChange(batchId: string, operator?: string): { ok: true; impact: Impact } | { ok: false; conflict: true; lock: NonNullable<typeof changeLock.value>; impact: Impact } {
    const batch = paperBatches.value.find((item) => item.id === batchId)
    if (!batch) throw new Error(`未知纸张批次 ${batchId}`)
    const who = operator?.trim() || operatorName.value || '夜班操作员'
    const now = Date.now()
    const impact = analyzeImpact(batch, pages.value, positions.value, proofs.value, tasks.value)

    if (changeLock.value && changeLock.value.by !== who && now - changeLock.value.at < CHANGE_LOCK_TTL) {
      return { ok: false, conflict: true, lock: changeLock.value, impact }
    }

    changeLock.value = { by: who, at: now, batchId }

    paperBatches.value.forEach((item) => { item.status = item.id === batchId ? '当前' : '历史' })
    currentBatchId.value = batchId

    impact.affectedGroups.forEach((group) => {
      group.positionIds.forEach((id) => {
        const position = positions.value.find((item) => item.id === id)
        if (position) position.status = '待重算'
      })
    })

    proofs.value.forEach((proof) => {
      if (proof.batchId !== batchId) proof.stale = true
    })

    tasks.value.forEach((task) => {
      if (task.status === '待复核') return
      let basisChanged = false
      task.fragments.forEach((fragment) => {
        const basis = basisFor(batch, pages.value, positions.value, fragment.pages)
        if (fragment.status === '已完成' && fragment.basisHash !== basis) {
          fragment.status = '待重算'
          fragment.reused = false
          basisChanged = true
        } else if (fragment.status === '已完成' && fragment.basisHash === basis) {
          fragment.reused = true
        }
        fragment.basisHash = basis
      })
      task.batchId = batchId
      task.positionSummary = positionSummaryFor(pages.value, positions.value)
      if (basisChanged && (task.status === '已完成' || task.status === '生成中' || task.status === '排队中')) {
        task.status = '已中断'
        task.resumable = true
        task.updatedAt = '刚刚'
      }
    })

    window.setTimeout(() => {
      if (changeLock.value?.by === who && changeLock.value?.batchId === batchId) changeLock.value = null
    }, CHANGE_LOCK_TTL)

    return { ok: true, impact }
  }

  function releaseChangeLock() {
    if (changeLock.value && changeLock.value.by === operatorName.value) changeLock.value = null
  }

  /** 重算受影响版位：在新纸张安全区内按网格重排，未受影响版位保留 */
  function recalcAffectedPositions() {
    const rows = [44, 482]
    const cols = [42, 372]
    positions.value.forEach((position) => {
      if (position.status !== '待重算') return
      const used = new Set(
        positions.value
          .filter((item) => item.front === position.front && item.id !== position.id && item.status === '正常')
          .map((item) => `${item.x},${item.y}`),
      )
      for (const ry of rows) {
        let placed = false
        for (const cx of cols) {
          if (used.has(`${cx},${ry}`)) continue
          position.x = cx
          position.y = ry
          position.status = '正常'
          used.add(`${cx},${ry}`)
          placed = true
          break
        }
        if (placed) break
      }
    })

    // 版位重排后依据变化，已完成分片需重算；任务重新打开为可续传
    const batch = currentBatch.value
    tasks.value.forEach((task) => {
      if (task.status === '待复核') return
      let invalidated = false
      task.fragments.forEach((fragment) => {
        const basis = basisFor(batch, pages.value, positions.value, fragment.pages)
        if (fragment.status === '已完成' && fragment.basisHash !== basis) {
          fragment.status = '待重算'
          fragment.reused = false
          invalidated = true
        }
        fragment.basisHash = basis
      })
      task.positionSummary = positionSummaryFor(pages.value, positions.value)
      if (invalidated && (task.status === '已完成' || task.status === '生成中')) {
        task.status = '已中断'
        task.resumable = true
        task.updatedAt = '刚刚'
      }
    })
  }

  function createTask(): ExportTask {
    const batch = currentBatch.value!
    const fragmentDefs = [
      { id: 'F-01', label: 'P1–P4', pages: [1, 2, 3, 4] },
      { id: 'F-02', label: 'P5–P8', pages: [5, 6, 7, 8] },
    ]
    const task: ExportTask = {
      id: `EXP-${new Date().toISOString().slice(2, 10).replace(/-/g, '')}-${String(tasks.value.length + 1).padStart(2, '0')}`,
      name: '印刷交付包 · PDF/X-4',
      progress: 0,
      status: '排队中',
      updatedAt: '刚刚',
      resumable: true,
      batchId: batch.id,
      positionSummary: positionSummaryFor(pages.value, positions.value),
      fragments: fragmentDefs.map((fragment) => ({
        id: fragment.id,
        label: fragment.label,
        pages: fragment.pages,
        status: '待重算',
        basisHash: basisFor(batch, pages.value, positions.value, fragment.pages),
        attempts: 0,
        reused: false,
      })),
    }
    tasks.value.push(task)
    return task
  }

  /**
   * 续传：逐分片写入。已完成分片在新依据一致时复用；
   * 写盘失败则回退到最后确认分片并暂停，下次续传从该分片继续。
   */
  function resumeTask(id: string): ExportTask {
    const task = tasks.value.find((item) => item.id === id)
    if (!task) throw new Error(`未知导出任务 ${id}`)
    if (task.status === '待复核' || !task.resumable) return task

    const batch = currentBatch.value!
    task.status = '生成中'
    task.updatedAt = '刚刚'

    // 依据复核：已完成分片依据不再一致时回退为待重算
    task.fragments.forEach((fragment) => {
      const basis = basisFor(batch, pages.value, positions.value, fragment.pages)
      if (fragment.status === '已完成' && fragment.basisHash !== basis) {
        fragment.status = '待重算'
        fragment.reused = false
      }
      fragment.basisHash = basis
    })

    for (const fragment of task.fragments) {
      if (fragment.status === '已完成') continue
      fragment.attempts += 1
      const willFail = writeFailureMode.value === 'force' || (writeFailureMode.value === 'auto' && fragment.attempts === 1)
      if (willFail) {
        fragment.status = '写入失败'
        task.status = '已中断'
        task.progress = Math.round((task.fragments.filter((item) => item.status === '已完成').length / task.fragments.length) * 100)
        task.updatedAt = '刚刚'
        if (writeFailureMode.value === 'force') writeFailureMode.value = 'off'
        return task
      }
      fragment.status = '已完成'
      fragment.reused = false
      fragment.confirmedAt = new Date().toISOString().slice(5, 16).replace('T', ' ')
    }

    task.status = '已完成'
    task.progress = 100
    task.resumable = false
    task.updatedAt = '刚刚'
    return task
  }

  return {
    pages, positions, proofs, tasks, paperBatches, currentBatchId, side, zoom, revision, locked,
    selectedPosition, selectedProof, operatorName, changeLock, paperDialogOpen, writeFailureMode,
    currentBatch, validations,
    updatePosition, addPosition, updateProof, createProof, lockBaseline, unlock,
    openPaperDialog, closePaperDialog, registerBatch, impactOf, confirmPaperChange, releaseChangeLock,
    recalcAffectedPositions, createTask, resumeTask,
  }
})

/** 供 axios 模拟客户端在组件外读取 store */
export function activeStore() {
  return useImpositionStore(getActivePinia())
}
