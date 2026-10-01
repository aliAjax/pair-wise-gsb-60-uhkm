import { get } from 'svelte/store';
import type { SignalCase, SignalFilters } from '$lib/models/signal';
import { signalStore } from '$lib/stores/signal-store';
import { readModel, recalcInvalidations } from './recalc-store';

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function listSignals(filters: SignalFilters = {}): Promise<SignalCase[]> {
  await wait(80);
  const query = filters.query?.trim().toLowerCase();

  return signalStore
    .getSnapshot()
    .filter((signal) => {
      const matchesQuery =
        !query ||
        [signal.id, signal.title, signal.product, signal.batch]
          .join(' ')
          .toLowerCase()
          .includes(query);
      const matchesStatus = !filters.status || filters.status === 'all' || signal.status === filters.status;
      const matchesRisk =
        !filters.riskLevel || filters.riskLevel === 'all' || signal.riskLevel === filters.riskLevel;
      const matchesSource =
        !filters.sourceType || filters.sourceType === 'all' || signal.sourceType === filters.sourceType;
      return matchesQuery && matchesStatus && matchesRisk && matchesSource;
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function exportSignalReport(id: string) {
  const signal = get(signalStore).find((item) => item.id === id);
  if (!signal) return;

  const model = get(readModel);
  const reading = model.signals.find((item) => item.signalId === id);
  const invalidation = get(recalcInvalidations).find((item) => item.signalId === id);

  const report = {
    generatedAt: new Date().toISOString(),
    product: signal.product,
    batch: signal.batch,
    status: signal.status,
    riskLevel: signal.riskLevel,
    conclusion: signal.versions[0]?.summary ?? '尚未形成核查结论',
    publishedReading: reading
      ? {
          modelVersion: model.version,
          publishedAt: model.publishedAt,
          reportCount: reading.reportCount,
          exposedUnits: reading.exposedUnits,
          occurrenceRate: reading.occurrenceRate,
          affectedBatches: reading.affectedBatches,
          evidenceBasis: reading.evidenceBasis
        }
      : null,
    readingStale: invalidation
      ? {
          invalidatedAt: invalidation.invalidatedAt,
          staleFromVersion: invalidation.staleFromVersion,
          reason: invalidation.reason,
          jobId: invalidation.jobId
        }
      : null,
    corrections: signal.corrections,
    evidence: signal.evidence,
    audit: signal.audit
  };

  const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${signal.id}-traceability-report.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}
