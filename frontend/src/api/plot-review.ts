import { allRows, commitAll, listRows } from '@/data/local-store'
import type { ActionResult, EntryRow } from '@/data/types'

// 样地复核领域服务：
// 沿着「林木生长（林分）→ 防火林带 → 巡护任务」的既有数据流，
// 在数据层完成新口径重算、调查员回填、林带补植建议与巡护复查事项的联动生成。
// 页面组件只渲染这里算出的视图，不做业务判断。

const TREE_KEY = 'treegrowth'
const BELT_KEY = 'firebelt'
const PATROL_KEY = 'patrol'

const ARCHIVED = '已归档'
const NEED_REVIEW = '需复核'
const NEW_CALIBER = '2026新口径'
const OLD_CALIBER = '2021旧口径'

// 2026 年调查口径调整：胸径起测径阶由 5cm 提到 6cm，郁闭度改仪器测定。
// 未归档样地按新口径重算；已归档历史记录沿用原数据，只做标注。
const DBH_FACTOR = 0.98 // 去掉 5cm 起测的小径阶样木后，林分平均胸径整体下移约 2%
const CANOPY_FACTOR = 0.95 // 仪器测定较目估校正约 5%
const HEIGHT_FACTOR = 1 // 树高量测方式未变，不重算

// 郁闭度阈值：低于 0.60 触发林带补植建议；0.60-0.70 安排巡护观察；0.70 以上以养护为主。
const REPLANT_CANOPY = 0.6
const OBSERVE_CANOPY = 0.7

const FALLBACK_INVESTIGATOR = '待补录（历史数据）'

// 林分类型 → 防火树种关键词，用于沿着树种组成把林分挂到既有防火林带上。
const STAND_KEYWORDS: Record<string, string[]> = {
  杉木纯林: ['杉木'],
  马尾松纯林: ['马尾松'],
  阔叶混交林: ['木荷', '火力楠', '青冈', '阔叶'],
  针阔混交林: ['木荷', '杉木', '马尾松', '火力楠', '青冈'],
  毛竹林: ['毛竹'],
}

type MetricField = '平均胸径' | '平均树高' | '郁闭度'

export type ReviewMetric = {
  field: MetricField
  label: string
  unit: string
  precision: number
  raw: number
  effective: number
  recalibrated: boolean
  factor: number
  prevEffective: number | null
  delta: number | null
  caliberSwitched: boolean
}

export type RecordReview = {
  row: EntryRow
  recordNo: string
  plotId: string
  standType: string
  date: string
  investigator: string
  investigatorMissing: boolean
  backfill: { investigator: string; source: string } | null
  caliber: string
  archived: boolean
  needReview: boolean
  confirmed: boolean
  conclusion: string
  metrics: ReviewMetric[]
}

export type BeltMatch = {
  belt: EntryRow | null
  matched: boolean
  reason: string
}

export type PlotGroup = {
  plotId: string
  standType: string
  belt: BeltMatch
  records: RecordReview[]
  latest: RecordReview
  needReviewCount: number
  archivedCount: number
  advice: BeltAdvice
  generated: GeneratedBatch | null
}

export type BeltAdvice = {
  canopy: number
  action: 'replant' | 'observe' | 'tend'
  label: string
  beltStatus: string
  reason: string
}

export type GeneratedBatch = {
  batchKey: string
  beltSuggestion: EntryRow | null
  patrolItems: EntryRow[]
}

export type ReviewFilters = {
  plotId?: string
  standType?: string
  status?: string
}

export type ConfirmOptions = {
  reviewer?: string
  // 演示/测试用：在落库前主动失败，验证三处改动一起回退。
  failPersistence?: boolean
}

function toNumber(value: unknown): number {
  const n = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''))
  return Number.isFinite(n) ? n : 0
}

function round(n: number, precision: number): number {
  const p = 10 ** precision
  return Math.round(n * p) / p
}

function isArchived(row: EntryRow): boolean {
  return String(row.status) === ARCHIVED || String(row['记录状态'] ?? '') === ARCHIVED
}

function effectiveCaliber(row: EntryRow): string {
  // 已归档沿用原口径；未归档记录的展示值已按新口径重算。
  if (isArchived(row)) {
    return String(row['口径版本'] ?? OLD_CALIBER)
  }
  return NEW_CALIBER
}

const METRIC_SPECS: { field: MetricField; label: string; unit: string; precision: number; factor: number }[] = [
  { field: '平均胸径', label: '平均胸径', unit: 'cm', precision: 1, factor: DBH_FACTOR },
  { field: '平均树高', label: '平均树高', unit: 'm', precision: 1, factor: HEIGHT_FACTOR },
  { field: '郁闭度', label: '郁闭度', unit: '', precision: 2, factor: CANOPY_FACTOR },
]

function metricOf(row: EntryRow, spec: (typeof METRIC_SPECS)[number], prev: RecordReview | null): ReviewMetric {
  const raw = round(toNumber(row[spec.field]), spec.precision)
  const archived = isArchived(row)
  // 已确认归档的新口径记录，字段本身就是新口径值；待复核的未归档记录在这里换算展示。
  const recalibrated = !archived && spec.factor !== 1
  const effective = archived
    ? raw
    : round(raw * spec.factor, spec.precision)
  const prevEffective = prev ? prev.metrics.find((m) => m.field === spec.field)!.effective : null
  const delta = prevEffective === null ? null : round(effective - prevEffective, spec.precision)
  const prevCaliber = prev ? prev.caliber : null
  return {
    field: spec.field,
    label: spec.label,
    unit: spec.unit,
    precision: spec.precision,
    raw,
    effective,
    recalibrated,
    factor: spec.factor,
    prevEffective,
    delta,
    caliberSwitched: prevCaliber !== null && prevCaliber !== effectiveCaliber(row),
  }
}

// 缺失调查员的旧记录回填方案（由本服务决定）：
// 优先沿用同一历史样地里最近一次有署名的调查员；整个样地都查不到人时，
// 用「待补录（历史数据）」占位，保证复核结论可落库，并在视图上标出来等线下补录。
export function planBackfill(plotId: string, rows: EntryRow[] = listRows(TREE_KEY)): {
  investigator: string
  source: string
} {
  const known = rows
    .filter((r) => String(r['样地编号'] ?? '') === plotId)
    .map((r) => String(r['调查员'] ?? '').trim())
    .filter((name) => name.length > 0)
  if (known.length > 0) {
    return { investigator: known[known.length - 1], source: '沿用同地调查员' }
  }
  return { investigator: FALLBACK_INVESTIGATOR, source: '历史占位待补录' }
}

export function matchBelt(standType: string, belts: EntryRow[] = listRows(BELT_KEY)): BeltMatch {
  const keywords = STAND_KEYWORDS[standType] ?? []
  const scored = belts.map((belt) => {
    const composition = String(belt['树种组成'] ?? '')
    const hit = keywords.filter((word) => composition.includes(word))
    return { belt, score: hit.length, hit }
  })
  const best = scored.reduce(
    (acc, item) => (item.score > acc.score ? item : acc),
    { belt: null as EntryRow | null, score: 0, hit: [] as string[] },
  )
  if (best.belt && best.score > 0) {
    return {
      belt: best.belt,
      matched: true,
      reason: `树种组成命中「${best.hit.join('、')}」`,
    }
  }
  // 匹配不到时挂到排序最前的林带，明确标注为分派，避免静默丢建议。
  const fallback = belts.slice().sort((a, b) => String(a['林带编号']).localeCompare(String(b['林带编号'])))[0] ?? null
  return {
    belt: fallback,
    matched: false,
    reason: `「${standType}」未匹配到对应防火树种林带，按编号顺序分派，请人工改派`,
  }
}

function adviceFor(canopy: number): BeltAdvice {
  if (canopy < REPLANT_CANOPY) {
    return {
      canopy,
      action: 'replant',
      label: '建议补植',
      beltStatus: '需补植',
      reason: `最新郁闭度 ${canopy.toFixed(2)} 低于 ${REPLANT_CANOPY.toFixed(2)}，林分阻隔能力不足`,
    }
  }
  if (canopy < OBSERVE_CANOPY) {
    return {
      canopy,
      action: 'observe',
      label: '巡护观察',
      beltStatus: '',
      reason: `最新郁闭度 ${canopy.toFixed(2)} 位于 ${REPLANT_CANOPY.toFixed(2)}–${OBSERVE_CANOPY.toFixed(2)} 临界区间，先复查再定补植`,
    }
  }
  return {
    canopy,
    action: 'tend',
    label: '封育养护',
    beltStatus: '完好',
    reason: `最新郁闭度 ${canopy.toFixed(2)} 不低于 ${OBSERVE_CANOPY.toFixed(2)}，以日常养护与封育为主`,
  }
}

function buildRecord(row: EntryRow, prev: RecordReview | null, allTreeRows: EntryRow[]): RecordReview {
  const plotId = String(row['样地编号'] ?? '')
  const investigator = String(row['调查员'] ?? '').trim()
  const missing = investigator.length === 0
  const metrics = METRIC_SPECS.map((spec) => metricOf(row, spec, prev))
  return {
    row,
    recordNo: String(row['记录编号'] ?? ''),
    plotId,
    standType: String(row['林分类型'] ?? ''),
    date: String(row['调查日期'] ?? ''),
    investigator,
    investigatorMissing: missing,
    backfill: missing ? planBackfill(plotId, allTreeRows) : null,
    caliber: effectiveCaliber(row),
    archived: isArchived(row),
    needReview: String(row.status) === NEED_REVIEW,
    confirmed: Boolean(row['复核结论']),
    conclusion: String(row['复核结论'] ?? ''),
    metrics,
  }
}

function findGenerated(batchKey: string): GeneratedBatch | null {
  const beltSuggestion =
    listRows(BELT_KEY).find((r) => String(r['来源批次'] ?? '') === batchKey) ?? null
  const patrolItems = listRows(PATROL_KEY).filter((r) => String(r['来源批次'] ?? '') === batchKey)
  if (!beltSuggestion && patrolItems.length === 0) {
    return null
  }
  return { batchKey, beltSuggestion, patrolItems }
}

export function buildReviewView(filters: ReviewFilters = {}): {
  groups: PlotGroup[]
  summary: { label: string; value: number }[]
} {
  const treeRows = listRows(TREE_KEY)
  const plotIds: string[] = []
  for (const row of treeRows) {
    const plotId = String(row['样地编号'] ?? '')
    if (!plotIds.includes(plotId)) {
      plotIds.push(plotId)
    }
  }

  const groups: PlotGroup[] = []
  for (const plotId of plotIds) {
    const sorted = treeRows
      .filter((r) => String(r['样地编号'] ?? '') === plotId)
      .sort((a, b) => String(a['调查日期'] ?? '').localeCompare(String(b['调查日期'] ?? '')))

    let prev: RecordReview | null = null
    const records: RecordReview[] = []
    for (const row of sorted) {
      const item = buildRecord(row, prev, treeRows)
      records.push(item)
      prev = item
    }

    const visible = records.filter((r) => {
      if (filters.status && String(r.row.status) !== filters.status) {
        return false
      }
      return true
    })
    if (visible.length === 0) {
      continue
    }
    const standType = records[0]?.standType ?? ''
    if (filters.standType && !standType.includes(filters.standType.trim())) {
      continue
    }
    if (filters.plotId && !plotId.includes(filters.plotId.trim())) {
      continue
    }

    const latest = records[records.length - 1]
    const canopy = latest.metrics.find((m) => m.field === '郁闭度')!.effective
    const batchKey = batchKeyOf(latest.recordNo)
    groups.push({
      plotId,
      standType,
      belt: matchBelt(standType),
      records,
      latest,
      needReviewCount: records.filter((r) => r.needReview).length,
      archivedCount: records.filter((r) => r.archived).length,
      advice: adviceFor(canopy),
      generated: findGenerated(batchKey),
    })
  }

  const summary = [
    { label: '样地数量', value: groups.length },
    { label: '需复核记录', value: groups.reduce((sum, g) => sum + g.needReviewCount, 0) },
    { label: '已归档记录', value: groups.reduce((sum, g) => sum + g.archivedCount, 0) },
    { label: '待生成补植建议', value: groups.filter((g) => g.advice.action === 'replant' && !g.generated).length },
  ]
  return { groups, summary }
}

export function batchKeyOf(recordNo: string): string {
  return `REVIEW:${recordNo}`
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// 并发复核串行化：同一时刻只放一个确认事务进临界区，
// 后到的请求重新读库时会发现记录已带结论，直接拒绝，只保留一个结论。
let confirmChain: Promise<unknown> = Promise.resolve()

export function confirmReview(recordId: number, options: ConfirmOptions = {}): Promise<ActionResult> {
  const run = confirmChain.then(() => doConfirm(recordId, options))
  // 不管成败都释放锁；结果由返回给调用方的 run 携带，不进链的类型。
  confirmChain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

async function doConfirm(recordId: number, options: ConfirmOptions): Promise<ActionResult> {
  // 留出读-写窗口，让并发点击在落库前都进入排队，验证互斥效果。
  await delay(80)

  // 全程基于最新库数据构建事务草稿，不修改缓存，失败时天然无副作用。
  const treeRows = listRows(TREE_KEY).map((r) => ({ ...r }))
  const index = treeRows.findIndex((r) => Number(r.id) === recordId)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${recordId} 的林木生长记录` }
  }
  const target = treeRows[index]
  if (isArchived(target) || target['复核结论']) {
    return { ok: false, message: '该样地记录已存在复核结论，并发复核只保留一个结论' }
  }
  if (String(target.status) !== NEED_REVIEW) {
    return { ok: false, message: `仅「${NEED_REVIEW}」状态的记录可以确认复核，当前为「${target.status}」` }
  }

  const recordNo = String(target['记录编号'] ?? '')
  const plotId = String(target['样地编号'] ?? '')
  const standType = String(target['林分类型'] ?? '')
  const batchKey = batchKeyOf(recordNo)

  const beltRows = listRows(BELT_KEY)
  const patrolRows = listRows(PATROL_KEY)
  // 幂等：建议或复查事项任一已存在，都视为已生成，不重复产出。
  if (beltRows.some((r) => String(r['来源批次'] ?? '') === batchKey)) {
    return { ok: false, message: `复核结论 ${recordNo} 的防火林带建议已生成过，重复确认不再生成` }
  }
  if (patrolRows.some((r) => String(r['来源批次'] ?? '') === batchKey)) {
    return { ok: false, message: `复核结论 ${recordNo} 的巡护复查事项已生成过，重复确认不再生成` }
  }

  // 第一处：复核结论落回林木生长记录。未归档值按新口径重算，原值留痕；缺调查员的旧记录一并回填。
  const backfill = planBackfill(plotId, treeRows)
  for (const row of treeRows) {
    if (String(row['样地编号'] ?? '') !== plotId) {
      continue
    }
    if (!String(row['调查员'] ?? '').trim()) {
      row['调查员'] = backfill.investigator
      row['调查员来源'] = backfill.source
    }
  }

  const metrics = METRIC_SPECS.map((spec) => {
    const raw = round(toNumber(target[spec.field]), spec.precision)
    return { spec, raw, effective: spec.factor === 1 ? raw : round(raw * spec.factor, spec.precision) }
  })
  for (const { spec, raw, effective } of metrics) {
    target[`原始${spec.field}`] = raw
    target[spec.field] = effective
  }
  const canopy = metrics.find((m) => m.spec.field === '郁闭度')!.effective
  const advice = adviceFor(canopy)
  const beltMatch = matchBelt(standType, beltRows)
  const reviewer = options.reviewer?.trim() || '值班管理员'
  const createdAt = new Date().toLocaleString('zh-CN', { hour12: false })

  target.status = ARCHIVED
  target['记录状态'] = ARCHIVED
  target.pending = false
  target.abnormal = false
  target['口径版本'] = NEW_CALIBER
  target['复核结论'] = `${advice.label}：${advice.reason}`
  target['复核人'] = reviewer
  target['复核时间'] = createdAt

  // 第二处：防火林带补植建议，沿林分类型 → 树种组成挂到既有林带。
  const belt = beltMatch.belt
  const beltId = beltRows.reduce((max, r) => Math.max(max, Number(r.id) || 0), 0) + 1
  const beltSuggestion: EntryRow = {
    id: beltId,
    status: advice.beltStatus || String(belt?.status ?? '完好'),
    pending: advice.action === 'replant' || (advice.action === 'observe' && String(belt?.status) !== '完好'),
    abnormal: false,
    林带编号: `FBADV-${recordNo}`,
    林带名称: `${String(belt?.['林带名称'] ?? '待分派林带')}·${plotId}${advice.label}`,
    所属林区: String(belt?.['所属林区'] ?? '待分派'),
    树种组成: String(belt?.['树种组成'] ?? '待分派'),
    林带长度: belt ? belt['林带长度'] : '',
    林带宽度: belt ? belt['林带宽度'] : '',
    种植年份: belt ? belt['种植年份'] : '',
    林带状态: advice.beltStatus || String(belt?.['林带状态'] ?? ''),
    关联样地: plotId,
    关联记录编号: recordNo,
    建议措施: advice.label,
    建议依据: advice.reason,
    林带匹配: beltMatch.matched ? beltMatch.reason : `未匹配改派：${beltMatch.reason}`,
    来源批次: batchKey,
    生成日期: today(),
  }

  // 第三处：巡护任务复查事项。每个补植建议都跟着一条补植复查项；
  // 临界/养护样地只出样地复查项。
  const patrolId = patrolRows.reduce((max, r) => Math.max(max, Number(r.id) || 0), 0)
  const region = String(belt?.['所属林区'] ?? '待分派林区')
  const beltName = String(belt?.['林带名称'] ?? '待分派林带')
  const reviewItem: EntryRow = {
    id: patrolId + 1,
    status: '待执行',
    pending: true,
    abnormal: false,
    任务编号: `REVU-${recordNo}`,
    巡护区域: `${region}（样地 ${plotId}）`,
    巡护路线: `样地${plotId} → ${beltName}`,
    巡护员: '待分派',
    巡护日期: today(),
    巡护时段: today(),
    发现火情数: 0,
    任务状态: '待执行',
    事项类型: '样地复核复查',
    关联样地: plotId,
    关联林带编号: String(belt?.['林带编号'] ?? ''),
    事项说明: `复核样地 ${plotId}（${standType}）${advice.label}落实情况：${advice.reason}`,
    来源批次: batchKey,
    生成日期: today(),
  }
  const nextPatrol = [...patrolRows, reviewItem]

  let followUp: EntryRow | null = null
  if (advice.action === 'replant') {
    followUp = {
      id: patrolId + 2,
      status: '待执行',
      pending: true,
      abnormal: false,
      任务编号: `RTASK-${recordNo}`,
      巡护区域: region,
      巡护路线: `${beltName}补植段`,
      巡护员: '待分派',
      巡护日期: today(),
      巡护时段: today(),
      发现火情数: 0,
      任务状态: '待执行',
      事项类型: '林带补植复查',
      关联样地: plotId,
      关联林带编号: `FBADV-${recordNo}`,
      事项说明: `跟踪 FBADV-${recordNo} 林带建议的苗木到位与成活率，补植完成后回填复查结果`,
      来源批次: batchKey,
      生成日期: today(),
    }
    nextPatrol.push(followUp)
  }

  if (options.failPersistence) {
    return { ok: false, message: '落库失败（模拟）：复核结论、补植建议与复查事项三处已一起回退，未写入任何数据' }
  }

  // 单一提交点：一次 setItem 写入三个模块。写入抛错时缓存不变，三处一起回退。
  try {
    commitAll({
      [TREE_KEY]: treeRows,
      [BELT_KEY]: [...beltRows, beltSuggestion],
      [PATROL_KEY]: nextPatrol,
    })
  } catch (error) {
    return {
      ok: false,
      message: `落库失败：复核结论、补植建议与复查事项三处已一起回退（${
        error instanceof Error ? error.message : '未知错误'
      }）`,
    }
  }

  const generated = followUp ? '补植建议、样地复查事项与补植复查事项' : '林带养护建议与样地复查事项'
  return {
    ok: true,
    message: `样地 ${plotId} 复核完成：结论已归档（${NEW_CALIBER}），同步生成${generated}`,
  }
}

export function _rawRows(): Record<string, EntryRow[]> {
  return allRows()
}
