// API 层验证：写盘失败回最后确认分片、依据一致复用/不一致重置、待复核拒续、缺依据自动转待复核、rebase。
const esbuild = require('esbuild')
const path = require('path')
const assert = require('assert')

const memory = new Map()
const storageStub = {
  getItem: (k) => (memory.has(k) ? memory.get(k) : null),
  setItem: (k, v) => memory.set(k, String(v)),
  removeItem: (k) => memory.delete(k),
}
globalThis.localStorage = storageStub
globalThis.window = { localStorage: storageStub, setInterval: () => 0, clearInterval: () => {}, addEventListener: () => {} }
class BroadcastChannelStub { postMessage() {} close() {} }
globalThis.BroadcastChannel = BroadcastChannelStub

const plugin = {
  name: 'stub',
  setup(build) {
    build.onResolve({ filter: /^vue$/ }, () => ({ path: 'vue', namespace: 'stub' }))
    build.onResolve({ filter: /^pinia$/ }, () => ({ path: 'pinia', namespace: 'stub' }))
    build.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => {
      if (args.path === 'vue') return { contents: `export const ref=(v)=>({value:v});export const computed=(fn)=>({get value(){return fn()}});export const watch=()=>{};`, loader: 'js' }
      return { contents: `export const defineStore=(_id,setup)=>()=>{if(!globalThis.__store)globalThis.__store=setup();return globalThis.__store};`, loader: 'js' }
    })
  },
}

async function bundle(entry, extra = {}) {
  const result = await esbuild.build({
    entryPoints: [path.join(__dirname, '..', entry)],
    bundle: true,
    format: 'cjs',
    write: false,
    external: ['axios'],
    plugins: [plugin],
    ...extra,
  })
  const mod = { exports: {} }
  new Function('module', 'exports', 'require', result.outputFiles[0].text)(mod, mod.exports, require)
  return mod.exports
}

async function main() {
  const storeMod = await bundle('src/stores/imposition.ts')
  const store = storeMod.useImpositionStore()
  const apiMod = await bundle('src/api/exportApi.ts')
  const exportApi = apiMod.exportApi

  const INITIAL = 'PB-20260910-01'
  const NEW = 'PB-20261004-01'

  function basis(batchId = INITIAL) {
    const shardDigests = {}
    ;[
      [1, [8, 1]],
      [2, [2, 7]],
      [3, [6, 3]],
      [4, [4, 5]],
    ].forEach(([no, pages]) => (shardDigests[no] = store.digestOfPages(pages)))
    return { paperBatchId: batchId, positionDigest: store.currentDigest.value, shardDigests }
  }

  // 0. 初始列表
  const list = (await exportApi.list()).data
  const t01 = list.find((t) => t.id === 'EXP-0925-01')
  assert.strictEqual(t01.status, '已中断')
  assert.strictEqual(t01.paperBatchId, INITIAL)
  assert.deepStrictEqual(t01.shards.map((s) => s.status), ['已确认', '已确认', '写入失败', '待写入'])
  assert.strictEqual(t01.shards[2].attempts, 3, '失败分片已尝试 3 次')
  console.log('✓ 初始任务：分片 1/2 已确认，分片 3 写盘失败（最后确认分片 = 分片 2）')

  // 1. 待复核任务拒绝续传
  await assert.rejects(
    () => exportApi.resume('EXP-0925-02', basis()),
    (err) => err.response.status === 409 && err.response.data.code === 'PENDING_REVIEW',
  )
  console.log('✓ 旧任务（缺纸批号/版位摘要）resume 被 409 拒绝，保持待复核不续传')

  // 2. 纸批次不一致拒绝续传
  await assert.rejects(
    () => exportApi.resume('EXP-0925-01', basis(NEW)),
    (err) => err.response.status === 409 && err.response.data.code === 'BATCH_MISMATCH',
  )
  console.log('✓ 当前纸批次与任务依据不一致 → BATCH_MISMATCH，要求先重建分片')

  // 3. 第一次恢复：分片 3 第 4 次尝试仍失败（偶数），回退到最后确认分片
  const r1 = (await exportApi.resume('EXP-0925-01', basis())).data
  assert.strictEqual(r1.task.status, '已中断')
  assert.strictEqual(r1.task.shards[2].status, '写入失败')
  assert.strictEqual(r1.task.shards[0].status, '已确认', '已确认分片不受影响')
  assert.strictEqual(r1.task.progress, 50)
  console.log('✓ 写盘再次失败：状态回到已中断，分片 1/2 保留，提示从最后确认分片重试')

  // 4. 第二次恢复：分片 3 成功
  const r2 = (await exportApi.resume('EXP-0925-01', basis())).data
  assert.strictEqual(r2.task.shards[2].status, '已确认')
  assert.strictEqual(r2.task.shards[2].confirmedBatchId, INITIAL)
  assert.strictEqual(r2.task.shards[3].status, '待写入')
  assert.strictEqual(r2.task.progress, 75)
  console.log('✓ 恢复成功：分片 3 写入并按当前依据确认，进度 75%')

  // 5. 第三次恢复：分片 4 成功 → 全部完成
  const r3 = (await exportApi.resume('EXP-0925-01', basis())).data
  assert.strictEqual(r3.task.status, '已完成')
  assert.strictEqual(r3.task.progress, 100)
  assert.ok(r3.task.shards.every((s) => s.status === '已确认'))
  console.log('✓ 分片 4 完成，交付包 100% 且全部分片纸批号/摘要一致')

  // 6. 已完成任务不可再恢复
  await assert.rejects(() => exportApi.resume('EXP-0925-01', basis()), (err) => err.response.data.code === 'NOT_RESUMABLE')
  console.log('✓ 已完成任务不可恢复')

  // 7. rebase：旧批次任务挂新依据时，已确认但批次不符的分片全部重置，未确认的也重置
  // 先再拉一份列表确认服务端持久化
  const list2 = (await exportApi.list()).data
  assert.strictEqual(list2.find((t) => t.id === 'EXP-0925-01').status, '已完成')
  const rebased = (await exportApi.rebase('EXP-0925-01', basis(NEW))).data
  assert.strictEqual(rebased.paperBatchId, NEW)
  assert.ok(rebased.shards.every((s) => s.status === '待写入'), '旧批次已确认分片不得跨批次复用')
  assert.strictEqual(rebased.progress, 0)
  console.log('✓ rebase 新纸批次：全部已确认分片按依据重置，杜绝跨批复用')

  // 8. 新依据下：摘要一致的已确认分片复用（模拟"改了别的组"场景）
  //    手工让分片 1/2 在新批次下确认，然后 digest 不变时 resume 必须复用
  const rebased2 = (await exportApi.rebase('EXP-0925-01', basis(NEW))).data
  assert.strictEqual(rebased2.shards[0].status, '待写入')
  await exportApi.resume('EXP-0925-01', basis(NEW)) // attempts 0→1 分片1成功
  await exportApi.resume('EXP-0925-01', basis(NEW)) // 分片2成功
  const mid = (await exportApi.list()).data.find((t) => t.id === 'EXP-0925-01')
  assert.strictEqual(mid.shards[0].status, '已确认')
  assert.strictEqual(mid.shards[1].status, '已确认')
  // 版位未动，再 resume：分片 1/2 摘要一致直接复用，只推进分片 3
  const r4 = (await exportApi.resume('EXP-0925-01', basis(NEW))).data
  assert.strictEqual(r4.task.shards[0].status, '已确认')
  assert.strictEqual(r4.task.shards[2].status, '已确认')
  console.log('✓ 已完成分片在新依据（同批次+同摘要）一致时复用，仅继续后续分片')

  // 9. 摘要变化：已确认分片重置为待写入，下一轮恢复时重写（本次只推进最靠前的待写入分片）
  const changedBasis = basis(NEW)
  changedBasis.shardDigests[1] = 'deadbeef' // 分片 1 版位变了
  const r5 = (await exportApi.resume('EXP-0925-01', changedBasis)).data
  assert.strictEqual(r5.task.shards[0].status, '待写入', '摘要不一致的分片必须重置，不得直接复用')
  assert.ok(r5.task.shards[0].lastError.includes('版位摘要变化'))
  assert.strictEqual(r5.task.shards[1].status, '已确认', '其余分片摘要一致仍复用')
  console.log('✓ 版位摘要变化只重置对应分片；本次恢复优先重写它，其他已完成分片继续复用')
  const r6 = (await exportApi.resume('EXP-0925-01', changedBasis)).data
  assert.strictEqual(r6.task.shards[0].status, '已确认', '下一轮恢复把重置分片按新依据重新写入')
  console.log('✓ 重置分片在下一轮恢复时按新依据重写确认')

  console.log('\nAPI 全部断言通过 ✅')
}

main().catch((err) => {
  console.error(err?.response?.data ?? err)
  process.exit(1)
})
