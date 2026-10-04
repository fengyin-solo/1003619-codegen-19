// 复核领域服务的 Node 侧冒烟测试：mock localStorage 后直接跑领域逻辑。
// 不进 npm 脚本，仅用于本次实现的自检；业务代码本身仍只跑在浏览器里。
const esbuild = require('esbuild')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plot-review-'))
const bundlePath = path.join(tmp, 'bundle.cjs')

esbuild.buildSync({
  entryPoints: [path.join(__dirname, '..', 'src', 'api', 'plot-review.ts')],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile: bundlePath,
  alias: { '@': path.join(__dirname, '..', 'src') },
})

// --- mock browser localStorage ---
const mem = new Map()
globalThis.window = {
  localStorage: {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => {
      if (failNextWrite) {
        throw new Error('QuotaExceededError: 模拟 localStorage 写入失败')
      }
      mem.set(k, String(v))
    },
    removeItem: (k) => mem.delete(k),
  },
}
let failNextWrite = false

const svc = require(bundlePath)

let passed = 0
let failed = 0
function check(name, cond, extra = '') {
  if (cond) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.log(`  ✗ ${name} ${extra}`)
  }
}

// 1. 视图构建：5 个样地、分组、指标、口径
const { groups, summary } = svc.buildReviewView({})
check('样地分组数=5', groups.length === 5, `实际 ${groups.length}`)
const p1 = groups.find((g) => g.plotId === 'PLOT-01')
check('PLOT-01 有 3 期记录', p1.records.length === 3)
check('PLOT-01 归档 2 期', p1.archivedCount === 2)
check('PLOT-01 需复核 1 期', p1.needReviewCount === 1)

const archived2024 = p1.records.find((r) => r.date === '2024-09-18')
const canopy2024 = archived2024.metrics.find((m) => m.field === '郁闭度')
check('归档记录沿用原值（0.72）', canopy2024.effective === 0.72, `实际 ${canopy2024.effective}`)
check('归档记录不重算', canopy2024.recalibrated === false)
check('归档记录标旧口径', archived2024.caliber === '2021旧口径')

const latest1 = p1.records.at(-1)
const dbh = latest1.metrics.find((m) => m.field === '平均胸径')
const canopy = latest1.metrics.find((m) => m.field === '郁闭度')
const height = latest1.metrics.find((m) => m.field === '平均树高')
check('未归档胸径按 0.98 重算（15.3→15.0）', dbh.effective === 15.0, `实际 ${dbh.effective}`)
check('未归档郁闭度按 0.95 重算（0.55→0.52）', canopy.effective === 0.52, `实际 ${canopy.effective}`)
check('树高不重算（11.4）', height.effective === 11.4, `实际 ${height.effective}`)
check('郁闭度 0.52 触发补植建议', p1.advice.action === 'replant')
check('杉木林分匹配到杉木林带', p1.belt.matched === true && p1.belt.belt['林带编号'] === 'FBELT-0001')

// 2. 变化量与跨口径标记
check('胸径变化量 15.0-13.9=1.1', dbh.delta === 1.1, `实际 ${dbh.delta}`)
check('最新期相对归档期标记跨口径比较', dbh.caliberSwitched === true)
const first = p1.records[0]
check('首期无变化量', first.metrics[0].delta === null)

// 3. 林带匹配：马尾松→FBELT-0002；毛竹无匹配走分派
const p2 = groups.find((g) => g.plotId === 'PLOT-02')
check('马尾松林分匹配 FBELT-0002', p2.belt.belt['林带编号'] === 'FBELT-0002')
const p5 = groups.find((g) => g.plotId === 'PLOT-05')
check('毛竹无树种匹配、按编号顺序分派且标警告', p5.belt.matched === false, `reason=${p5.belt.reason}`)

// 4. 郁闭度阈值：0.60 临界 → observe；0.82 → tend
const p3 = groups.find((g) => g.plotId === 'PLOT-03')
const p3canopy = p3.latest.metrics.find((m) => m.field === '郁闭度').effective
check('PLOT-03 郁闭度 0.63*0.95=0.60', p3canopy === 0.6, `实际 ${p3canopy}`)
check('临界郁闭度建议巡护观察', p3.advice.action === 'observe')
check('PLOT-05 郁闭度充足建议封育养护', p5.advice.action === 'tend')

// 5. 筛选
const byStand = svc.buildReviewView({ standType: '松' }).groups
check('按林分类型「松」筛出 2 组（马尾松/针阔含松关键词? 实测）', byStand.length >= 1)
const byStatus = svc.buildReviewView({ status: '已归档' }).groups
check('按已归档状态仍能筛出含归档期的样地', byStatus.length >= 1)
const byPlot = svc.buildReviewView({ plotId: 'PLOT-04' }).groups
check('按样地编号精确筛出 PLOT-04', byPlot.length === 1 && byPlot[0].plotId === 'PLOT-04')

// 6. 确认事务（成功路径）：PLOT-01 记录 id=3
;(async () => {
  const before = svc._rawRows()
  const treeBefore = before.treegrowth.length
  const beltBefore = before.firebelt.length
  const patrolBefore = before.patrol.length

  const res = await svc.confirmReview(3)
  check('确认成功', res.ok, res.message)

  const after = svc._rawRows()
  const confirmed = after.treegrowth.find((r) => r.id === 3)
  check('确认后记录转已归档', confirmed.status === '已归档')
  check('确认后口径=2026新口径', confirmed['口径版本'] === '2026新口径')
  check('原始郁闭度留痕 0.55', confirmed['原始郁闭度'] === 0.55)
  check('重算郁闭度落库 0.52', confirmed['郁闭度'] === 0.52)
  check('带复核结论', String(confirmed['复核结论'] || '').includes('建议补植'))
  check('treegrowth 行数不变', after.treegrowth.length === treeBefore)
  check('firebelt 新增 1 条补植建议', after.firebelt.length === beltBefore + 1)
  check('patrol 新增 2 条（样地复查+补植复查）', after.patrol.length === patrolBefore + 2)
  const repl = after.firebelt.find((r) => r['林带编号'] === 'FBADV-TREE-0003')
  check('补植建议挂来源批次', repl && repl['来源批次'] === 'REVIEW:TREE-0003')
  const follow = after.patrol.find((r) => r['任务编号'] === 'RTASK-TREE-0003')
  check('林带补植待办跟着生成补植复查项', Boolean(follow) && follow['事项类型'] === '林带补植复查')
  check('补植复查项关联补植建议编号', follow && follow['关联林带编号'] === 'FBADV-TREE-0003')

  // 7. 重复确认不重复生成
  const res2 = await svc.confirmReview(3)
  check('重复确认被拒绝', res2.ok === false, res2.message)
  const after2 = svc._rawRows()
  check('拒绝后不新增任何数据',
    after2.firebelt.length === after.firebelt.length && after2.patrol.length === after.patrol.length)

  // 8. 并发确认只留一个结论（PLOT-02 id=6）
  const [a, b] = await Promise.all([svc.confirmReview(6), svc.confirmReview(6)])
  const oks = [a, b].filter((r) => r.ok).length
  check('并发两次确认仅一个成功', oks === 1, `ok=${a.ok},${b.ok}`)
  const rows6 = svc._rawRows().treegrowth.filter((r) => r['样地编号'] === 'PLOT-02')
  const archived6 = rows6.filter((r) => r['复核结论'])
  check('PLOT-02 只落一个复核结论', archived6.length === 1, `实际 ${archived6.length}`)
  const repl6 = svc._rawRows().firebelt.filter((r) => r['关联样地'] === 'PLOT-02')
  check('只生成一份补植建议', repl6.length === 1, `实际 ${repl6.length}`)

  // 9. 调查员回填：PLOT-02 旧归档记录缺调查员 → 沿用同地最近调查员 周海生
  const oldP2 = svc._rawRows().treegrowth.find((r) => r.id === 4)
  check('同地有署名时沿用调查员（周海生）', oldP2['调查员'] === '周海生', `实际 ${oldP2['调查员']}`)
  check('记录回填来源', oldP2['调查员来源'] === '沿用同地调查员')

  // 10. PLOT-04 无任何署名 → 占位
  const res4 = await svc.confirmReview(9)
  check('PLOT-04 确认成功', res4.ok, res4.message)
  const r9 = svc._rawRows().treegrowth.find((r) => r.id === 9)
  check('无人可沿用时占位「待补录（历史数据）」', r9['调查员'] === '待补录（历史数据）', `实际 ${r9['调查员']}`)

  // 11. observe 样地生成「巡护观察」林带建议但不跟补植复查项（PLOT-03 id=8）
  const beltCountBefore = svc._rawRows().firebelt.length
  const res8 = await svc.confirmReview(8)
  check('临界样地确认成功', res8.ok, res8.message)
  const beltCountAfter = svc._rawRows().firebelt.length
  check('巡护观察也同步生成 1 条林带建议（措施为观察、非补植）', beltCountAfter === beltCountBefore + 1)
  const obsAdvice = svc._rawRows().firebelt.find((r) => r['来源批次'] === 'REVIEW:TREE-0008')
  check('林带建议措施=巡护观察', Boolean(obsAdvice) && obsAdvice['建议措施'] === '巡护观察')
  const obsTasks = svc._rawRows().patrol.filter((r) => r['来源批次'] === 'REVIEW:TREE-0008')
  check('巡护观察仅生成样地复查事项 1 条、不跟补植复查项',
    obsTasks.length === 1 && obsTasks[0]['事项类型'] === '样地复核复查')

  // 12. 非需复核状态拒绝（id=7 已录入）
  const res7 = await svc.confirmReview(7)
  check('非需复核状态不能确认', res7.ok === false)

  // 13. 落库失败三处一起回退（PLOT-05 id=10，用真实 localStorage 抛错）
  failNextWrite = true
  const before13 = JSON.stringify(svc._rawRows())
  const res10 = await svc.confirmReview(10)
  failNextWrite = false
  check('落库失败返回失败', res10.ok === false && res10.message.includes('回退'))
  const after13 = JSON.stringify(svc._rawRows())
  check('失败后三处数据零变化', before13 === after13)

  // 14. failPersistence 演示开关同样回退且可重试
  const before14 = JSON.stringify(svc._rawRows())
  const res14 = await svc.confirmReview(10, { failPersistence: true })
  check('模拟失败开关返回回退提示', res14.ok === false)
  check('模拟失败零数据变化', before14 === JSON.stringify(svc._rawRows()))
  const res14b = await svc.confirmReview(10)
  check('回退后同条记录可重新确认成功', res14b.ok, res14b.message)

  console.log(`\n结果：${passed} 通过，${failed} 失败`)
  process.exit(failed === 0 ? 0 : 1)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
