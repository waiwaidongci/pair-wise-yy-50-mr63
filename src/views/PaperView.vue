<script setup lang="ts">
import { computed, ref } from 'vue'
import Button from 'primevue/button'
import InputText from 'primevue/inputtext'
import InputNumber from 'primevue/inputnumber'
import Tag from 'primevue/tag'
import Message from 'primevue/message'
import Select from 'primevue/select'
import { useImpositionStore } from '../stores/imposition'
import { paperLock } from '../lib/paperLock'

const store = useImpositionStore()

const operators = ['林青 / 拼版', '周默 / 色彩管理', '赵启明 / 仓管', '陈放 / 机长']

// ── 新批次登记 ──
const form = ref({ code: '', supplier: '', width: 720, height: 1020, gsm: 128 })
const justRegistered = ref<string | null>(null)
function register() {
  if (!form.value.code || !form.value.supplier) return
  const batch = store.registerPaperBatch({ ...form.value })
  form.value = { code: '', supplier: '', width: batch.width, height: batch.height, gsm: batch.gsm }
  justRegistered.value = batch.id
  candidateId.value = batch.id
}

// ── 换纸流程 ──
const candidateId = ref(store.batches.find((b) => b.id !== store.activeBatchId)?.id ?? '')
const acquireError = ref('')

const candidateBatches = computed(() => store.batches.filter((b) => b.id !== store.activeBatchId))
const candidate = computed(() => store.batches.find((b) => b.id === candidateId.value))
const preview = computed(() => (candidate.value ? store.previewPaperChange(candidate.value.id) : null))

const lock = computed(() => store.paperLockState)
const heldByMe = computed(() => store.lockHeldByMe)
const heldByOther = computed(() => store.lockHeldByOther)
const remainingSeconds = computed(() => (lock.value ? Math.ceil(paperLock.remainingMs(lock.value) / 1000) : 0))

function startChange() {
  acquireError.value = ''
  const result = store.acquirePaperLock(candidateId.value)
  if (!result.ok && result.lock) {
    acquireError.value = `${result.lock.owner} 已先占用换纸确认（目标 ${batchLabel(result.lock.candidateBatchId)}），请等待其完成或锁到期`
  }
}

function batchLabel(id: string) {
  const batch = store.batches.find((b) => b.id === id)
  return batch ? `${batch.code} ${batch.width}×${batch.height}/${batch.gsm}g` : id
}

function confirmChange() {
  if (!candidate.value) return
  const ok = store.confirmPaperChange(candidate.value.id)
  store.releasePaperLock()
  if (!ok) acquireError.value = '占用已过期或被他人取得，换纸未执行；请重新占用确认。'
}
function cancelChange() {
  store.releasePaperLock()
}

// 后到者视角：受影响版位 + 分片清单
const blockedPositions = computed(() => {
  if (!lock.value) return []
  const targetId = lock.value.candidateBatchId
  const target = store.batches.find((b) => b.id === targetId)
  if (!target) return []
  return store.positions.filter((p) => !store.pageFits(p, targetId))
})
const blockedShards = computed(() => {
  if (!lock.value) return []
  const pageSet = new Set(blockedPositions.value.map((p) => p.pageNo))
  const rows: Array<{ taskId: string; shardName: string; pages: number[] }> = []
  store.tasks.forEach((task) => {
    task.shards?.forEach((shard) => {
      if (shard.pageNos.some((n) => pageSet.has(n))) rows.push({ taskId: task.id, shardName: shard.name, pages: shard.pageNos })
    })
  })
  return rows
})

const lockTargetsMe = computed(() => lock.value && candidateId.value === lock.value.candidateBatchId)

function statusTag(status: string) {
  return status === 'confirmed' ? { value: '已确认', severity: 'success' as const }
    : status === 'pending' ? { value: '待确认', severity: 'warn' as const }
      : { value: '已失效', severity: 'danger' as const }
}
</script>

<template>
  <section class="page">
    <div class="page-head">
      <div>
        <p class="eyebrow">PAPER LOT / 纸张批次</p>
        <h1>夜班换纸与可恢复确认</h1>
        <p class="muted">新批次登记后冻结纸宽、纸高和克重；换纸只让受影响的跨页组失效重算，版位、打样与导出分片全部带纸批号留痕。</p>
      </div>
      <label class="operator">当前操作者
        <Select v-model="store.operator" :options="operators" />
      </label>
    </div>

    <!-- 后到者被占用时的只读提示 -->
    <Message v-if="heldByOther" severity="warn" :closable="false" class="mb-3">
      <template #icon><i class="pi pi-lock" /></template>
      <strong>{{ lock?.owner }}</strong> 正在确认换纸（目标 {{ batchLabel(lock!.candidateBatchId) }}），先到者占用中，剩余 {{ remainingSeconds }} 秒。
      受影响版位 {{ blockedPositions.length }} 个、导出分片 {{ blockedShards.length }} 个，下方为只读清单，不能同时确认。
    </Message>
    <Message v-if="heldByMe" severity="info" :closable="false" class="mb-3">
      <i class="pi pi-key" /> 你（{{ store.operator }}）已占用换纸确认，剩余 {{ remainingSeconds }} 秒（自动续约）。确认或取消后释放占用。
    </Message>
    <Message v-if="acquireError" severity="error" :closable="false" class="mb-3">{{ acquireError }}</Message>

    <div class="paper-grid">
      <div class="main-col">
        <!-- 当前在用批次 -->
        <section class="panel active-batch">
          <div class="panel-head">
            <h3>当前在用纸批次</h3>
            <Tag value="冻结规格" severity="info" />
          </div>
          <div class="batch-card">
            <div class="batch-code">{{ store.activeBatch.code }}</div>
            <div class="batch-dims"><strong>{{ store.activeBatch.width }} × {{ store.activeBatch.height }}</strong><span>mm · {{ store.activeBatch.gsm }}g/㎡</span></div>
            <dl>
              <div><dt>供应商</dt><dd>{{ store.activeBatch.supplier }}</dd></div>
              <div><dt>登记时间</dt><dd>{{ store.activeBatch.registeredAt }}</dd></div>
              <div><dt>登记人</dt><dd>{{ store.activeBatch.registeredBy }}</dd></div>
              <div><dt>批次 ID</dt><dd>{{ store.activeBatch.id }}</dd></div>
            </dl>
          </div>
          <p class="note">登记即冻结：纸宽 / 纸高 / 克重不允许就地修改，规格变化只能登记新批次，保证交付包可追溯到唯一纸卷。</p>
        </section>

        <!-- 换纸确认 -->
        <section class="panel">
          <div class="panel-head"><h3>换纸确认</h3><span class="muted">先到者占用 · 影响预览后确认</span></div>
          <div class="change-body">
            <label class="field">目标批次
              <Select
                v-model="candidateId"
                :options="candidateBatches"
                optionLabel="code"
                optionValue="id"
                :disabled="heldByMe || heldByOther"
              />
            </label>
            <div v-if="candidate" class="dim-compare">
              <div class="dim from">
                <small>现用</small>
                <strong>{{ store.activeBatch.width }}×{{ store.activeBatch.height }}</strong>
                <span>{{ store.activeBatch.gsm }}g</span>
              </div>
              <i class="pi pi-arrow-right" />
              <div class="dim to" :class="{ changed: candidate.width !== store.activeBatch.width || candidate.height !== store.activeBatch.height }">
                <small>{{ candidate.code }}</small>
                <strong>{{ candidate.width }}×{{ candidate.height }}</strong>
                <span>{{ candidate.gsm }}g</span>
              </div>
            </div>

            <div v-if="preview && !heldByOther" class="impact">
              <h4>影响预览（确认前不改动任何版位）</h4>
              <div class="impact-row">
                <span>失效重算的跨页组</span>
                <strong :class="preview.impactedSpreads.length ? 'bad' : 'good'">{{ preview.impactedSpreads.length }} 组</strong>
                <div class="chips">
                  <Tag v-for="s in preview.impactedSpreads" :key="s.id" :value="s.id" severity="danger" />
                  <span v-if="!preview.impactedSpreads.length" class="muted">全部版位仍在新纸安全区内，保留不动</span>
                </div>
              </div>
              <div class="impact-row">
                <span>受影响导出分片</span>
                <strong :class="preview.impactedShards.length ? 'bad' : 'good'">{{ preview.impactedShards.length }} 片</strong>
                <div class="chips">
                  <Tag v-for="(row, i) in preview.impactedShards" :key="i" :value="`${row.task.id} / ${row.shard.name}`" severity="warn" />
                </div>
              </div>
              <div class="impact-row">
                <span>旧批次打样记录</span>
                <strong :class="preview.impactedProofs.length ? 'warn-text' : 'good'">{{ preview.impactedProofs.length }} 轮</strong>
                <div class="chips">
                  <span class="muted">换纸后标记"旧依据"，仍保留在审批链中供追溯，不会被删除或冒充新批次结论。</span>
                </div>
              </div>
            </div>

            <!-- 后到者只读清单 -->
            <div v-else-if="heldByOther && lockTargetsMe" class="impact blocked">
              <h4><i class="pi pi-eye" /> 先到者正在操作，以下为受影响只读清单</h4>
              <div class="blocked-list">
                <div v-for="p in blockedPositions" :key="p.id">
                  <Tag :value="p.id" severity="danger" />
                  <span>P{{ p.pageNo }} · x{{ p.x }}/y{{ p.y }} → 超出新纸安全区</span>
                </div>
                <div v-if="!blockedPositions.length" class="muted">该目标批次下暂无版位越界。</div>
              </div>
              <h4>将被拦截的导出分片</h4>
              <div class="blocked-list">
                <div v-for="(row, i) in blockedShards" :key="i">
                  <Tag :value="row.taskId" severity="warn" />
                  <span>{{ row.shardName }} · P{{ row.pages.join('/P') }}</span>
                </div>
                <div v-if="!blockedShards.length" class="muted">无在途分片受影响。</div>
              </div>
            </div>

            <div class="change-actions">
              <template v-if="!heldByMe">
                <Button label="先到者占用并开始确认" icon="pi pi-lock" :disabled="!candidate || heldByOther" @click="startChange" />
              </template>
              <template v-else>
                <Button label="确认换纸并冻结到新批次" icon="pi pi-check-circle" @click="confirmChange" />
                <Button label="取消，释放占用" icon="pi pi-times" severity="secondary" outlined @click="cancelChange" />
              </template>
            </div>
          </div>
        </section>

        <!-- 跨页组状态 -->
        <section class="panel">
          <div class="panel-head"><h3>跨页组与版位依据</h3><span class="muted">换纸后仅失效组重算，其他保留</span></div>
          <div class="spread-list">
            <article v-for="item in store.spreadStates" :key="item.spread.id">
              <div class="spread-head">
                <strong>{{ item.spread.id }} · {{ item.spread.label }}</strong>
                <Tag v-bind="statusTag(item.status)" />
              </div>
              <p>{{ item.spread.note }}</p>
              <div class="spread-pos">
                <Tag
                  v-for="p in store.positions.filter((pos) => item.spread.pageNos.includes(pos.pageNo))"
                  :key="p.id"
                  :value="`${p.id} P${p.pageNo} · ${store.batchCode(p.basisBatchId)}`"
                  :severity="p.status === 'confirmed' ? 'success' : p.status === 'pending' ? 'warn' : 'danger'"
                />
              </div>
              <div class="spread-actions">
                <Button
                  v-if="item.status === 'invalidated'"
                  label="失效重算（拉回安全区）"
                  icon="pi pi-refresh"
                  size="small"
                  severity="warning"
                  outlined
                  @click="store.recalcSpread(item.spread.id)"
                />
                <Button
                  v-if="item.status === 'pending'"
                  label="安全区/出血达标，确认版位"
                  icon="pi pi-check"
                  size="small"
                  severity="success"
                  outlined
                  @click="store.confirmSpread(item.spread.id)"
                />
                <span v-if="item.status === 'confirmed'" class="muted">依据 {{ store.batchCode(store.positions.find((p) => item.spread.pageNos.includes(p.pageNo))?.basisBatchId ?? '') }}，继续保留</span>
              </div>
            </article>
          </div>
        </section>
      </div>

      <aside>
        <!-- 新批次登记 -->
        <section class="panel">
          <div class="panel-head"><h3>登记新纸批次</h3><Tag value="夜班换卷" /></div>
          <div class="register-form">
            <label class="field">卷筒批号<InputText v-model="form.code" placeholder="如 CH-1004-B" /></label>
            <label class="field">供应商 / 来源<InputText v-model="form.supplier" placeholder="如 晨鸣铜版（夜班新卷）" /></label>
            <div class="num-row">
              <label class="field">纸宽 mm<InputNumber v-model="form.width" :min="300" :max="1200" showButtons buttonLayout="horizontal" /></label>
              <label class="field">纸高 mm<InputNumber v-model="form.height" :min="400" :max="1400" showButtons buttonLayout="horizontal" /></label>
              <label class="field">克重 g/㎡<InputNumber v-model="form.gsm" :min="60" :max="400" :step="1" showButtons buttonLayout="horizontal" /></label>
            </div>
            <Button label="登记并冻结规格" icon="pi pi-save" fluid :disabled="!form.code || !form.supplier" @click="register" />
            <Message v-if="justRegistered" severity="success" :closable="false" class="mt-2">已登记 {{ store.batches.find((b) => b.id === justRegistered)?.code }}，规格已冻结，登记后不可修改。</Message>
          </div>
        </section>

        <!-- 批次台账 -->
        <section class="panel">
          <div class="panel-head"><h3>批次台账</h3><Tag :value="`${store.batches.length} 卷`" /></div>
          <div class="registry">
            <div v-for="batch in [...store.batches].reverse()" :key="batch.id" :class="{ active: batch.id === store.activeBatchId }">
              <div><strong>{{ batch.code }}</strong><small>{{ batch.id }}</small></div>
              <span>{{ batch.width }}×{{ batch.height }}mm · {{ batch.gsm }}g</span>
              <Tag v-if="batch.id === store.activeBatchId" value="在用" severity="success" />
            </div>
          </div>
        </section>

        <!-- 换纸记录 -->
        <section class="panel">
          <div class="panel-head"><h3>换纸记录</h3></div>
          <div class="history">
            <div v-for="(entry, i) in store.changeLog" :key="i">
              <strong>{{ entry.at }} · {{ entry.operator }}</strong>
              <p>{{ store.batchCode(entry.fromBatchId) }} → {{ store.batchCode(entry.toBatchId) }}</p>
              <small>失效重算：{{ entry.invalidatedSpreads.length ? entry.invalidatedSpreads.join('、') : '无（其余版位保留）' }}</small>
            </div>
            <div v-if="!store.changeLog.length" class="muted">本班次尚未确认换纸。</div>
          </div>
        </section>
      </aside>
    </div>
  </section>
</template>

<style scoped>
.mb-3 { margin-bottom: 12px; }
.mt-2 { margin-top: 10px; }
.operator { display: grid; gap: 6px; min-width: 200px; font-size: 11px; color: #5f7076; font-weight: 700; }
.paper-grid { display: grid; grid-template-columns: minmax(0,1fr) 340px; gap: 14px; align-items: start; }
.main-col { display: grid; gap: 14px; }
aside { display: grid; gap: 14px; }
.batch-card { display: grid; grid-template-columns: 130px 1fr; gap: 18px; padding: 18px; align-items: center; }
.batch-code { display: grid; place-items: center; width: 120px; height: 120px; border-radius: 10px; color: #f3c394; background: linear-gradient(145deg,#173a4a,#306a6d); font-size: 15px; font-weight: 800; text-align: center; }
.batch-dims strong { display: block; font-size: 26px; color: #26373d; }
.batch-dims span { color: #6c7a81; font-size: 12px; }
.batch-card dl { grid-column: 1 / -1; display: grid; grid-template-columns: repeat(4,1fr); gap: 10px; margin: 0; padding-top: 14px; border-top: 1px solid #edf1f1; }
.batch-card dt { color: #93a0a5; font-size: 10px; }
.batch-card dd { margin: 4px 0 0; font-size: 12px; font-weight: 600; }
.note { padding: 0 18px 16px; margin: 0; color: #8a6a3f; font-size: 11px; }
.change-body { display: grid; gap: 14px; padding: 16px 18px 18px; }
.field { display: grid; gap: 6px; color: #5f7076; font-size: 11px; font-weight: 700; }
.dim-compare { display: flex; align-items: center; gap: 16px; }
.dim { display: grid; gap: 2px; padding: 12px 16px; border-radius: 8px; background: #f3f6f6; }
.dim.to.changed { background: #fff2e3; box-shadow: inset 3px 0 #d5904d; }
.dim small { color: #8a969b; font-size: 10px; }
.dim strong { font-size: 18px; }
.dim span { font-size: 11px; color: #6c7a81; }
.dim-compare > i { color: #90a0a5; }
.impact { display: grid; gap: 10px; padding: 14px; border: 1px solid #e6ecec; border-radius: 8px; background: #fafbfb; }
.impact.blocked { border-color: #e8c39b; background: #fffaf2; }
.impact h4 { margin: 0; font-size: 12px; }
.impact-row { display: grid; grid-template-columns: 150px 70px 1fr; align-items: center; gap: 10px; font-size: 11px; }
.impact-row > span { color: #5f7076; }
.impact-row strong.bad { color: #b84e35; }
.impact-row strong.good { color: #3b8a67; }
.impact-row strong.warn-text { color: #bf7f2c; }
.chips { display: flex; flex-wrap: wrap; gap: 5px; }
.change-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.blocked-list { display: grid; gap: 7px; font-size: 11px; }
.blocked-list > div { display: flex; align-items: center; gap: 8px; }
.spread-list { padding: 8px 16px 16px; }
.spread-list article { padding: 13px 0; border-bottom: 1px solid #edf1f1; }
.spread-head { display: flex; align-items: center; justify-content: space-between; }
.spread-list p { margin: 5px 0 8px; color: #7a878e; font-size: 11px; }
.spread-pos { display: flex; flex-wrap: wrap; gap: 6px; }
.spread-actions { margin-top: 10px; display: flex; align-items: center; gap: 8px; }
.register-form { display: grid; gap: 11px; padding: 14px 16px 16px; }
.num-row { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; }
.registry { padding: 8px 16px 16px; display: grid; gap: 8px; }
.registry > div { display: grid; grid-template-columns: 1fr auto auto; align-items: center; gap: 8px; padding: 9px 10px; border-radius: 7px; background: #f4f7f6; font-size: 11px; }
.registry > div.active { background: #e9f5ef; box-shadow: inset 3px 0 #3b8a67; }
.registry strong, .registry small { display: block; }
.registry small { color: #8a969b; font-size: 9px; }
.registry span { color: #5f7076; }
.history { padding: 8px 16px 16px; display: grid; gap: 12px; }
.history > div { padding-bottom: 10px; border-bottom: 1px solid #edf1f1; }
.history strong { font-size: 11px; }
.history p { margin: 4px 0; font-size: 11px; }
.history small { color: #8a969b; font-size: 10px; }
@media (max-width: 1050px) { .paper-grid { grid-template-columns: 1fr; } .batch-card dl { grid-template-columns: 1fr 1fr; } }
</style>
