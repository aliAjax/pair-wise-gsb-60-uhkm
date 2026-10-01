import { browser } from '$app/environment';
import type {
  AuditEntry,
  CaseVersion,
  EvidenceCorrection,
  EvidenceItem,
  InvestigationTask,
  RecalcJob,
  SignalCase,
  SignalStatus,
  SignalReadings,
  RiskLevel
} from '$lib/models/signal';
import { seedSignals } from '$lib/services/seed';
import { get, writable } from 'svelte/store';

const STORAGE_KEY = 'medical-safety-signals-v1';

function cloneSeed(): SignalCase[] {
  return structuredClone(seedSignals);
}

/** 旧版本 localStorage 没有 readings 字段：由顶层旧字段派生 V1 基线，旧数字继续可解释 */
function migrateSignal(input: SignalCase): SignalCase {
  if (input.readings) {
    return {
      ...input,
      readingsHistory: input.readingsHistory ?? []
    };
  }
  const readings: SignalReadings = {
    version: 1,
    reportCount: input.reportCount,
    exposedUnits: input.exposedUnits,
    occurrenceRate: input.occurrenceRate,
    riskLevel: input.riskLevel,
    affectedBatches: [...input.affectedBatches],
    basis:
      'V1 基线（由更正前台账旧字段迁移）：报告数、暴露台数、发生率、批号覆盖直接取自原台账记录，迁移时未重新取数。',
    confirmedAt: input.updatedAt,
    confirmedBy: input.owner,
    confirmNote: '证据更正流水线启用前的历史读数，保持原值。'
  };
  return { ...input, readings, readingsHistory: [] };
}

function readPersisted(): SignalCase[] {
  if (!browser) return cloneSeed();

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return cloneSeed();
    const parsed = JSON.parse(raw) as SignalCase[];
    return parsed.map(migrateSignal);
  } catch {
    return cloneSeed();
  }
}

const internal = writable<SignalCase[]>(readPersisted());

let lastPersisted = '';

function persist(items: SignalCase[]) {
  if (!browser) return;
  lastPersisted = JSON.stringify(items);
  localStorage.setItem(STORAGE_KEY, lastPersisted);
}

internal.subscribe((items) => persist(items));

// 多窗口协同：其他窗口提交更正/推进作业后，本窗口直接采用同一份持久化结果
if (browser) {
  window.addEventListener('storage', (event) => {
    if (event.key !== STORAGE_KEY || !event.newValue || event.newValue === lastPersisted) return;
    try {
      const incoming = (JSON.parse(event.newValue) as SignalCase[]).map(migrateSignal);
      lastPersisted = event.newValue;
      internal.set(incoming);
    } catch {
      // 解析失败时保留当前内存快照，等待下一次同步
    }
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

function mapSignal(items: SignalCase[], id: string, mutate: (signal: SignalCase) => void) {
  return items.map((signal) => {
    if (signal.id !== id) return signal;
    const updated = structuredClone(signal);
    mutate(updated);
    return updated;
  });
}

export interface CorrectEvidenceInput {
  evidenceId: string;
  item: Omit<EvidenceItem, 'id' | 'createdAt'>;
  actor: string;
  reason: string;
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
      mapSignal(items, id, (updated) => {
        const previous = updated.status;
        updated.status = nextStatus;
        appendAudit(
          updated,
          actor,
          '状态流转',
          `${statusLabel(previous)} -> ${statusLabel(nextStatus)}；依据：${reason}`
        );
      })
    );
  },

  addEvidence(id: string, evidence: EvidenceItem, actor: string) {
    internal.update((items) =>
      mapSignal(items, id, (updated) => {
        updated.evidence.unshift(evidence);
        appendAudit(
          updated,
          actor,
          '新增证据',
          `${evidence.title}，证据强度：${evidence.strength}`
        );
      })
    );
  },

  addVersion(id: string, version: CaseVersion, actor: string) {
    internal.update((items) =>
      mapSignal(items, id, (updated) => {
        updated.versions.unshift(version);
        appendAudit(updated, actor, '形成版本', `版本 V${version.version}：${version.summary}`);
      })
    );
  },

  reopen(id: string, actor: string, reason: string) {
    internal.update((items) =>
      mapSignal(items, id, (updated) => {
        updated.status = 'investigating';
        updated.reopenedCount += 1;
        appendAudit(updated, actor, '重新打开', reason);
      })
    );
  },

  replaceTask(id: string, task: InvestigationTask) {
    internal.update((items) =>
      mapSignal(items, id, (updated) => {
        updated.tasks = updated.tasks.map((item) => (item.id === task.id ? task : item));
        appendAudit(updated, task.owner, '更新任务', `${task.title}：${task.status}`);
      })
    );
  },

  addAudit(id: string, entry: AuditEntry) {
    internal.update((items) =>
      mapSignal(items, id, (updated) => {
        updated.audit.unshift(entry);
        updated.updatedAt = entry.createdAt;
      })
    );
  },

  /**
   * 证据更正：旧证据不删除，标记失效并保存原始字段与更正原因；
   * 同步让当前已确认读数对台账/批次/趋势三处失效。
   * 若该信号已有未完成重算作业，递增 generation 让旧回合作废后从头重算。
   */
  correctEvidence(id: string, input: CorrectEvidenceInput): { newEvidenceId: string; jobId: string } {
    let newEvidenceId = '';
    let jobId = '';
    internal.update((items) =>
      mapSignal(items, id, (updated) => {
        const old = updated.evidence.find((item) => item.id === input.evidenceId);
        if (!old || old.superseded) return;
        newEvidenceId = makeId('E');
        const timestamp = now();

        const correction: EvidenceCorrection = {
          correctedAt: timestamp,
          actor: input.actor,
          reason: input.reason,
          previous: {
            type: old.type,
            title: old.title,
            source: old.source,
            strength: old.strength,
            batch: old.batch,
            note: old.note,
            reports: old.reports ?? 0,
            exposed: old.exposed ?? 0
          }
        };

        old.superseded = true;
        old.replacedBy = newEvidenceId;
        old.corrections = [...(old.corrections ?? []), correction];

        const replacement: EvidenceItem = {
          ...input.item,
          id: newEvidenceId,
          createdAt: timestamp
        };
        updated.evidence.unshift(replacement);

        const existing = updated.recalcJob;
        if (existing && existing.status !== 'superseded' && existing.status !== 'awaiting_review') {
          // 进行中（含存档重试）的作业：保留作业号、从头重算，旧执行回合自动让路
          jobId = existing.id;
          existing.generation += 1;
          existing.status = 'running';
          existing.completedPhases = [];
          existing.candidate = undefined;
          existing.archiveAttempts = 0;
          existing.lastError = undefined;
          existing.reason = `证据 ${old.title} 被再次更正：${input.reason}`;
          existing.requestedBy = input.actor;
          existing.startedAt = timestamp;
          existing.updatedAt = timestamp;
          existing.correctionIds.push(newEvidenceId);
        } else {
          if (existing) {
            // 待复核版本被新的更正取代，不进入版本历史
            existing.status = 'superseded';
            existing.updatedAt = timestamp;
          }
          jobId = makeId('JOB');
          const job: RecalcJob = {
            id: jobId,
            signalId: id,
            generation: 1,
            status: 'running',
            completedPhases: [],
            reason: `证据「${old.title}」更正：${input.reason}`,
            requestedBy: input.actor,
            startedAt: timestamp,
            updatedAt: timestamp,
            archiveAttempts: 0,
            attached: [],
            correctionIds: [newEvidenceId]
          };
          updated.recalcJob = job;
        }

        appendAudit(
          updated,
          input.actor,
          '证据更正',
          `「${correction.previous.title}」（${correction.previous.source}，强度 ${correction.previous.strength}，` +
            `批号 ${correction.previous.batch}，报告 ${correction.previous.reports} 条/暴露 ${correction.previous.exposed} 台）` +
            `更正为「${replacement.title}」（${replacement.source}，强度 ${replacement.strength}，批号 ${replacement.batch}，` +
            `报告 ${replacement.reports ?? 0} 条/暴露 ${replacement.exposed ?? 0} 台）。原因：${input.reason}。` +
            `台账、批次追踪、趋势核对的 V${updated.readings.version} 读数即刻失效并启动重算作业 ${jobId}，确认前继续展示上一版。`
        );
      })
    );
    return { newEvidenceId, jobId };
  },

  /** 重算推进器：检查点完成、候选版本落库、存档失败记录均经此持久化（可恢复的关键） */
  updateRecalcJob(id: string, jobId: string, mutate: (job: RecalcJob) => void): boolean {
    let touched = false;
    internal.update((items) =>
      mapSignal(items, id, (updated) => {
        if (!updated.recalcJob || updated.recalcJob.id !== jobId) return;
        const clone = structuredClone(updated.recalcJob);
        mutate(clone);
        clone.updatedAt = now();
        updated.recalcJob = clone;
        touched = true;
      })
    );
    return touched;
  },

  getRecalcJob(id: string): RecalcJob | undefined {
    return get(internal).find((item) => item.id === id)?.recalcJob;
  },

  /** 后到的重复提交并入现有作业，只登记不另起计算 */
  attachRecalcJob(id: string, jobId: string, by: string): boolean {
    return this.updateRecalcJob(id, jobId, (job) => {
      job.attached.push({ at: now(), by });
    });
  },

  /** 无作业时原子补建（人工“继续重试/重新发起”入口）；已有作业则不动 */
  ensureRecalcJob(id: string, draft: RecalcJob) {
    internal.update((items) =>
      mapSignal(items, id, (updated) => {
        const existing = updated.recalcJob;
        if (existing && existing.status !== 'superseded') return;
        updated.recalcJob = structuredClone(draft);
        updated.updatedAt = now();
      })
    );
  },

  /**
   * 复核人确认新版本：台账、批次、趋势三处同源，一次原子换读；
   * 旧版进入 readingsHistory，逐字段前后依据写入审计。
   */
  confirmRecalculation(id: string, jobId: string, reviewer: string, note: string): boolean {
    let committed = false;
    internal.update((items) =>
      mapSignal(items, id, (updated) => {
        const job = updated.recalcJob;
        if (!job || job.id !== jobId || job.status !== 'awaiting_review' || !job.candidate) return;

        const previous = updated.readings;
        const candidate: SignalReadings = {
          ...job.candidate,
          confirmedAt: now(),
          confirmedBy: reviewer,
          confirmNote: note
        };

        updated.readingsHistory = [previous, ...updated.readingsHistory];
        updated.readings = candidate;
        // 顶层旧字段同步，仅为兼容尚未切换的导出逻辑
        updated.reportCount = candidate.reportCount;
        updated.exposedUnits = candidate.exposedUnits;
        updated.occurrenceRate = candidate.occurrenceRate;
        updated.riskLevel = candidate.riskLevel;
        updated.affectedBatches = [...candidate.affectedBatches];
        updated.recalcJob = undefined;

        appendAudit(
          updated,
          reviewer,
          '复核确认换版',
          `确认重算 V${candidate.version}（作业 ${jobId}，复核依据：${note}）。台账、批次追踪、趋势核对三处同时换读：` +
            `报告数 ${previous.reportCount}→${candidate.reportCount} 条，暴露 ${previous.exposedUnits}→${candidate.exposedUnits} 台，` +
            `发生率 ${previous.occurrenceRate.toFixed(2)}%→${candidate.occurrenceRate.toFixed(2)}%，` +
            `风险 ${previous.riskLevel}→${candidate.riskLevel}，批号覆盖 ${previous.affectedBatches.join('、')}→${candidate.affectedBatches.join('、')}。` +
            `前版依据：${previous.basis} 新版依据：${candidate.basis}`
        );
        committed = true;
      })
    );
    return committed;
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
  const id = `SIG-${new Date().getFullYear()}-${String(Date.now()).slice(-3)}`;
  return {
    id,
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
    readings: {
      version: 1,
      reportCount: 1,
      exposedUnits: 0,
      occurrenceRate: 0,
      riskLevel: riskFromSeverity(input.severity),
      affectedBatches: [input.batch],
      basis: 'V1 基线：人工登记初建信号，报告 1 条，暴露台数与发生率待核查任务补齐。',
      confirmedAt: nowIso,
      confirmedBy: '安全台账',
      confirmNote: '登记即建立的初始读数。'
    },
    readingsHistory: [],
    evidence: [],
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
