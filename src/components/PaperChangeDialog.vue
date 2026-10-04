<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import Dialog from 'primevue/dialog'
import Button from 'primevue/button'
import InputNumber from 'primevue/inputnumber'
import InputText from 'primevue/inputtext'
import Select from 'primevue/select'
import Tag from 'primevue/tag'
import Message from 'primevue/message'
import { useImpositionStore, CHANGE_LOCK_TTL, type Impact } from '../stores/imposition'

const store = useImpositionStore()

const form = ref({ width: 720, height: 1020, grammage: 157, grain: '纵向' as '纵向' | '横向' })
const registeredId = ref<string | null>(null)
const step = ref<'form' | 'confirm' | 'result'>('form')
const resultImpact = ref<Impact | null>(null)
const conflict = ref<{ by: string; at: number; impact: Impact } | null>(null)
const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | undefined

const grainOptions = ['纵向', '横向']

const visible = computed({
  get: () => store.paperDialogOpen,
  set: (value) => { if (!value) store.closePaperDialog() },
})

const registeredBatch = computed(() => store.paperBatches.find((batch) => batch.id === registeredId.value) ?? null)
const lockRemaining = computed(() => {
  if (!store.changeLock) return 0
  return Math.max(0, Math.round((CHANGE_LOCK_TTL - (now.value - store.changeLock.at)) / 1000))
})
const lockByMe = computed(() => store.changeLock?.by === store.operatorName)

watch(visible, (open) => {
  if (open) {
    step.value = 'form'
    resultImpact.value = null
    conflict.value = null
    registeredId.value = null
    form.value = { width: 720, height: 1020, grammage: 157, grain: '纵向' }
    window.clearInterval(timer)
    timer = setInterval(() => { now.value = Date.now() }, 1000)
  } else {
    window.clearInterval(timer)
  }
})

function register() {
  const batch = store.registerBatch({ ...form.value })
  registeredId.value = batch.id
  step.value = 'confirm'
}

function applyResult(r: { ok: true; impact: Impact } | { ok: false; conflict: true; lock: { by: string; at: number }; impact: Impact }) {
  if (r.ok) {
    conflict.value = null
    resultImpact.value = r.impact
    step.value = 'result'
  } else {
    conflict.value = { by: r.lock.by, at: r.lock.at, impact: r.impact }
  }
}

function confirm() {
  const r = store.confirmPaperChange(registeredId.value!, store.operatorName || '夜班操作员')
  applyResult(r)
}

/** 演示用：模拟另一名操作员同时确认换纸，触发先到者占用冲突 */
function simulateOtherOperator() {
  const r = store.confirmPaperChange(registeredId.value!, '夜班-小林')
  applyResult(r)
}

function release() {
  store.releaseChangeLock()
}

function close() {
  store.closePaperDialog()
}
</script>

<template>
  <Dialog v-model:visible="visible" header="换纸确认 · 纸张批次登记与冻结" modal :style="{ width: '640px', maxWidth: '94vw' }" :draggable="false">
    <!-- 第一步：登记新批次，规格登记后冻结 -->
    <template v-if="step === 'form'">
      <Message severity="info" :closable="false" class="mb-3">新批次登记后纸宽、纸高和克重立即冻结，不可再修改；确认换纸后受影响的跨页组失效重算，其他版位保留。</Message>
      <div class="form-grid">
        <label>纸宽 (mm)<InputNumber v-model="form.width" :min="300" :max="1500" :step="1" /></label>
        <label>纸高 (mm)<InputNumber v-model="form.height" :min="300" :max="1500" :step="1" /></label>
        <label>克重 (g/m²)<InputNumber v-model="form.grammage" :min="60" :max="400" :step="1" /></label>
        <label>纸纹方向
          <Select v-model="form.grain" :options="grainOptions" />
        </label>
      </div>
      <div class="form-foot">
        <Button label="取消" text @click="close" />
        <Button label="登记并冻结规格" icon="pi pi-lock" @click="register" />
      </div>
    </template>

    <!-- 第二步：确认换纸（先到者占用） -->
    <template v-else-if="step === 'confirm' && registeredBatch">
      <div class="frozen-card">
        <div class="frozen-head">
          <strong>{{ registeredBatch.id }}</strong>
          <Tag value="规格已冻结" severity="info" icon="pi pi-lock" />
        </div>
        <div class="frozen-specs">
          <span>纸宽 <b>{{ registeredBatch.width }}</b> mm</span>
          <span>纸高 <b>{{ registeredBatch.height }}</b> mm</span>
          <span>克重 <b>{{ registeredBatch.grammage }}</b> g/m²</span>
          <span>纸纹 <b>{{ registeredBatch.grain }}</b></span>
        </div>
        <small>登记于 {{ registeredBatch.registeredAt }} · {{ registeredBatch.registeredBy }}</small>
      </div>

      <Message severity="warn" :closable="false" class="mb-3">
        确认换纸将立即占用换纸锁（先到者占用，有效期 {{ CHANGE_LOCK_TTL / 1000 }} 秒），并失效受影响跨页组。
      </Message>

      <label class="operator">操作员
        <InputText v-model="store.operatorName" placeholder="操作员姓名" />
      </label>

      <div v-if="conflict" class="conflict-box">
        <Message severity="error" :closable="false" class="mb-2">
          换纸已由 <b>{{ conflict.by }}</b> 占用，剩余 {{ lockRemaining }} 秒。后到者请先确认受影响的版位与分片，等待释放后再确认。
        </Message>
        <div class="impact">
          <div class="impact-block">
            <h4>受影响跨页组（{{ conflict.impact.affectedGroups.length }}）</h4>
            <div v-if="!conflict.impact.affectedGroups.length" class="empty-line">无跨页组失效，版位全部保留。</div>
            <div v-for="group in conflict.impact.affectedGroups" :key="group.groupId" class="impact-line">
              <Tag :value="group.groupId" severity="danger" />
              <span>P{{ group.pageNos.join('、P') }} · {{ group.positionIds.join('、') }}</span>
              <small v-for="(reason, index) in group.reasons" :key="index">{{ reason }}</small>
            </div>
          </div>
          <div class="impact-block">
            <h4>受影响导出分片（{{ conflict.impact.affectedFragments.length }}）</h4>
            <div v-if="!conflict.impact.affectedFragments.length" class="empty-line">无待重算分片。</div>
            <div v-for="(fragment, index) in conflict.impact.affectedFragments" :key="`${fragment.taskId}-${fragment.fragmentId}-${index}`" class="impact-line">
              <Tag :value="fragment.fragmentId" severity="warn" />
              <span>{{ fragment.taskName }} · {{ fragment.label }}</span>
              <small>{{ fragment.reason }}</small>
            </div>
          </div>
          <div class="impact-block">
            <h4>依据一致可复用分片（{{ conflict.impact.reusedFragments.length }}）</h4>
            <div v-if="!conflict.impact.reusedFragments.length" class="empty-line">无（新批次规格或克重不同）。</div>
            <div v-for="(fragment, index) in conflict.impact.reusedFragments" :key="`reuse-${index}`" class="impact-line">
              <Tag :value="fragment.fragmentId" severity="success" />
              <span>{{ fragment.taskName }} · {{ fragment.label }}</span>
            </div>
          </div>
        </div>
      </div>

      <div class="form-foot">
        <Button label="取消" text @click="close" />
        <Button v-if="conflict && lockByMe" label="释放占用" icon="pi pi-unlock" severity="warn" outlined @click="release" />
        <Button label="模拟另一操作员同时确认" icon="pi pi-users" severity="secondary" outlined @click="simulateOtherOperator" />
        <Button label="确认换纸" icon="pi pi-check" @click="confirm" />
      </div>
    </template>

    <!-- 第三步：换纸结果 -->
    <template v-else-if="step === 'result' && resultImpact && registeredBatch">
      <Message severity="success" :closable="false" class="mb-3">
        换纸完成：当前批次已切换为 <b>{{ registeredBatch.id }}</b>（{{ registeredBatch.width }} × {{ registeredBatch.height }}mm · {{ registeredBatch.grammage }}g/m²，规格冻结）。
      </Message>
      <div class="result-grid">
        <div class="result-card"><strong>{{ resultImpact.affectedGroups.length }}</strong><span>失效跨页组</span></div>
        <div class="result-card"><strong>{{ resultImpact.affectedGroups.reduce((sum, group) => sum + group.positionIds.length, 0) }}</strong><span>待重算版位</span></div>
        <div class="result-card"><strong>{{ resultImpact.keptPositionIds.length }}</strong><span>保留版位</span></div>
        <div class="result-card"><strong>{{ resultImpact.affectedFragments.length }}</strong><span>待重算分片</span></div>
        <div class="result-card"><strong>{{ resultImpact.reusedFragments.length }}</strong><span>复用分片</span></div>
        <div class="result-card"><strong>{{ resultImpact.staleProofIds.length }}</strong><span>待复核打样</span></div>
      </div>

      <div v-if="resultImpact.affectedGroups.length" class="impact-block">
        <h4>失效跨页组（版位待重算，其余版位保留）</h4>
        <div v-for="group in resultImpact.affectedGroups" :key="group.groupId" class="impact-line">
          <Tag :value="group.groupId" severity="danger" />
          <span>P{{ group.pageNos.join('、P') }} · {{ group.positionIds.join('、') }}</span>
          <small v-for="(reason, index) in group.reasons" :key="index">{{ reason }}</small>
        </div>
      </div>
      <div v-if="resultImpact.affectedFragments.length" class="impact-block">
        <h4>待重算分片（续传时从最后确认分片继续）</h4>
        <div v-for="(fragment, index) in resultImpact.affectedFragments" :key="`${fragment.taskId}-${fragment.fragmentId}-${index}`" class="impact-line">
          <Tag :value="fragment.fragmentId" severity="warn" />
          <span>{{ fragment.taskName }} · {{ fragment.label }}</span>
          <small>{{ fragment.reason }}</small>
        </div>
      </div>
      <div v-if="resultImpact.staleProofIds.length" class="impact-block">
        <h4>待复核打样（依据旧批次，结论需重新确认）</h4>
        <div class="impact-line">
          <Tag v-for="proofId in resultImpact.staleProofIds" :key="proofId" :value="proofId" severity="warn" />
        </div>
      </div>

      <div class="form-foot">
        <Button label="完成" icon="pi pi-check" @click="close" />
      </div>
    </template>
  </Dialog>
</template>

<style scoped>
.form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin: 4px 0 18px; }
.form-grid label { display: grid; gap: 6px; color: #5e6e75; font-size: 12px; font-weight: 700; }
.form-foot { display: flex; justify-content: flex-end; gap: 8px; flex-wrap: wrap; }
.mb-3 { margin-bottom: 12px; }
.operator { display: grid; gap: 6px; margin: 4px 0 16px; color: #5e6e75; font-size: 12px; font-weight: 700; }
.frozen-card { margin-bottom: 14px; padding: 14px; border: 1px solid #cdd9d7; border-radius: 8px; background: #f4f8f7; }
.frozen-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
.frozen-head strong { font-size: 14px; }
.frozen-specs { display: flex; flex-wrap: wrap; gap: 14px; font-size: 12px; color: #5d7077; }
.frozen-specs b { color: #2f464d; font-size: 14px; }
.frozen-card small { display: block; margin-top: 8px; color: #8a979b; font-size: 10px; }
.conflict-box { margin-bottom: 14px; }
.impact { display: grid; gap: 10px; }
.impact-block { padding: 10px 12px; border: 1px solid #e2e9e9; border-radius: 8px; background: #fafcfc; }
.impact-block h4 { margin: 0 0 8px; color: #45676d; font-size: 12px; }
.impact-line { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 6px 0; border-bottom: 1px dashed #e6ecec; font-size: 12px; }
.impact-line:last-child { border-bottom: 0; }
.impact-line span { color: #3d5258; }
.impact-line small { width: 100%; color: #b06a3a; font-size: 10px; }
.empty-line { color: #9aa8ac; font-size: 11px; }
.result-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-bottom: 14px; }
.result-card { display: grid; gap: 2px; padding: 12px; border-radius: 8px; background: #eef4f4; text-align: center; }
.result-card strong { color: #2f6f5e; font-size: 20px; }
.result-card span { color: #6a7c82; font-size: 11px; }
</style>
