<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import axios from 'axios'
import Button from 'primevue/button'
import ProgressBar from 'primevue/progressbar'
import Tag from 'primevue/tag'
import Message from 'primevue/message'
import { useImpositionStore, type ExportTask } from '../stores/imposition'
import { exportApi } from '../api/exportApi'

const store = useImpositionStore()
const queryClient = useQueryClient()
const { data: tasks, isPending } = useQuery({
  queryKey: ['export-tasks'],
  queryFn: async () => (await exportApi.list()).data,
  initialData: store.tasks,
})

watch(tasks, (remote) => {
  if (remote) store.syncTasks(remote)
}, { immediate: true, deep: true })

function synced(): ExportTask[] {
  return tasks.value ?? store.tasks
}
const activeTasks = computed(() => synced().filter((task) => task.status !== '待复核'))
const reviewTasks = computed(() => synced().filter((task) => task.status === '待复核'))
const staleTasks = computed(() => activeTasks.value.filter((task) => task.paperBatchId && task.paperBatchId !== store.activeBatchId))

const notice = ref<{ severity: 'success' | 'warn' | 'error'; text: string } | null>(null)
const busyTask = ref<string | null>(null)

function currentBasis(task: ExportTask) {
  const shardDigests: Record<number, string> = {}
  task.shards?.forEach((shard) => {
    shardDigests[shard.no] = store.digestOfPages(shard.pageNos)
  })
  return { paperBatchId: store.activeBatchId, positionDigest: store.currentDigest, shardDigests }
}

const createMutation = useMutation({
  mutationFn: async () => {
    if (!store.canExport) throw new Error('存在未确认/失效版位，或有人正在换纸，不能出交付包')
    const task = store.createExportTask()
    return (await exportApi.create(task)).data
  },
  onSuccess: () => {
    queryClient.invalidateQueries({ queryKey: ['export-tasks'] })
    notice.value = { severity: 'success', text: '交付包已按当前纸批次与版位摘要创建，分片待写入。' }
  },
  onError: (err: unknown) => {
    notice.value = { severity: 'error', text: axios.isAxiosError(err) ? err.message : String(err) }
  },
})

const resumeMutation = useMutation({
  mutationFn: async (task: ExportTask) => {
    busyTask.value = task.id
    return (await exportApi.resume(task.id, currentBasis(task))).data
  },
  onSuccess: ({ task, touched }) => {
    queryClient.invalidateQueries({ queryKey: ['export-tasks'] })
    const failed = touched.filter((s) => s.status === '写入失败')
    const confirmed = touched.filter((s) => s.status === '已确认')
    if (task.status === '已完成') {
      notice.value = { severity: 'success', text: `${task.id} 全部分片写入并哈希校验通过，交付包仅含纸批次 ${store.activeBatch.code}。` }
    } else if (failed.length) {
      notice.value = { severity: 'warn', text: `${task.id} ${failed[0].name} 写盘仍失败，已恢复到最后确认分片；已完成分片依据一致，已自动复用，可再次继续。` }
    } else {
      notice.value = { severity: 'success', text: `${task.id} 已恢复到最后确认分片继续：${confirmed.map((s) => s.name).join('、')} 写入完成，其余分片排队。` }
    }
  },
  onError: (err: unknown) => {
    queryClient.invalidateQueries({ queryKey: ['export-tasks'] })
    const message = axios.isAxiosError(err) ? (err.response?.data as { message?: string })?.message ?? err.message : String(err)
    notice.value = { severity: 'error', text: message }
  },
  onSettled: () => {
    busyTask.value = null
  },
})

const rebaseMutation = useMutation({
  mutationFn: async (task: ExportTask) => (await exportApi.rebase(task.id, currentBasis(task))).data,
  onSuccess: () => {
    queryClient.invalidateQueries({ queryKey: ['export-tasks'] })
    notice.value = { severity: 'success', text: '已按当前纸批次重建分片基线：依据一致的已完成分片保留复用，其余回到待写入，可续传。' }
  },
})

const reviewMutation = useMutation({
  mutationFn: async (task: ExportTask) => (await exportApi.review(task.id, currentBasis(task))).data,
  onSuccess: () => {
    queryClient.invalidateQueries({ queryKey: ['export-tasks'] })
    notice.value = { severity: 'success', text: '已补登纸批号与版位摘要，任务从待复核转出，可按当前依据续传。' }
  },
})

function statusSeverity(status?: string) {
  return status === '已完成' ? 'success' : status === '已中断' ? 'danger' : status === '生成中' ? 'warn' : status === '待复核' ? 'secondary' : 'info'
}
function shardSeverity(status?: string) {
  return status === '已确认' ? 'success' : status === '写入失败' ? 'danger' : 'secondary'
}
</script>

<template>
  <section class="page">
    <div class="page-head">
      <div><p class="eyebrow">EXPORT JOBS / 导出任务</p><h1>交付包与断点恢复</h1><p class="muted">每个任务和分片都带纸批号与版位摘要：写盘失败回到最后确认分片；新依据一致的已完成分片直接复用；缺依据的旧任务先待复核。</p></div>
      <Button
        label="新建印刷交付包"
        icon="pi pi-plus"
        :loading="createMutation.isPending.value"
        :disabled="!store.canExport"
        @click="createMutation.mutate()"
      />
    </div>

    <Message v-if="!store.canExport" severity="warn" :closable="false" class="mb-3">
      仍有版位因换纸失效/越界，或有人正在确认换纸，交付包可能混入两批纸张，暂不允许新建导出。请先在纸张批次 / 拼版工作区完成失效跨页组的重算与确认。
    </Message>
    <Message v-if="notice" :severity="notice.severity" :closable="false" class="mb-3" @close="notice = null">
      {{ notice.text }}
    </Message>

    <div v-if="reviewTasks.length" class="panel review-panel">
      <div class="panel-head"><h3>待复核（缺纸批号 / 版位摘要）</h3><Tag :value="`${reviewTasks.length} 个旧任务`" severity="secondary" /></div>
      <div class="review-list">
        <article v-for="task in reviewTasks" :key="task.id">
          <div class="task-head">
            <div><strong>{{ task.name }}</strong><small>{{ task.id }} · {{ task.updatedAt }} · 进度 {{ task.progress }}%</small></div>
            <Tag value="待复核" severity="secondary" />
          </div>
          <p class="reason"><i class="pi pi-shield" />{{ task.reviewReason ?? '旧任务缺少纸批号或版位摘要，暂不续传。' }}</p>
          <div class="task-foot">
            <span class="muted">补登为当前依据 {{ store.activeBatch.code }} 后才能继续</span>
            <Button label="补依据并转出复核" icon="pi pi-clipboard-check" size="small" outlined :loading="reviewMutation.isPending.value" @click="reviewMutation.mutate(task)" />
          </div>
        </article>
      </div>
    </div>

    <div class="export-grid">
      <section class="panel">
        <div class="panel-head"><h3>导出队列</h3><span class="muted">Axios 模拟 REST · 4 分片</span></div>
        <div v-if="isPending" class="loading">正在加载导出任务…</div>
        <div v-else class="task-list">
          <article v-for="task in activeTasks" :key="task.id" :class="{ stale: task.paperBatchId !== store.activeBatchId }">
            <div class="task-head">
              <div>
                <strong>{{ task.name }}</strong>
                <small>{{ task.id }} · {{ task.updatedAt }}</small>
                <small class="basis">依据 {{ store.batchCode(task.paperBatchId ?? '') }} · 版位摘要 #{{ (task.positionDigest ?? '').slice(0, 8) }}
                  <Tag v-if="task.paperBatchId !== store.activeBatchId" value="批次不一致" severity="danger" />
                </small>
              </div>
              <Tag :value="task.status" :severity="statusSeverity(task.status)" />
            </div>
            <ProgressBar :value="task.progress" :showValue="false" :style="{ height: '8px' }" />

            <div v-if="task.shards?.length" class="shards">
              <div v-for="shard in task.shards" :key="shard.no" :class="`s-${shard.status}`">
                <div class="shard-head"><i :class="shard.status === '已确认' ? 'pi pi-check-circle' : shard.status === '写入失败' ? 'pi pi-times-circle' : 'pi pi-clock'" /><strong>{{ shard.name }}</strong><Tag :value="shard.status" :severity="shardSeverity(shard.status)" /></div>
                <small>P{{ shard.pageNos.join('/P') }} · 尝试 {{ shard.attempts }} 次</small>
                <small v-if="shard.confirmedBatchId" class="shard-basis">确认于 {{ store.batchCode(shard.confirmedBatchId) }} · #{{ shard.digest?.slice(0, 8) }}</small>
                <small v-if="shard.lastError" class="error-text">{{ shard.lastError }}</small>
              </div>
            </div>

            <div class="task-foot">
              <span>{{ task.progress }}% · {{ task.status === '已完成' ? '文件哈希已校验' : '已保留最后确认分片' }}</span>
              <template v-if="task.paperBatchId !== store.activeBatchId">
                <Button label="按新批次重建分片后续传" icon="pi pi-refresh" size="small" severity="warning" outlined :loading="rebaseMutation.isPending.value" @click="rebaseMutation.mutate(task)" />
              </template>
              <Button
                v-else-if="task.resumable && task.status !== '已完成'"
                label="恢复任务（从最后确认分片）"
                icon="pi pi-play"
                size="small"
                :loading="busyTask === task.id"
                @click="resumeMutation.mutate(task)"
              />
              <Button v-else-if="task.status !== '已完成'" label="重新生成" icon="pi pi-refresh" size="small" outlined />
              <Button v-else label="打开结果" icon="pi pi-external-link" size="small" text />
            </div>
          </article>
          <div v-if="!activeTasks.length" class="loading">没有在途任务。</div>
        </div>
      </section>

      <aside>
        <section class="panel">
          <div class="panel-head"><h3>交付包内容</h3><Tag :value="store.revision" /></div>
          <div class="package-list">
            <div><i class="pi pi-file-pdf" /><span>拼版 PDF/X-4</span><strong>{{ store.activeBatch.code }}</strong></div>
            <div><i class="pi pi-check-circle" /><span>预检报告 JSON</span><strong>{{ store.validations.length }} 项</strong></div>
            <div><i class="pi pi-check-circle" /><span>色彩控制条报告</span><strong>已包含</strong></div>
            <div><i class="pi pi-check-circle" /><span>打样审批记录</span><strong>{{ store.proofs.length }} 轮</strong></div>
            <div><i class="pi pi-check-circle" /><span>纸张与折手规格</span><strong>{{ store.activeBatch.width }}×{{ store.activeBatch.height }}/{{ store.activeBatch.gsm }}g</strong></div>
            <div><i class="pi pi-check-circle" /><span>分片版位摘要</span><strong>#{{ store.currentDigest.slice(0, 8) }}</strong></div>
          </div>
        </section>
        <section class="panel recovery">
          <div class="panel-head"><h3>恢复规则</h3></div>
          <p>分片按帖写入临时目录。写盘失败后只回退到最后确认的分片继续；已完成分片在<strong>纸批号与分片版位摘要一致</strong>时复用，任一不同则按新依据重写。缺依据旧任务一律先归待复核，不续传。</p>
        </section>
      </aside>
    </div>
  </section>
</template>

<style scoped>
.mb-3 { margin-bottom: 12px; }
.export-grid { display: grid; grid-template-columns: minmax(0,1fr) 330px; gap: 14px; align-items: start; }
.loading { padding: 30px; color: #75838a; text-align: center; }
.review-panel { margin-bottom: 14px; }
.review-list { padding: 8px 16px 16px; display: grid; gap: 12px; }
.review-list article { padding: 13px 14px; border: 1px dashed #d3b98c; border-radius: 8px; background: #fdf9f1; }
.reason { display: flex; gap: 7px; align-items: center; margin: 8px 0; color: #8a6a3f; font-size: 11px; }
.task-list { padding: 8px 16px 16px; }
.task-list > article { padding: 15px 0; border-bottom: 1px solid #e9eeee; }
.task-list > article.stale { background: #fdf3f0; margin: 0 -8px; padding: 15px 8px; border-radius: 8px; }
.task-head, .task-foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.task-head { margin-bottom: 11px; }
.task-head strong, .task-head small { display: block; }
.task-head small { margin-top: 4px; color: #7c898f; font-size: 10px; }
.task-head small.basis { display: flex; align-items: center; gap: 6px; font-family: monospace; }
.task-foot { margin-top: 9px; }
.task-foot span { color: #68777e; font-size: 10px; }
.shards { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin: 12px 0 4px; }
.shards > div { display: grid; gap: 3px; padding: 9px 10px; border-radius: 7px; background: #f4f7f6; border-left: 3px solid #c5d0d2; }
.shards > div.s-已确认 { border-left-color: #3b8a67; background: #eef7f2; }
.shards > div.s-写入失败 { border-left-color: #bd4a34; background: #fdeee9; }
.shard-head { display: flex; align-items: center; gap: 6px; }
.shard-head i { font-size: 12px; }
.shard-head strong { font-size: 10px; flex: 1; }
.shards small { font-size: 9px; color: #7c898f; }
.shards small.shard-basis { font-family: monospace; }
.shards small.error-text { color: #b84e35; }
aside { display: grid; gap: 14px; }
.package-list { padding: 8px 16px 16px; }
.package-list div { display: grid; grid-template-columns: 24px 1fr auto; align-items: center; gap: 8px; padding: 10px 0; border-bottom: 1px solid #edf1f1; font-size: 11px; }
.package-list i { color: #397d64; }
.package-list strong { color: #536b72; font-size: 10px; }
.recovery p { padding: 0 16px 16px; color: #67767d; font-size: 11px; line-height: 1.7; }
.recovery strong { color: #337b79; }
@media (max-width: 1000px) { .export-grid { grid-template-columns: 1fr; } .shards { grid-template-columns: 1fr; } }
</style>
