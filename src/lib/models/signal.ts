import { z } from 'zod';

export const signalStatuses = [
  'new',
  'investigating',
  'observed',
  'action_required',
  'review',
  'closed'
] as const;

export const riskLevels = ['low', 'medium', 'high', 'critical'] as const;
export const evidenceStrengths = ['strong', 'moderate', 'weak', 'contrary'] as const;

export const createSignalSchema = z.object({
  title: z.string().trim().min(6, '信号标题至少 6 个字符'),
  product: z.string().trim().min(2, '请输入产品名称'),
  batch: z.string().trim().min(2, '请输入批号'),
  sourceType: z.enum(['complaint', 'repair', 'adverse_event', 'field_report']),
  severity: z.coerce.number().int().min(1).max(5),
  occurredAt: z.string().min(1, '请选择发生日期'),
  description: z.string().trim().min(10, '经过说明至少 10 个字符')
});

export const transitionSchema = z.object({
  id: z.string().min(1),
  nextStatus: z.enum(signalStatuses),
  reason: z.string().trim().min(4, '请填写流转依据'),
  actor: z.string().trim().min(2, '请填写操作人')
});

export const evidenceSchema = z.object({
  id: z.string().min(1),
  evidenceType: z.enum(['complaint', 'repair', 'adverse_event', 'field_report', 'test', 'literature']),
  title: z.string().trim().min(4, '证据名称至少 4 个字符'),
  source: z.string().trim().min(2, '请填写来源'),
  strength: z.enum(evidenceStrengths),
  batch: z.string().trim().min(1, '请填写关联批号'),
  note: z.string().trim().min(4, '请填写核查说明')
});

export const versionSchema = z.object({
  id: z.string().min(1),
  author: z.string().trim().min(2, '请填写版本作者'),
  summary: z.string().trim().min(8, '结论摘要至少 8 个字符'),
  disposition: z.enum(['continue_observation', 'risk_communication', 'corrective_action']),
  rationale: z.string().trim().min(6, '请填写判断依据')
});

export const correctEvidenceSchema = z.object({
  id: z.string().min(1),
  evidenceId: z.string().min(1),
  evidenceType: z.enum(['complaint', 'repair', 'adverse_event', 'field_report', 'test', 'literature']),
  title: z.string().trim().min(4, '证据名称至少 4 个字符'),
  source: z.string().trim().min(2, '请填写来源'),
  strength: z.enum(evidenceStrengths),
  batch: z.string().trim().min(1, '请填写关联批号'),
  note: z.string().trim().min(4, '请填写核查说明'),
  reports: z.coerce.number().int('报告数须为整数').min(0, '报告数不能为负'),
  exposed: z.coerce.number().int('暴露台数须为整数').min(0, '暴露台数不能为负'),
  actor: z.string().trim().min(2, '请填写更正人'),
  reason: z.string().trim().min(10, '请说明更正原因（至少 10 个字符）')
});

export const confirmReadingsSchema = z.object({
  id: z.string().min(1),
  jobId: z.string().min(1),
  reviewer: z.string().trim().min(2, '请填写复核人'),
  note: z.string().trim().min(6, '复核依据至少 6 个字符')
});

export type SignalStatus = (typeof signalStatuses)[number];
export type RiskLevel = (typeof riskLevels)[number];
export type EvidenceStrength = (typeof evidenceStrengths)[number];
export type SignalSourceType = z.infer<typeof createSignalSchema>['sourceType'];
export type Disposition = z.infer<typeof versionSchema>['disposition'];

export interface EvidenceItem {
  id: string;
  type: SignalSourceType | 'test' | 'literature';
  title: string;
  source: string;
  strength: EvidenceStrength;
  batch: string;
  note: string;
  createdAt: string;
  /** 该证据支撑的报告条数，重算台账读数的依据 */
  reports?: number;
  /** 该证据覆盖的暴露台数，重算暴露读数的依据 */
  exposed?: number;
  /** 已被更正记录替代时标记，证据本身不删除 */
  superseded?: boolean;
  /** 替代它的新证据 id */
  replacedBy?: string;
  /** 更正历史：原始记录字段值 + 更正原因与操作人 */
  corrections?: EvidenceCorrection[];
}

export interface EvidenceCorrection {
  correctedAt: string;
  actor: string;
  reason: string;
  previous: {
    type: EvidenceItem['type'];
    title: string;
    source: string;
    strength: EvidenceStrength;
    batch: string;
    note: string;
    reports: number;
    exposed: number;
  };
}

export interface SignalReadings {
  /** 台账、批次、趋势三处共同展示的不可变读数版本 */
  version: number;
  reportCount: number;
  exposedUnits: number;
  occurrenceRate: number;
  riskLevel: RiskLevel;
  affectedBatches: string[];
  /** 该版读数的计算依据（取数口径、纳入证据、批号并集等） */
  basis: string;
  /** 触发本版的证据更正记录 id；V1 基线为空 */
  correctionId?: string;
  /** 复核人确认时间；候选版本期间为空 */
  confirmedAt?: string;
  confirmedBy?: string;
  confirmNote?: string;
  /** 被哪个版本替换，仅保留历史时使用 */
  superseded?: boolean;
}

export const recalcPhases = ['ledger', 'batches', 'trends', 'archive'] as const;
export type RecalcPhase = (typeof recalcPhases)[number];

export type RecalcJobStatus = 'running' | 'awaiting_review' | 'archive_retrying' | 'superseded';

export interface RecalcJob {
  id: string;
  signalId: string;
  /** 同一证据在确认前被再次更正时递增，旧执行回合自行作废 */
  generation: number;
  status: RecalcJobStatus;
  /** 已完成的检查点（存档成功后含 archive） */
  completedPhases: RecalcPhase[];
  /** 候选读数：在复核确认前三处页面仍显示上一版 */
  candidate?: SignalReadings;
  /** 触发原因与发起人 */
  reason: string;
  requestedBy: string;
  startedAt: string;
  updatedAt: string;
  /** 存档失败次数与最近一次错误；候选结果不丢、旧结果不换 */
  archiveAttempts: number;
  lastError?: string;
  /** 被并入本作业的重复提交（两个窗口同时点重算时后到者） */
  attached: Array<{ at: string; by: string }>;
  /** 重放的证据更正记录 id */
  correctionIds: string[];
}

export interface InvestigationTask {
  id: string;
  title: string;
  owner: string;
  dueAt: string;
  status: 'open' | 'in_progress' | 'done';
}

export interface CaseVersion {
  id: string;
  version: number;
  author: string;
  summary: string;
  disposition: Disposition;
  rationale: string;
  createdAt: string;
}

export interface AuditEntry {
  id: string;
  actor: string;
  action: string;
  detail: string;
  createdAt: string;
}

export interface SignalCase {
  id: string;
  title: string;
  product: string;
  batch: string;
  sourceType: SignalSourceType;
  status: SignalStatus;
  /** @deprecated 三处页面统一读取 readings；顶层字段仅为历史 localStorage 兼容 */
  riskLevel: RiskLevel;
  severity: number;
  /** @deprecated 改用 readings.reportCount */
  reportCount: number;
  /** @deprecated 改用 readings.exposedUnits */
  exposedUnits: number;
  /** @deprecated 改用 readings.occurrenceRate */
  occurrenceRate: number;
  occurredAt: string;
  openedAt: string;
  updatedAt: string;
  owner: string;
  description: string;
  /** @deprecated 改用 readings.affectedBatches */
  affectedBatches: string[];
  /** 当前已确认读数版本（台账、批次、趋势三处唯一数据源） */
  readings: SignalReadings;
  /** 历版读数，复核确认换版后追加，保留前后依据 */
  readingsHistory: SignalReadings[];
  /** 进行中/待复核/重试中的重算作业；复核确认或被取代后清空 */
  recalcJob?: RecalcJob;
  evidence: EvidenceItem[];
  tasks: InvestigationTask[];
  versions: CaseVersion[];
  audit: AuditEntry[];
  reopenedCount: number;
}

export interface SignalFilters {
  query?: string;
  status?: SignalStatus | 'all';
  riskLevel?: RiskLevel | 'all';
  sourceType?: SignalSourceType | 'all';
}
