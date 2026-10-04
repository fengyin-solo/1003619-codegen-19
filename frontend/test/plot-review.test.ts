// 临时验证脚本：esbuild 打包后在 node 里跑，验证样地复核服务的关键行为。
import assert from 'node:assert'

const store = new Map<string, string>()
let failWrites = false
;(globalThis as Record<string, unknown>).window = {
  localStorage: {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => {
      if (failWrites) throw new Error('QuotaExceededError')
      store.set(key, value)
    },
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
  },
}

const { buildPlotReview, confirmPlotReview } = await import('../src/api/plot-review')
const { runAction } = await import('../src/api/local-service')
const { listRows } = await import('../src/data/local-store')

// 1. 复核视图：口径重算 + 调查员回填
const review = buildPlotReview({}, '值班管理员')
assert.equal(review.length, 3, '应聚合出 3 个样地')
const p1 = review.find((r) => r.样地编号 === 'PLOT-01')!
const p2 = review.find((r) => r.样地编号 === 'PLOT-02')!
const p3 = review.find((r) => r.样地编号 === 'PLOT-03')!
assert.equal(p1.已归档数, 1)
assert.equal(p1.需复核数, 1)
// PLOT-01：归档记录 0.72 保留原值，未归档 0.61*0.95≈0.58 → 变化 -0.14
assert.equal(p1.最新郁闭度, 0.58)
assert.equal(p1.郁闭度变化, -0.14)
assert.equal(p1.复核结论, '郁闭度偏低，建议补植防火林带')
// PLOT-02：0.80(归档) → 0.83*0.95≈0.79，变化 -0.01，数据稳定
assert.equal(p2.郁闭度变化, -0.01)
assert.equal(p2.复核结论, '数据稳定，无需处置')
// PLOT-03：最新郁闭度 0.47 < 0.5 → 补植
assert.equal(p3.复核结论, '郁闭度偏低，建议补植防火林带')
// 回填：PLOT-02 缺调查员的记录回填同样地王测；PLOT-03 整组缺失回填值班人
const growth = listRows('treegrowth')
assert.equal(growth.find((r) => r['记录编号'] === 'TREE-0005')!['调查员'], '王测')
assert.equal(growth.find((r) => r['记录编号'] === 'TREE-0007')!['调查员'], '值班管理员')
assert.equal(growth.find((r) => r['记录编号'] === 'TREE-0008')!['调查员回填'], '是')
console.log('✓ 口径重算与调查员回填')

// 2. 确认：生成补植建议 + 复查事项，且沿既有数据流定位到 FIRE-0001
const first = confirmPlotReview(undefined, '值班管理员')
assert.ok(first.ok, first.message)
assert.equal(first.confirmed, 3)
assert.equal(first.firebeltTodos, 2, 'PLOT-01/PLOT-03 各生成一条补植建议')
assert.equal(first.patrolItems, 2)
const belts = listRows('firebelt')
const todo1 = belts.find((r) => r['来源样地'] === 'PLOT-01')!
const todo3 = belts.find((r) => r['来源样地'] === 'PLOT-03')!
assert.equal(todo1['关联林带编号'], 'FIRE-0001', 'PLOT-01 应定位到既有林带 FIRE-0001')
assert.equal(todo3['关联林带编号'], '新划林带')
assert.equal(todo1.status, '需补植')
const patrols = listRows('patrol')
assert.ok(patrols.some((r) => r['关联林带编号'] === todo1['林带编号'] && r.status === '待执行'))
assert.ok(growthStamped(), '结论应落在林木生长记录上')
function growthStamped() {
  return listRows('treegrowth').every((r) => typeof r['复核版本'] === 'string')
}
console.log('✓ 确认生成补植建议与巡护复查事项')

// 3. 重复确认：数据未变化，不重复生成
const again = confirmPlotReview(undefined, '值班管理员')
assert.ok(again.ok)
assert.equal(again.confirmed, 0)
assert.equal(again.skipped, 3)
assert.equal(listRows('firebelt').length, belts.length)
assert.equal(listRows('patrol').length, patrols.length)
console.log('✓ 重复确认不重复生成')

// 4. 数据变化后再次确认：只给变化的样地下新结论，已有待办不重复开
assert.ok(runAction('treegrowth', 2, '要求复核').ok)
const second = confirmPlotReview(undefined, '值班管理员')
assert.ok(second.ok)
assert.equal(second.confirmed, 1, '只有 PLOT-01 数据变了')
assert.equal(second.firebeltTodos, 0, 'PLOT-01 已有未完成补植待办，不重复开')
assert.equal(second.patrolItems, 0, '该待办已有未完成复查事项，不重复跟')
assert.equal(listRows('firebelt').length, belts.length)
console.log('✓ 变化样地只留一个结论，待办不重复')

// 5. 落库失败：三处一起回退
assert.ok(runAction('treegrowth', 5, '提交审核').ok) // PLOT-02 版本变化
const before = {
  treegrowth: JSON.stringify(listRows('treegrowth')),
  firebelt: JSON.stringify(listRows('firebelt')),
  patrol: JSON.stringify(listRows('patrol')),
}
failWrites = true
const failed = confirmPlotReview(undefined, '值班管理员')
failWrites = false
assert.equal(failed.ok, false)
assert.match(failed.message, /一起回退/)
assert.equal(JSON.stringify(listRows('treegrowth')), before.treegrowth, '林木生长应回退')
assert.equal(JSON.stringify(listRows('firebelt')), before.firebelt, '防火林带应回退')
assert.equal(JSON.stringify(listRows('patrol')), before.patrol, '巡护任务应回退')
console.log('✓ 落库失败三处一起回退')

// 6. 回退后可正常重试
const retry = confirmPlotReview(undefined, '值班管理员')
assert.ok(retry.ok)
assert.equal(retry.confirmed, 1)
console.log('✓ 回退后重试成功')

console.log('\n全部通过')
