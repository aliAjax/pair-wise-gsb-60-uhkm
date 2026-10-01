import { browser } from '$app/environment';
import type {
  AuditEntry,
  CaseVersion,
  EvidenceItem,
  InvestigationTask,
  SignalCase,
  SignalStatus,
  RiskLevel
} from '$lib/models/signal';
import type { ConfirmedChange, EvidenceCorrection } from '$lib/models/recalc';
import { seedSignals } from '$lib/services/seed';
import { confirmCandidate, peekSubmitDecision, submitRecalc } from '$lib/services/recalc-store';
import { get, writable } from 'svelte/store';

const STORAGE_KEY = 'medical-safety-signals-v2';

function cloneSeed(): SignalCase[] {
  return structuredClone(seedSignals);
}

function readPersisted(): SignalCase[] {
  if (!browser) return cloneSeed();

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as SignalCase[]) : cloneSeed();
  } catch {
    return cloneSeed();
  }
}

const internal = writable<SignalCase[]>(readPersisted());

if (browser) {
  internal.subscribe((value) => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  });
}

function now() {
  return new Date().toISOString();
}

function makeId(prefix: string) {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36)}`;
}

function riskFromSeverity(severity: number): RiskLevel {
  if (severity >= 5) return 'critical';
  if (severity >= 4) return 'high';
  if (severity >= 3) return 'medium';
  return 'low';
}

function statusLabel(status: SignalStatus) {
  const labels: Record<SignalStatus, string> = {
    new: '待分派',
    investigating: '调查中',
    observed: '持续观察',
    action_required: '待处置',
    review: '复核中',
    closed: '已关闭'
  };
  return labels[status];
}

function appendAudit(signal: SignalCase, actor: string, action: string, detail: string) {
  signal.audit.unshift({
    id: makeId('AUD'),
    actor,
    action,
    detail,
    createdAt: now()
  });
  signal.updatedAt = now();
}

export const signalStore = {
  subscribe: internal.subscribe,

  add(signal: SignalCase) {
    internal.update((items) => [signal, ...items]);
  },

  create(input: Omit<SignalCase, 'id' | 'openedAt' | 'updatedAt' | 'audit' | 'reopenedCount'>) {
    const createdAt = now();
    const signal: SignalCase = {
      ...input,
      id: `SIG-${new Date().getFullYear()}-${String(get(internal).length + 20).padStart(3, '0')}`,
      openedAt: createdAt,
      updatedAt: createdAt,
      reopenedCount: 0,
      audit: [
        {
          id: makeId('AUD'),
          actor: input.owner,
          action: '建立信号',
          detail: `按${input.sourceType}来源建立核查任务。`,
          createdAt
        }
      ]
    };
    internal.update((items) => [signal, ...items]);
    return signal;
  },

  transition(id: string, nextStatus: SignalStatus, reason: string, actor: string) {
    internal.update((items) =>
      items.map((signal) => {
        if (signal.id !== id) return signal;
        const updated = structuredClone(signal);
        const previous = updated.status;
        updated.status = nextStatus;
        if (nextStatus === 'action_required' && updated.riskLevel === 'low') {
          updated.riskLevel = 'medium';
        }
        appendAudit(
          updated,
          actor,
          '状态流转',
          `${statusLabel(previous)} -> ${statusLabel(nextStatus)}；依据：${reason}`
        );
        return updated;
      })
    );
  },

  addEvidence(id: string, evidence: EvidenceItem, actor: string) {
    internal.update((items) =>
      items.map((signal) => {
        if (signal.id !== id) return signal;
        const updated = structuredClone(signal);
        updated.evidence.unshift(evidence);
        appendAudit(
          updated,
          actor,
          '新增证据',
          `${evidence.title}，证据强度：${evidence.strength}`
        );
        return updated;
      })
    );
  },

  /**
   * 更正证据并启动可恢复重算流程：
   * 1) 保存更正前后字段（corrections + 审计），不静默覆盖旧记录
   * 2) 通知重算引擎让受影响读数失效（旧已发布版本继续展示）
   * 3) 受理重算作业（同信号只受理一个，后到窗口并入）
   */
  async correctEvidence(
    id: string,
    input: Omit<EvidenceCorrection, 'id' | 'createdAt'>,
    options: { clientSession?: string; clientLabel?: string } = {}
  ): Promise<{ outcome: 'started' | 'joined' | 'superseded'; jobId: string }> {
    // 后到窗口（同一信号已有在途作业）只并入，不允许再改一遍证据
    if (peekSubmitDecision(id) === 'joined') {
      const active = get(internal).find((signal) => signal.id === id);
      if (!active) throw new Error('未找到信号');
      const joined = await submitRecalc(active, { ...input, id: makeId('COR'), createdAt: now() }, options);
      return { outcome: joined.outcome, jobId: joined.job.id };
    }

    const correction: EvidenceCorrection = {
      ...input,
      id: makeId('COR'),
      createdAt: now()
    };

    let target: SignalCase | undefined;
    internal.update((items) =>
      items.map((signal) => {
        if (signal.id !== id) return signal;
        const updated = structuredClone(signal);
        const index = updated.evidence.findIndex((item) => item.id === correction.evidenceId);
        if (index === -1) return signal;
        updated.evidence[index] = {
          ...updated.evidence[index],
          title: correction.after.title,
          source: correction.after.source,
          strength: correction.after.strength as EvidenceItem['strength'],
          batch: correction.after.batch,
          note: correction.after.note,
          reports: correction.after.reports
        };
        updated.corrections = [correction, ...(updated.corrections ?? [])];
        appendAudit(
          updated,
          correction.actor,
          '更正证据',
          `《${correction.before.title}》->《${correction.after.title}》；归因报告数 ${correction.before.reports} -> ${correction.after.reports}；依据：${correction.reason}`
        );
        target = updated;
        return updated;
      })
    );

    if (!target) throw new Error('未找到待更正证据');

    const result = await submitRecalc(target, correction, options);
    return { outcome: result.outcome, jobId: result.job.id };
  },

  /**
   * 复核人确认新读数版本：台账（信号）、批次覆盖、趋势三处一起换版，
   * 并为每一处留下前后读数依据。
   */
  async confirmReading(input: {
    signalId: string;
    jobId: string;
    reviewer: string;
    note: string;
  }): Promise<ConfirmedChange> {
    const change = await confirmCandidate(input.signalId, input.jobId);
    const { previousReading, newReading, previousModel, newModel, job } = change;

    internal.update((items) =>
      items.map((signal) => {
        if (signal.id !== input.signalId) return signal;
        const updated = structuredClone(signal);

        appendAudit(
          updated,
          input.reviewer,
          '换版确认 · 台账读数',
          `V${previousModel.version} -> V${newModel.version}：报告数 ${previousReading.reportCount} -> ${newReading.reportCount}，发生率 ${previousReading.occurrenceRate.toFixed(2)}% -> ${newReading.occurrenceRate.toFixed(2)}%；依据：${input.note}`
        );
        appendAudit(
          updated,
          input.reviewer,
          '换版确认 · 批次覆盖',
          `覆盖批号 ${previousReading.affectedBatches.join('、') || '（无）'} -> ${newReading.affectedBatches.join('、')}；依据：${input.note}`
        );
        appendAudit(
          updated,
          input.reviewer,
          '换版确认 · 趋势核对',
          `阻塞报警近月 ${previousModel.trends.pumpOcclusion.at(-1)?.value.toFixed(2)}% -> ${newModel.trends.pumpOcclusion.at(-1)?.value.toFixed(2)}%（阈值 0.75%）；依据：${input.note}`
        );
        appendAudit(
          updated,
          input.reviewer,
          '重算作业确认',
          `作业 ${job.id}：更正《${job.correction.after.title}》后重算三阶段完成，证据依据 ${newReading.evidenceBasis.join('、')}`
        );
        return updated;
      })
    );

    return change;
  },

  addVersion(id: string, version: CaseVersion, actor: string) {
    internal.update((items) =>
      items.map((signal) => {
        if (signal.id !== id) return signal;
        const updated = structuredClone(signal);
        updated.versions.unshift(version);
        appendAudit(updated, actor, '形成版本', `版本 V${version.version}：${version.summary}`);
        return updated;
      })
    );
  },

  reopen(id: string, actor: string, reason: string) {
    internal.update((items) =>
      items.map((signal) => {
        if (signal.id !== id) return signal;
        const updated = structuredClone(signal);
        updated.status = 'investigating';
        updated.reopenedCount += 1;
        appendAudit(updated, actor, '重新打开', reason);
        return updated;
      })
    );
  },

  replaceTask(id: string, task: InvestigationTask) {
    internal.update((items) =>
      items.map((signal) => {
        if (signal.id !== id) return signal;
        const updated = structuredClone(signal);
        updated.tasks = updated.tasks.map((item) => (item.id === task.id ? task : item));
        appendAudit(updated, task.owner, '更新任务', `${task.title}：${task.status}`);
        return updated;
      })
    );
  },

  addAudit(id: string, entry: AuditEntry) {
    internal.update((items) =>
      items.map((signal) => {
        if (signal.id !== id) return signal;
        const updated = structuredClone(signal);
        updated.audit.unshift(entry);
        updated.updatedAt = entry.createdAt;
        return updated;
      })
    );
  },

  reset() {
    internal.set(cloneSeed());
  },

  getSnapshot() {
    return get(internal);
  }
};

export function createSignalFromForm(input: {
  title: string;
  product: string;
  batch: string;
  sourceType: SignalCase['sourceType'];
  severity: number;
  occurredAt: string;
  description: string;
}): SignalCase {
  const nowIso = now();
  return {
    id: `SIG-${new Date().getFullYear()}-${String(Date.now()).slice(-3)}`,
    title: input.title,
    product: input.product,
    batch: input.batch,
    sourceType: input.sourceType,
    status: 'new',
    riskLevel: riskFromSeverity(input.severity),
    severity: input.severity,
    reportCount: 1,
    exposedUnits: 0,
    occurrenceRate: 0,
    occurredAt: input.occurredAt,
    openedAt: nowIso,
    updatedAt: nowIso,
    owner: '待分派',
    description: input.description,
    affectedBatches: [input.batch],
    evidence: [],
    corrections: [],
    tasks: [
      {
        id: makeId('TASK'),
        title: '核对来源记录与产品批号',
        owner: '待分派',
        dueAt: new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10),
        status: 'open'
      }
    ],
    versions: [],
    audit: [
      {
        id: makeId('AUD'),
        actor: '安全台账',
        action: '建立信号',
        detail: '由人工登记表单创建初始信号。',
        createdAt: nowIso
      }
    ],
    reopenedCount: 0
  };
}
