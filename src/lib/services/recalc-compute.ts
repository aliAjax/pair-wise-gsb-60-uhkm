import type { EvidenceItem, SignalCase } from '$lib/models/signal';
import type { ReadModel, SignalReading, TrendPoint } from '$lib/models/recalc';

/** 阻塞报警趋势序列（对应智能输液泵 IP-800） */
export const PUMP_PRODUCT_KEY = 'IP-800';
export const TREND_THRESHOLD = 0.75;

export const initialPumpTrend: TrendPoint[] = [
  { label: '2026-04', value: 0.18, threshold: TREND_THRESHOLD },
  { label: '2026-05', value: 0.31, threshold: TREND_THRESHOLD },
  { label: '2026-06', value: 0.46, threshold: TREND_THRESHOLD },
  { label: '2026-07', value: 0.52, threshold: TREND_THRESHOLD },
  { label: '2026-08', value: 0.69, threshold: TREND_THRESHOLD },
  { label: '2026-09', value: 0.83, threshold: TREND_THRESHOLD }
];

/**
 * 重算规则（确定性，无外部依赖）：
 * - 报告数 = 全部证据归因报告数之和；未登记归因数的证据按 1 条计入
 * - 核查发生率（%）= 报告数 / 暴露台数 × 100，保留两位小数
 * - 批次覆盖 = 信号批次 + 全部证据关联批号的并集
 */
export function evidenceReports(evidence: EvidenceItem): number {
  const raw = (evidence as EvidenceItem & { reports?: number }).reports;
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : 1;
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function computeSignalReading(signal: SignalCase): SignalReading {
  const reportCount = signal.evidence.reduce((sum, item) => sum + evidenceReports(item), 0);
  const occurrenceRate =
    signal.exposedUnits > 0 ? round2((reportCount / signal.exposedUnits) * 100) : 0;
  return {
    signalId: signal.id,
    reportCount,
    exposedUnits: signal.exposedUnits,
    occurrenceRate,
    affectedBatches: Array.from(
      new Set([signal.batch, ...signal.affectedBatches, ...signal.evidence.map((item) => item.batch)])
    ).sort(),
    evidenceBasis: signal.evidence.map((item) => item.id)
  };
}

/** 趋势阶段：仅重算输液泵阻塞报警序列的最近一个月点，历史点保留 */
export function computePumpTrend(current: TrendPoint[], candidate: SignalReading): TrendPoint[] {
  const next = current.map((point) => ({ ...point }));
  if (next.length > 0) {
    next[next.length - 1] = {
      ...next[next.length - 1],
      value: candidate.occurrenceRate
    };
  }
  return next;
}

/** 从种子/当前台账构建首个已发布读数版本 */
export function buildInitialReadModel(signals: SignalCase[]): ReadModel {
  return {
    version: 1,
    publishedAt: '2026-09-28T12:00:00.000Z',
    signals: signals.map(computeSignalReading),
    trends: {
      pumpOcclusion: initialPumpTrend.map((point) => ({ ...point }))
    }
  };
}

export function isPumpSignal(signal: SignalCase): boolean {
  return signal.product.includes(PUMP_PRODUCT_KEY);
}
