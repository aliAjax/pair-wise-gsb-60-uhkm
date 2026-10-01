import type {
  EvidenceItem,
  RecalcJob,
  RecalcPhase,
  RiskLevel,
  SignalCase,
  SignalReadings
} from '$lib/models/signal';

/** 台账、批次追踪、趋势核对三处统一取这里，禁止再读顶层旧字段 */
export function activeReadings(signal: SignalCase): SignalReadings {
  return signal.readings;
}

export function readingsState(signal: SignalCase): 'confirmed' | 'recalculating' | 'retry' | 'review' {
  const job = signal.recalcJob;
  if (!job) return 'confirmed';
  if (job.status === 'awaiting_review') return 'review';
  if (job.status === 'archive_retrying') return 'retry';
  return 'recalculating';
}

/** 重算未完成（含存档重试与待复核）期间，三处页面展示的上一版读数即视为陈旧 */
export function isReadingsStale(signal: SignalCase): boolean {
  return Boolean(signal.recalcJob && signal.recalcJob.status !== 'superseded');
}

export function activeEvidence(signal: SignalCase): EvidenceItem[] {
  return signal.evidence.filter((item) => !item.superseded);
}

const riskOrder: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2, critical: 3 };

export function maxRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  return riskOrder[a] >= riskOrder[b] ? a : b;
}

export function evidenceReports(item: EvidenceItem): number {
  // 相反证据不贡献报告数；未登记取数字段的历史证据按 0 处理
  if (item.superseded || item.strength === 'contrary') return 0;
  return Math.max(0, item.reports ?? 0);
}

export function evidenceExposed(item: EvidenceItem): number {
  if (item.superseded) return 0;
  return Math.max(0, item.exposed ?? 0);
}

export function rateOf(reportCount: number, exposedUnits: number): number {
  return exposedUnits > 0 ? Math.round((reportCount / exposedUnits) * 10000) / 100 : 0;
}

/**
 * 重算口径（可追溯，文本同步写入候选版本 basis）：
 * - 报告数 = 全部有效证据登记报告数之和（相反证据计 0，同一现场报告不重复计）
 * - 暴露台数 = 各证据暴露台数最大值（同批装机量不叠加）
 * - 批号覆盖 = 上一版批号与有效证据批号的并集
 * - 风险 = 严重度与发生率推导结果，与上一版就高不就低，避免证据更正静默降级
 */
export function buildCandidateReadings(signal: SignalCase, previous: SignalReadings): SignalReadings {
  const evidence = activeEvidence(signal);
  const reportCount = evidence.reduce((sum, item) => sum + evidenceReports(item), 0);
  const exposedUnits = evidence.reduce((max, item) => Math.max(max, evidenceExposed(item)), 0);
  const occurrenceRate = rateOf(reportCount, exposedUnits);
  const affectedBatches = Array.from(
    new Set([...previous.affectedBatches, ...evidence.map((item) => item.batch)])
  ).sort();

  let derived: RiskLevel = 'low';
  if (signal.severity >= 5 || occurrenceRate >= 2) derived = 'critical';
  else if (signal.severity >= 4 || occurrenceRate >= 0.75) derived = 'high';
  else if (signal.severity >= 3 || occurrenceRate >= 0.3) derived = 'medium';
  const riskLevel = maxRisk(previous.riskLevel, derived);

  const counted = evidence
    .filter((item) => evidenceReports(item) > 0)
    .map((item) => `${item.title} ${evidenceReports(item)} 条`)
    .join('、');
  const contrary = evidence.filter((item) => item.strength === 'contrary');

  return {
    version: previous.version + 1,
    reportCount,
    exposedUnits,
    occurrenceRate,
    riskLevel,
    affectedBatches,
    basis:
      `V${previous.version + 1} 重算：报告数取有效证据登记报告数之和（${counted || '无计报告证据'}，共 ${reportCount} 条）；` +
      `暴露台数取各证据覆盖装机量最大值 ${exposedUnits} 台；发生率 ${occurrenceRate.toFixed(2)}%；` +
      `批号覆盖取上一版 ${previous.affectedBatches.join('、')} 与有效证据批号并集，结果为 ${affectedBatches.join('、')}；` +
      `风险就高不就低（${previous.riskLevel} → ${riskLevel}）` +
      (contrary.length ? `；相反证据 ${contrary.length} 项保留但报告数计 0` : '') +
      '。复核确认前台账、批次追踪、趋势核对仍展示上一版完整读数。'
  };
}

export const phaseLabels: Record<RecalcPhase, string> = {
  ledger: '台账读数',
  batches: '批次覆盖',
  trends: '趋势核对',
  archive: '版本存档'
};

export const phaseOrder: RecalcPhase[] = ['ledger', 'batches', 'trends', 'archive'];

export const jobStatusLabels: Record<NonNullable<RecalcJob['status']>, string> = {
  running: '重算进行中',
  awaiting_review: '待复核确认',
  archive_retrying: '存档重试中',
  superseded: '已被新更正取代'
};

export interface ReadingDiff {
  label: string;
  before: string;
  after: string;
  changed: boolean;
}

export function diffReadings(before: SignalReadings, after: SignalReadings): ReadingDiff[] {
  return [
    {
      label: '报告数',
      before: `${before.reportCount} 条`,
      after: `${after.reportCount} 条`,
      changed: before.reportCount !== after.reportCount
    },
    {
      label: '暴露台数',
      before: `${before.exposedUnits} 台`,
      after: `${after.exposedUnits} 台`,
      changed: before.exposedUnits !== after.exposedUnits
    },
    {
      label: '核查发生率',
      before: `${before.occurrenceRate.toFixed(2)}%`,
      after: `${after.occurrenceRate.toFixed(2)}%`,
      changed: before.occurrenceRate !== after.occurrenceRate
    },
    {
      label: '风险等级',
      before: before.riskLevel,
      after: after.riskLevel,
      changed: before.riskLevel !== after.riskLevel
    },
    {
      label: '批号覆盖',
      before: before.affectedBatches.join('、'),
      after: after.affectedBatches.join('、'),
      changed: before.affectedBatches.join('|') !== after.affectedBatches.join('|')
    }
  ];
}
