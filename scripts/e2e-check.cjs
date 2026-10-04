// 端到端逻辑验证：用 esbuild 打包真实 store（vue/pinia/localStorage 用最小桩），
// 跑通 登记→占用→预览→确认换纸→失效重算→确认→导出恢复/复用/待复核 全流程。
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
globalThis.window = {
  localStorage: storageStub,
  setInterval: () => 0,
  clearInterval: () => {},
  addEventListener: () => {},
}
class BroadcastChannelStub {
  postMessage() {}
  close() {}
}
globalThis.BroadcastChannel = BroadcastChannelStub

const plugin = {
  name: 'stub',
  setup(build) {
    build.onResolve({ filter: /^vue$/ }, () => ({ path: 'vue', namespace: 'stub' }))
    build.onResolve({ filter: /^pinia$/ }, () => ({ path: 'pinia', namespace: 'stub' }))
    build.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => {
      if (args.path === 'vue') {
        return {
          contents: `
            export const ref = (v) => ({ value: v })
            export const computed = (fn) => ({ get value() { return fn() } })
            export const watch = () => {}
          `,
          loader: 'js',
        }
      }
      return {
        contents: `
          export const defineStore = (_id, setup) => () => {
            if (!globalThis.__store) globalThis.__store = setup()
            return globalThis.__store
          }
        `,
        loader: 'js',
      }
    })
  },
}

async function loadStore() {
  const result = await esbuild.build({
    entryPoints: [path.join(__dirname, '../src/stores/imposition.ts')],
    bundle: true,
    format: 'cjs',
    write: false,
    plugins: [plugin],
  })
  const mod = { exports: {} }
  new Function('module', 'exports', 'require', result.outputFiles[0].text)(mod, mod.exports, require)
  return mod.exports.useImpositionStore()
}

// 桩里 ref/computed 都是 { value } 包装，用 Proxy 自动解包，函数保持 this 绑定
function view(raw) {
  return new Proxy(raw, {
    get(target, key) {
      const v = target[key]
      return typeof v === 'function' ? v.bind(target) : v && typeof v === 'object' && 'value' in v ? v.value : v
    },
    set(target, key, value) {
      if (key in target && target[key] && typeof target[key] === 'object' && 'value' in target[key]) target[key].value = value
      else target[key] = value
      return true
    },
  })
}

async function main() {
  const store = view(await loadStore())
  const initial = store.activeBatch
  assert.strictEqual(initial.width, 720, '初始纸宽 720')
  assert.strictEqual(initial.height, 1020, '初始纸高 1020')
  assert.strictEqual(initial.gsm, 128, '初始克重 128')
  console.log('✓ 初始批次', initial.code, `${initial.width}×${initial.height}/${initial.gsm}g`)

  // 1. 登记新批次后冻结
  const before = store.batches.length
  const nb = store.registerPaperBatch({ code: 'CH-TEST-X', supplier: '测试纸厂', width: 710, height: 950, gsm: 157 })
  assert.strictEqual(store.batches.length, before + 1)
  assert.ok(nb.registeredAt && nb.registeredBy, '登记留痕')
  console.log('✓ 新批次登记即冻结', nb.id, `${nb.width}×${nb.height}/${nb.gsm}g`)

  // 2. 初始跨页组：SP-1/SP-3/SP-4 已确认，SP-2 因 P7 出血不足待确认
  const s0 = Object.fromEntries(store.spreadStates.map((x) => [x.spread.id, x.status]))
  assert.strictEqual(s0['SP-1'], 'confirmed')
  assert.strictEqual(s0['SP-2'], 'pending', 'P7 出血不足应为待确认而非失效')
  assert.strictEqual(s0['SP-3'], 'confirmed')
  assert.strictEqual(s0['SP-4'], 'confirmed')
  console.log('✓ 初始跨页组状态', JSON.stringify(s0))

  // 3. 先到者占用（store 操作者 = 林青）
  store.operator = '林青 / 拼版'
  const target = store.batches.find((b) => b.code === 'CH-1004-B')
  const r1 = store.acquirePaperLock(target.id)
  assert.strictEqual(r1.ok, true, '先到者占用成功')
  // 第二个人（独立标签/会话，直接走锁服务）
  const lockMod = await esbuild.build({
    entryPoints: [path.join(__dirname, '../src/lib/paperLock.ts')],
    bundle: true, format: 'cjs', write: false, plugins: [plugin],
  }).then((out) => {
    const m = { exports: {} }
    new Function('module', 'exports', 'require', out.outputFiles[0].text)(m, m.exports, require)
    return m.exports.paperLock
  })
  const r2 = lockMod.acquire('周默 / 色彩管理', target.id)
  assert.strictEqual(r2.ok, false, '后到者必须被拒绝')
  assert.strictEqual(r2.lock.owner, '林青 / 拼版')
  // 后到者在自己的会话里读到占用者是别人
  assert.strictEqual(lockMod.read()?.owner !== '周默 / 色彩管理', true)
  console.log('✓ 两人同时确认：先到者占用，后到者只读（看到占用者：林青 / 拼版）')

  // 4. 后到者看到受影响版位
  const blockedPositions = store.positions.filter((p) => !store.pageFits(p, target.id))
  const blockedPages = blockedPositions.map((p) => p.pageNo).sort((a, b) => a - b)
  assert.deepStrictEqual(blockedPages, [3, 4, 5, 6], '下排两组版位越界')
  console.log('✓ 后到者看到受影响版位 P' + blockedPages.join('/P'))

  // 5. 影响预览：仅 SP-3 / SP-4 失效，SP-1/SP-2 保留
  const preview = store.previewPaperChange(target.id)
  const ids = preview.impactedSpreads.map((s) => s.id).sort()
  assert.deepStrictEqual(ids, ['SP-3', 'SP-4'], '只有下排跨页组失效')
  assert.ok(preview.impactedShards.length >= 2, '分片 3/4 受影响')
  console.log('✓ 影响预览：失效', ids.join('、'), '；受影响分片', preview.impactedShards.map((x) => x.shard.name).join('、'))

  // 6. 确认换纸
  const activeBefore = store.activeBatchId
  store.confirmPaperChange(target.id)
  assert.strictEqual(store.activeBatchId, target.id, '在用批次切换')
  const s1 = Object.fromEntries(store.spreadStates.map((x) => [x.spread.id, x.status]))
  assert.strictEqual(s1['SP-1'], 'confirmed', '未越界版位保留确认')
  assert.strictEqual(s1['SP-2'], 'pending', '未越界但出血不足的组保持待确认')
  assert.strictEqual(s1['SP-3'], 'invalidated')
  assert.strictEqual(s1['SP-4'], 'invalidated')
  const staleP = store.positions.find((p) => p.pageNo === 4)
  assert.strictEqual(staleP.basisBatchId, activeBefore, '失效版位保留旧纸批号')
  const t1 = store.findTask('EXP-0925-01')
  assert.strictEqual(t1.status, '已中断')
  assert.strictEqual(t1.shards.find((s) => s.no === 4).lastError.includes('换纸中断'), true)
  console.log('✓ 确认换纸：SP-3/SP-4 失效重算，SP-1/SP-2 保留；在途任务中断到分片级')

  // 7. 失效重算（拉回安全区）→ 待确认 → 确认
  store.recalcSpread('SP-3')
  store.recalcSpread('SP-4')
  const allFit = store.positions.every((p) => store.pageFits(p))
  assert.ok(allFit, '重算后全部落回安全区')
  assert.strictEqual(store.spreadStatus(store.spreads.find((s) => s.id === 'SP-3')), 'pending')
  store.confirmSpread('SP-3')
  store.confirmSpread('SP-4')
  assert.strictEqual(store.spreadStatus(store.spreads.find((s) => s.id === 'SP-3')), 'confirmed')
  assert.strictEqual(store.spreadStatus(store.spreads.find((s) => s.id === 'SP-4')), 'confirmed')
  assert.strictEqual(store.canExport, true, '失效清零后允许新建导出')
  console.log('✓ 失效跨页组重算回安全区并重新确认；canExport 恢复')

  // 8. 旧任务缺依据 → 待复核
  const legacy = store.tasks.filter((t) => t.status === '待复核')
  assert.ok(legacy.length >= 2, '两个旧任务归待复核')
  console.log('✓ 旧任务缺纸批号/版位摘要 → 待复核，不续传:', legacy.map((t) => t.id).join('、'))

  // 9. 打样依据状态
  const oldProof = store.proofs[0]
  assert.strictEqual(store.proofBasisState(oldProof), '旧依据', '旧批次打样标记为旧依据')
  store.createProof()
  const newProof = store.proofs.at(-1)
  assert.strictEqual(newProof.paperBatchId, target.id, '新打样带新纸批号')
  assert.ok(newProof.positionDigest && newProof.positionDigest.length === 8, '新打样带版位摘要')
  console.log('✓ 打样轮次携带纸批号+版位摘要；旧轮次标“旧依据”保留')

  // 10. 占用锁释放
  store.releasePaperLock()
  assert.strictEqual(store.paperLockState, null, '确认后释放占用')
  console.log('✓ 换纸占用已释放')

  // 11. 换纸日志
  const entry = store.changeLog[0]
  assert.strictEqual(entry.toBatchId, target.id)
  assert.deepStrictEqual(entry.invalidatedSpreads.sort(), ['SP-3', 'SP-4'])
  console.log('✓ 换纸日志留痕：', entry.fromBatchId, '→', entry.toBatchId)

  console.log('\n全部断言通过 ✅')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
