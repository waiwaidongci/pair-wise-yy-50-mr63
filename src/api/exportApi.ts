import axios, { type AxiosAdapter, type AxiosError } from 'axios'
import { seedExportTasks, type ExportShard, type ExportTask } from '../stores/imposition'

const tasks: ExportTask[] = seedExportTasks()

function nowText() {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function recomputeProgress(task: ExportTask) {
  const shards = task.shards ?? []
  if (!shards.length) return
  task.progress = Math.round((shards.filter((s) => s.status === '已确认').length / shards.length) * 100)
}

type ResumeBody = {
  paperBatchId: string
  positionDigest: string
  shardDigests: Record<number, string>
}

function errorResponse(config: Parameters<AxiosAdapter>[0], status: number, code: string, message: string) {
  const err = new Error(message) as AxiosError
  err.config = config
  err.response = { data: { code, message }, status, statusText: message, headers: {}, config }
  return Promise.reject(err)
}

const adapter: AxiosAdapter = async (config) => {
  await new Promise((resolve) => setTimeout(resolve, 160))

  if (config.url === '/api/print/export-tasks' && config.method === 'get') {
    return { data: structuredClone(tasks), status: 200, statusText: 'OK', headers: {}, config }
  }

  const resumeMatch = config.url?.match(/^\/api\/print\/export-tasks\/[^/]+\/resume$/)
  if (resumeMatch && config.method === 'post') {
    const id = config.url!.split('/').at(-2)!
    const task = tasks.find((item) => item.id === id)
    if (!task) return errorResponse(config, 404, 'TASK_NOT_FOUND', '导出任务不存在')
    if (task.status === '待复核') return errorResponse(config, 409, 'PENDING_REVIEW', '旧任务缺少纸批号或版位摘要，已归待复核，暂不续传')
    if (!task.resumable || task.status === '已完成') return errorResponse(config, 409, 'NOT_RESUMABLE', '该任务当前不可恢复')

    const body = (config.data ? JSON.parse(config.data as string) : {}) as ResumeBody
    // 续传必须声明当前纸批次与版位摘要，杜绝两批纸混进同一个交付包
    if (!body.paperBatchId || !body.positionDigest) {
      task.status = '待复核'
      task.resumable = false
      task.reviewReason = '续传请求未带纸批号或版位摘要，自动转入待复核'
      task.updatedAt = nowText()
      return { data: structuredClone(task), status: 200, statusText: 'OK', headers: {}, config }
    }
    if (body.paperBatchId !== task.paperBatchId) {
      return errorResponse(config, 409, 'BATCH_MISMATCH', `任务依据 ${task.paperBatchId} 与当前纸批次 ${body.paperBatchId} 不一致，请重建分片`)
    }

    task.status = '生成中'
    task.updatedAt = nowText()

    // 从最后确认的分片继续；先按新依据校准每个分片：依据一致则复用，不一致则重置
    const touched: ExportShard[] = []
    const resetNos = new Set<number>()
    ;(task.shards ?? []).forEach((shard) => {
      const currentDigest = body.shardDigests[shard.no]
      if (shard.status === '已确认') {
        if (shard.confirmedBatchId === body.paperBatchId && shard.digest === currentDigest) return // 复用
        shard.status = '待写入'
        shard.confirmedBatchId = undefined
        shard.digest = undefined
        shard.attempts = 0
        shard.lastError = '版位摘要变化，已完成分片按新依据重置'
        resetNos.add(shard.no)
        touched.push(shard)
      }
    })

    // 找到第一个非确认分片作为恢复点（"最后确认分片"之后）；
    // 本轮刚因摘要变化被重置的分片不立即重写，交给下一轮恢复，避免吞掉不一致
    const pending = (task.shards ?? []).find((shard) => shard.status !== '已确认' && !resetNos.has(shard.no))
    if (pending) {
      pending.attempts += 1
      // 模拟：该分片首次继续写盘仍失败，重试时成功 —— 演示失败后回到最后确认分片再续
      if (pending.attempts % 2 === 0) {
        pending.status = '写入失败'
        pending.lastError = `写盘失败（第 ${pending.attempts} 次尝试）：已保留分片 1…${pending.no - 1}，可恢复到最后确认分片重试`
        task.status = '已中断'
      } else {
        pending.status = '已确认'
        pending.confirmedBatchId = body.paperBatchId
        pending.digest = body.shardDigests[pending.no]
        pending.lastError = undefined
      }
      touched.push(pending)
    }

    const allConfirmed = (task.shards ?? []).every((shard) => shard.status === '已确认')
    if (allConfirmed) {
      task.status = '已完成'
      task.resumable = false
      task.updatedAt = nowText()
    } else if (task.status === '生成中') {
      // 只推进了一个分片，仍保持可恢复
      task.status = '已中断'
    }
    recomputeProgress(task)
    return { data: structuredClone({ task, touched }), status: 200, statusText: 'OK', headers: {}, config }
  }

  // 重建分片基线：当前版位全部确认到新批次后，把任务挂到新依据上
  const rebaseMatch = config.url?.match(/^\/api\/print\/export-tasks\/[^/]+\/rebase$/)
  if (rebaseMatch && config.method === 'post') {
    const id = config.url!.split('/').at(-2)!
    const task = tasks.find((item) => item.id === id)
    if (!task) return errorResponse(config, 404, 'TASK_NOT_FOUND', '导出任务不存在')
    const body = (config.data ? JSON.parse(config.data as string) : {}) as ResumeBody
    if (!body.paperBatchId || !body.positionDigest) return errorResponse(config, 400, 'MISSING_BASIS', '重建必须提供纸批号与版位摘要')
    task.paperBatchId = body.paperBatchId
    task.positionDigest = body.positionDigest
    task.status = '已中断'
    task.resumable = true
    task.reviewReason = undefined
    task.updatedAt = nowText()
    ;(task.shards ?? []).forEach((shard) => {
      const currentDigest = body.shardDigests[shard.no]
      if (shard.status === '已确认' && shard.confirmedBatchId === body.paperBatchId && shard.digest === currentDigest) return
      shard.status = '待写入'
      shard.confirmedBatchId = undefined
      shard.digest = undefined
      shard.attempts = 0
      shard.lastError = undefined
    })
    recomputeProgress(task)
    return { data: structuredClone(task), status: 200, statusText: 'OK', headers: {}, config }
  }

  // 旧任务补依据后出待复核
  const reviewMatch = config.url?.match(/^\/api\/print\/export-tasks\/[^/]+\/review$/)
  if (reviewMatch && config.method === 'post') {
    const id = config.url!.split('/').at(-2)!
    const task = tasks.find((item) => item.id === id)
    if (!task) return errorResponse(config, 404, 'TASK_NOT_FOUND', '导出任务不存在')
    const body = (config.data ? JSON.parse(config.data as string) : {}) as ResumeBody
    task.paperBatchId = body.paperBatchId
    task.positionDigest = body.positionDigest
    task.reviewReason = undefined
    task.status = '已中断'
    task.resumable = true
    task.updatedAt = nowText()
    if (!task.shards) task.shards = []
    return { data: structuredClone(task), status: 200, statusText: 'OK', headers: {}, config }
  }

  if (config.url === '/api/print/export-tasks' && config.method === 'post') {
    const body = (config.data ? JSON.parse(config.data as string) : {}) as ExportTask
    const task: ExportTask = { ...body, status: '排队中', updatedAt: nowText() }
    tasks.unshift(task)
    return { data: structuredClone(task), status: 201, statusText: 'Created', headers: {}, config }
  }

  return { data: null, status: 404, statusText: 'Not Found', headers: {}, config }
}

const client = axios.create({ adapter })

export const exportApi = {
  list: () => client.get<ExportTask[]>('/api/print/export-tasks'),
  resume: (id: string, basis: ResumeBody) =>
    client.post<{ task: ExportTask; touched: ExportShard[] }>(`/api/print/export-tasks/${id}/resume`, basis),
  rebase: (id: string, basis: ResumeBody) => client.post<ExportTask>(`/api/print/export-tasks/${id}/rebase`, basis),
  review: (id: string, basis: ResumeBody) => client.post<ExportTask>(`/api/print/export-tasks/${id}/review`, basis),
  create: (task: ExportTask) => client.post<ExportTask>('/api/print/export-tasks', task),
}

export type { ResumeBody }
