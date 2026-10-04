<script setup lang="ts">
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import Button from 'primevue/button'
import ProgressBar from 'primevue/progressbar'
import Tag from 'primevue/tag'
import Message from 'primevue/message'
import SelectButton from 'primevue/selectbutton'
import { useImpositionStore, type ExportTask, type FragmentStatus } from '../stores/imposition'
import { exportApi } from '../api/exportApi'

const store = useImpositionStore()
const queryClient = useQueryClient()
const { data: tasks, isPending } = useQuery({
  queryKey: ['export-tasks'],
  queryFn: async () => (await exportApi.list()).data,
  initialData: store.tasks,
})
const resumeMutation = useMutation({
  mutationFn: async (id: string) => (await exportApi.resume(id)).data,
  onSuccess: () => queryClient.invalidateQueries({ queryKey: ['export-tasks'] }),
})
const createMutation = useMutation({
  mutationFn: async () => (await exportApi.create()).data,
  onSuccess: () => queryClient.invalidateQueries({ queryKey: ['export-tasks'] }),
})

const failureOptions = [
  { label: '自动模拟失败', value: 'auto' },
  { label: '不模拟', value: 'off' },
  { label: '强制下次失败', value: 'force' },
]

function statusSeverity(status?: string) {
  return status === '已完成' ? 'success' : status === '已中断' ? 'danger' : status === '生成中' ? 'warn' : 'info'
}
function fragmentSeverity(status: FragmentStatus) {
  return status === '已完成' ? 'success' : status === '写入失败' ? 'danger' : 'warn'
}
function fragmentTag(task: ExportTask, fragmentId: string) {
  const fragment = task.fragments.find((item) => item.id === fragmentId)
  if (!fragment) return '待重算'
  if (fragment.status === '已完成') return fragment.reused ? '复用' : '已完成'
  if (fragment.status === '写入失败') return '写入失败'
  return '待重算'
}
function confirmedCount(task: ExportTask) {
  return task.fragments.filter((fragment) => fragment.status === '已完成').length
}
</script>

<template>
  <section class="page">
    <div class="page-head">
      <div><p class="eyebrow">EXPORT JOBS / 导出任务</p><h1>交付包与断点恢复</h1><p class="muted">中断任务保留已确认分片与版位摘要；换纸后仅依据不一致的分片重算，依据一致的分片直接复用。</p></div>
      <Button label="新建印刷交付包" icon="pi pi-plus" :loading="createMutation.isPending.value" @click="createMutation.mutate()" />
    </div>

    <div class="export-grid">
      <section class="panel">
        <div class="panel-head"><h3>导出队列</h3><span class="muted">Axios 模拟 REST</span></div>
        <div v-if="isPending" class="loading">正在加载导出任务…</div>
        <div v-else class="task-list">
          <article v-for="task in (tasks ?? store.tasks)" :key="task.id">
            <div class="task-head">
              <div>
                <strong>{{ task.name }}</strong>
                <small>{{ task.id }} · {{ task.updatedAt }}</small>
              </div>
              <Tag :value="task.status" :severity="statusSeverity(task.status)" />
            </div>

            <Message v-if="task.status === '待复核'" severity="warn" :closable="false" class="review-note">
              {{ task.reviewReason }}
            </Message>

            <div class="task-basis">
              <span>纸批号 <b>{{ task.batchId ?? '—' }}</b></span>
              <span>版位摘要 <b>{{ task.positionSummary ?? '—' }}</b></span>
            </div>

            <ProgressBar :value="task.progress" :showValue="false" :style="{ height: '8px' }" />

            <div v-if="task.fragments.length" class="fragment-list">
              <div v-for="fragment in task.fragments" :key="fragment.id" class="fragment-row">
                <Tag :value="fragmentTag(task, fragment.id)" :severity="fragmentSeverity(fragment.status)" />
                <span>{{ fragment.label }}</span>
                <code>{{ fragment.basisHash || '—' }}</code>
                <small v-if="fragment.status === '已完成' && fragment.reused">依据一致 · 复用</small>
                <small v-else-if="fragment.status === '已完成'">确认于 {{ fragment.confirmedAt }}</small>
                <small v-else-if="fragment.status === '写入失败'">写盘失败，等待续传</small>
                <small v-else>未开始</small>
              </div>
            </div>

            <div class="task-foot">
              <span>{{ task.progress }}% · 已确认 {{ confirmedCount(task) }}/{{ task.fragments.length }} 分片 · {{ task.progress === 100 ? '文件哈希已校验' : '保留已完成分片' }}</span>
              <Button v-if="task.status === '待复核'" label="待复核 · 暂不续传" icon="pi pi-pause" size="small" disabled />
              <Button v-else-if="task.resumable && task.status !== '已完成'" label="恢复任务" icon="pi pi-play" size="small" :loading="resumeMutation.isPending.value" @click="resumeMutation.mutate(task.id)" />
              <Button v-else-if="task.status !== '已完成'" label="重新生成" icon="pi pi-refresh" size="small" outlined />
              <Button v-else label="打开结果" icon="pi pi-external-link" size="small" text />
            </div>
          </article>
        </div>
      </section>

      <aside>
        <section class="panel">
          <div class="panel-head"><h3>交付包内容</h3><Tag :value="store.revision" /></div>
          <div class="package-list">
            <div><i class="pi pi-file-pdf" /><span>拼版 PDF/X-4</span><strong>待生成</strong></div>
            <div><i class="pi pi-check-circle" /><span>预检报告 JSON</span><strong>{{ store.validations.length }} 项</strong></div>
            <div><i class="pi pi-check-circle" /><span>色彩控制条报告</span><strong>已包含</strong></div>
            <div><i class="pi pi-check-circle" /><span>打样审批记录</span><strong>{{ store.proofs.length }} 轮</strong></div>
            <div><i class="pi pi-check-circle" /><span>纸张规格（批次 {{ store.currentBatch?.id }}）</span><strong>已冻结</strong></div>
          </div>
        </section>
        <section class="panel recovery">
          <div class="panel-head"><h3>恢复说明</h3></div>
          <p>分片按每 4 页一组写入临时目录。写盘失败后恢复到最后确认分片并继续；换纸后仅依据不一致的分片重算，纸批号与版位摘要缺失的旧任务先归待复核、暂不续传。</p>
          <div class="failure-toggle">
            <span>写盘失败模拟</span>
            <SelectButton v-model="store.writeFailureMode" :options="failureOptions" optionLabel="label" optionValue="value" />
          </div>
          <Button label="清理已完成任务" severity="secondary" outlined fluid />
        </section>
      </aside>
    </div>
  </section>
</template>

<style scoped>
.export-grid { display: grid; grid-template-columns: minmax(0,1fr) 330px; gap: 14px; align-items: start; }
.loading { padding: 30px; color: #75838a; text-align: center; }
.task-list { padding: 8px 16px 16px; }
.task-list article { padding: 15px 0; border-bottom: 1px solid #e9eeee; }
.task-head, .task-foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.task-head { margin-bottom: 11px; }
.task-head strong, .task-head small { display: block; }
.task-head small { margin-top: 4px; color: #7c898f; font-size: 10px; }
.review-note { margin-bottom: 10px; }
.task-basis { display: flex; flex-wrap: wrap; gap: 6px 18px; margin-bottom: 10px; font-size: 11px; color: #68777e; }
.task-basis b { color: #3d5258; font-family: monospace; }
.fragment-list { display: grid; gap: 6px; margin: 10px 0; }
.fragment-row { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border: 1px solid #edf1f1; border-radius: 6px; background: #fafcfc; font-size: 11px; }
.fragment-row span { color: #3d5258; }
.fragment-row code { padding: 2px 6px; border-radius: 4px; background: #eef2f2; color: #5d7077; font-size: 10px; }
.fragment-row small { margin-left: auto; color: #8a979b; font-size: 10px; }
.task-foot { margin-top: 9px; }
.task-foot span { color: #68777e; font-size: 10px; }
aside { display: grid; gap: 14px; }
.package-list { padding: 8px 16px 16px; }
.package-list div { display: grid; grid-template-columns: 24px 1fr auto; align-items: center; gap: 8px; padding: 10px 0; border-bottom: 1px solid #edf1f1; font-size: 11px; }
.package-list i { color: #397d64; }
.package-list strong { color: #536b72; font-size: 10px; }
.recovery p { padding: 0 16px; color: #67767d; font-size: 11px; line-height: 1.6; }
.failure-toggle { display: grid; gap: 6px; padding: 0 16px 14px; font-size: 11px; color: #68777e; }
.recovery :deep(.p-button) { width: calc(100% - 32px); margin: 0 16px 16px; }
@media (max-width: 1000px) { .export-grid { grid-template-columns: 1fr; } }
</style>
