import { z } from 'zod';

/** 重算作业的三个阶段：受影响信号 → 批次覆盖 → 趋势核对 */
export const recalcStages = ['signals', 'batches', 'trends'] as const;
export type RecalcStage = (typeof recalcStages)[number];

export const stageLabels: Record<RecalcStage, string> = {
  signals: '受影响信号读数',
  batches: '批次覆盖',
  trends: '趋势核对'
};

/** 证据更正记录：保存更正前后的字段，供复核人解释当时依据 */
export interface EvidenceCorrection {
  id: string;
  evidenceId: string;
  actor: string;
  reason: string;
  before: {
    title: string;
    source: string;
    strength: string;
    batch: string;
    note: string;
    reports: number;
  };
  after: {
    title: string;
    source: string;
    strength: string;
    batch: string;
    note: string;
    reports: number;
  };
  createdAt: string;
}

/** 已发布版本的单信号读数。台账、批次、趋势三处都从这里取数 */
export interface SignalReading {
  signalId: string;
  reportCount: number;
  exposedUnits: number;
  occurrenceRate: number;
  affectedBatches: string[];
  /** 该读数依据的证据 id 列表，复核时可还原当时依据 */
  evidenceBasis: string[];
}

export interface TrendPoint {
  label: string;
  value: number;
  threshold: number;
}

/** 已发布的完整读数版本，三处读数共用同一版本号，保证一致换版 */
export interface ReadModel {
  version: number;
  publishedAt: string;
  signals: SignalReading[];
  trends: {
    pumpOcclusion: TrendPoint[];
  };
}

export type StageState = 'pending' | 'running' | 'done' | 'failed';

export interface RecalcStageRecord {
  state: StageState;
  attempts: number;
  updatedAt: string | null;
  /** 本阶段重算产出的候选读数（存档成功后写入，未完成部分可续算） */
  output: unknown | null;
  lastError: string | null;
}

export type RecalcJobState =
  | 'running'
  | 'awaiting_confirmation'
  | 'confirmed'
  | 'superseded';

export interface RecalcJob {
  id: string;
  signalId: string;
  state: RecalcJobState;
  /** 发起重算的窗口（会话）id，单例判定与执行租约的依据 */
  ownerSession: string;
  /** 后到窗口（含模拟的第二窗口）并入同一作业的记录 */
  joinedSessions: Array<{ session: string; label: string; at: string }>;
  submittedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** 执行租约到期时间：持有窗口用心跳续租，过期后其他窗口可接管续算 */
  leaseUntil?: string;
  stages: Record<RecalcStage, RecalcStageRecord>;
  /** 三阶段全部存档成功后的候选完整结果，等待复核人确认 */
  candidate: {
    reading: SignalReading;
    trends: TrendPoint[];
    evidenceBasis: string[];
  } | null;
  archivedAttempts: number;
  /** 触发本次重算的证据更正 */
  correction: EvidenceCorrection;
}

/** 读数失效登记：证据更正后，受影响信号的旧读数标记失效，但旧版本继续展示 */
export interface Invalidation {
  signalId: string;
  invalidatedAt: string;
  actor: string;
  reason: string;
  evidenceId: string;
  /** 失效时仍在展示的旧版本号，页面据此标明"上一版完整结果、重算未完成" */
  staleFromVersion: number;
  jobId: string;
}

export interface ConfirmedChange {
  job: RecalcJob;
  previousModel: ReadModel;
  newModel: ReadModel;
  previousReading: SignalReading;
  newReading: SignalReading;
}

export const correctEvidenceSchema = z.object({
  id: z.string().min(1),
  evidenceId: z.string().min(1),
  title: z.string().trim().min(4, '证据名称至少 4 个字符'),
  source: z.string().trim().min(2, '请填写来源'),
  strength: z.enum(['strong', 'moderate', 'weak', 'contrary']),
  batch: z.string().trim().min(1, '请填写关联批号'),
  note: z.string().trim().min(4, '请填写核查说明'),
  reports: z.coerce
    .number({ message: '归因报告数需为 0 及以上的整数' })
    .int('归因报告数需为整数')
    .min(0, '归因报告数不能为负')
    .max(9999),
  actor: z.string().trim().min(2, '请填写操作人'),
  reason: z.string().trim().min(6, '请填写更正依据（至少 6 个字符），说明旧记录为何错误')
});

export const confirmReadingSchema = z.object({
  signalId: z.string().min(1),
  jobId: z.string().min(1),
  reviewer: z.string().trim().min(2, '请填写复核人'),
  note: z
    .string()
    .trim()
    .min(6, '请填写复核确认依据（至少 6 个字符），说明接受新版本读数的理由')
});

export type CorrectEvidenceInput = z.infer<typeof correctEvidenceSchema>;
export type ConfirmReadingInput = z.infer<typeof confirmReadingSchema>;
