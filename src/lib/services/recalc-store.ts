import { canUseBrowser } from './browser-env';
import { get, writable } from 'svelte/store';
import type { SignalCase } from '$lib/models/signal';
import type {
  ConfirmedChange,
  EvidenceCorrection,
  Invalidation,
  ReadModel,
  RecalcJob,
  RecalcStage,
  SignalReading,
  TrendPoint
} from '$lib/models/recalc';
import { recalcStages } from '$lib/models/recalc';
import { buildInitialReadModel, computePumpTrend, computeSignalReading, isPumpSignal } from './recalc-compute';
import { seedSignals } from './seed';
import { signalStore } from '$lib/stores/signal-store';

const READ_MODEL_KEY = 'medical-safety-readmodel-v2';
const JOBS_KEY = 'medical-safety-recalc-jobs-v2';
const INVALIDATIONS_KEY = 'medical-safety-invalidations-v2';
const FAILURES_KEY = 'medical-safety-recalc-failures-v2';
const SESSION_KEY = 'medical-safety-recalc-session-v2';

const STAGE_DELAY_MS = 420;
const RETRY_DELAY_MS = 1100;
const LEASE_MS = 3000;
const HEARTBEAT_MS = 1500;
const MAX_KEPT_JOBS = 10;

function nowIso(): string {
  return new Date().toISOString();
}

function makeId(prefix: string): string {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36)}`;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function currentSession(): string {
  if (!canUseBrowser()) return 'ssr-session';
  let id = sessionStorage.getItem(SESSION_KEY);
  if (!id) {
    id = `WIN-${makeId('s').slice(-8)}`;
    sessionStorage.setItem(SESSION_KEY, id);
  }
  return id;
}
export const sessionId = currentSession();

export function sessionLabel(session: string = sessionId): string {
  return session === sessionId ? `本窗口 ${session.slice(-4)}` : `另一窗口 ${session.slice(-4)}`;
}

/* ------------------------------------------------------------------ */
/* 持久化：显式写入，可注入存档失败；心跳等原始写入不经过故障注入        */
/* ------------------------------------------------------------------ */

function rawRead<T>(key: string, fallback: T): T {
  if (!canUseBrowser()) return fallback;
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function rawWrite(key: string, value: unknown): void {
  if (!canUseBrowser()) return;
  // 心跳/接管写入不走故障注入；配额等异常由调用方决定是否忽略
  localStorage.setItem(key, JSON.stringify(value));
}

/** 模拟存档失败：接下来 n 次"正式存档"写入会失败，之后自动恢复 */
export function injectArchiveFailures(n: number): void {
  if (!canUseBrowser()) return;
  localStorage.setItem(FAILURES_KEY, String(Math.max(0, n)));
}

function failureRemaining(): number {
  if (!canUseBrowser()) return 0;
  return Number(localStorage.getItem(FAILURES_KEY) ?? 0) || 0;
}

/** 正式存档：若仍有注入的失败次数则抛出（消费一次），由作业循环捕获并重试 */
function guardedWrite(key: string, value: unknown): void {
  if (!canUseBrowser()) return;
  const remaining = failureRemaining();
  if (remaining > 0) {
    localStorage.setItem(FAILURES_KEY, String(remaining - 1));
    throw new Error('ARCHIVE_FAILED');
  }
  localStorage.setItem(key, JSON.stringify(value));
}

/* ------------------------------------------------------------------ */
/* Stores：内存是当前窗口的工作视图，localStorage 是跨窗口共享的存档    */
/* ------------------------------------------------------------------ */

const readModelStore = writable<ReadModel>(buildInitialReadModel(seedSignals));
const jobsStore = writable<RecalcJob[]>([]);
const invalidationsStore = writable<Invalidation[]>([]);

export const readModel = { subscribe: readModelStore.subscribe };
export const recalcJobs = { subscribe: jobsStore.subscribe };
export const recalcInvalidations = { subscribe: invalidationsStore.subscribe };

function persistReadModel(): void {
  guardedWrite(READ_MODEL_KEY, get(readModelStore));
}
function persistJobs(): void {
  guardedWrite(JOBS_KEY, get(jobsStore));
}
function persistInvalidations(): void {
  guardedWrite(INVALIDATIONS_KEY, get(invalidationsStore));
}

/**
 * 存档失败后的统一策略：内存保留现场（旧已发布版本不变、阶段进度不丢），
 * 按间隔重试，未完成的阶段接着算。
 */
async function withArchiveRetry(apply: () => void, onFailure?: (attempts: number) => void): Promise<void> {
  let attempts = 0;
  for (;;) {
    try {
      apply();
      return;
    } catch (error) {
      if ((error as Error)?.message !== 'ARCHIVE_FAILED') throw error;
      attempts += 1;
      onFailure?.(attempts);
      await wait(RETRY_DELAY_MS);
    }
  }
}

/* ------------------------------------------------------------------ */
/* 初始化与跨窗口同步                                                   */
/* ------------------------------------------------------------------ */

let initialized = false;
const localRunners = new Set<string>();

function hydrate(): void {
  if (!canUseBrowser() || initialized) return;
  initialized = true;

  const persistedModel = rawRead<ReadModel | null>(READ_MODEL_KEY, null);
  if (persistedModel) readModelStore.set(persistedModel);
  jobsStore.set(rawRead<RecalcJob[]>(JOBS_KEY, []));
  invalidationsStore.set(rawRead<Invalidation[]>(INVALIDATIONS_KEY, []));

  // 新载入的窗口发现卡住（租约过期）的作业时自动接管，未完成部分续算
  window.addEventListener('storage', (event) => {
    if (event.storageArea !== window.localStorage) return;
    if (event.key === READ_MODEL_KEY && event.newValue) {
      readModelStore.set(JSON.parse(event.newValue) as ReadModel);
    } else if (event.key === JOBS_KEY && event.newValue) {
      jobsStore.set(JSON.parse(event.newValue) as RecalcJob[]);
    } else if (event.key === INVALIDATIONS_KEY && event.newValue) {
      invalidationsStore.set(JSON.parse(event.newValue) as Invalidation[]);
    } else if (event.key === null) {
      // localStorage 被整体清空（例如重置），回到初始版本
      readModelStore.set(buildInitialReadModel(seedSignals));
      jobsStore.set([]);
      invalidationsStore.set([]);
    }
  });

  // 心跳 + 租约接管：本窗口执行中的作业续租；发现无主/过期作业则接管
  window.setInterval(tick, HEARTBEAT_MS);
  // 启动时立即巡检一次（页面刷新后作业自动续算）
  void tick();
}

function leaseExpired(job: RecalcJob): boolean {
  if (job.state !== 'running') return false;
  const leaseUntil = (job as RecalcJob & { leaseUntil?: string }).leaseUntil;
  return !leaseUntil || leaseUntil <= nowIso();
}

async function tick(): Promise<void> {
  if (!canUseBrowser()) return;
  const jobs = get(jobsStore);
  for (const job of jobs) {
    if (job.state !== 'running') continue;
    const lease = (job as RecalcJob & { leaseUntil?: string }).leaseUntil;
    if (job.ownerSession === sessionId) {
      // 本窗口持有租约：心跳延长租约（原始写入，不消费注入的存档失败次数）
      jobsStore.update((list) =>
        list.map((item) =>
          item.id === job.id && item.state === 'running'
            ? { ...item, leaseUntil: new Date(Date.now() + LEASE_MS).toISOString() }
            : item
        )
      );
      try {
        rawWrite(JOBS_KEY, get(jobsStore));
      } catch {
        /* 心跳写入失败不影响内存作业，下一拍再试 */
      }
    } else if (!localRunners.has(job.id) && leaseExpired(job)) {
      // 原窗口关闭/卡住：接管未完成作业并续算
      claimJob(job.id);
    }
  }
}

function claimJob(jobId: string): void {
  const signalId = get(jobsStore).find((job) => job.id === jobId)?.signalId;
  if (!signalId) return;
  jobsStore.update((jobs) =>
    jobs.map((job) =>
      job.id === jobId && job.state === 'running'
        ? {
            ...job,
            ownerSession: sessionId,
            joinedSessions: [
              ...job.joinedSessions,
              { session: sessionId, label: `${sessionLabel()}（接管续算）`, at: nowIso() }
            ],
            leaseUntil: new Date(Date.now() + LEASE_MS).toISOString()
          }
        : job
    )
  );
  try {
    rawWrite(JOBS_KEY, get(jobsStore));
  } catch {
    /* 忽略：由阶段存档统一重试 */
  }
  void resolveAndRun(jobId, signalId);
}

/** 本地执行前确认作业仍归本窗口；另一窗口已接管则停止本地循环 */
function stillOwned(jobId: string): boolean {
  const persisted = rawRead<RecalcJob[]>(JOBS_KEY, []);
  const job = persisted.find((item) => item.id === jobId);
  return !!job && job.state === 'running' && job.ownerSession === sessionId;
}

/* ------------------------------------------------------------------ */
/* 作业执行：受影响信号 → 批次覆盖 → 趋势核对，逐阶段存档、失败续算     */
/* ------------------------------------------------------------------ */

type StageOutput =
  | { kind: 'signals'; reading: SignalReading }
  | { kind: 'batches'; batches: string[] }
  | { kind: 'trends'; trends: TrendPoint[] };

async function resolveAndRun(jobId: string, signalId: string): Promise<void> {
  // 阶段重算需要最新台账（更正后的证据）；循环依赖只在函数运行时解析
  const signal = signalStore.getSnapshot().find((item) => item.id === signalId);
  if (signal) await runJob(jobId, signal);
}

async function runJob(jobId: string, signal: SignalCase): Promise<void> {
  if (localRunners.has(jobId)) return;
  localRunners.add(jobId);
  try {
    for (const stage of recalcStages) {
      await runStage(jobId, stage, signal);
      if (!stillOwned(jobId)) return; // 已被另一窗口接管
    }
    await archiveCandidate(jobId, signal);
  } finally {
    localRunners.delete(jobId);
  }
}

function patchStage(jobId: string, stage: RecalcStage, patch: Partial<RecalcJob['stages'][RecalcStage]>): void {
  jobsStore.update((jobs) =>
    jobs.map((job) =>
      job.id === jobId
        ? { ...job, stages: { ...job.stages, [stage]: { ...job.stages[stage], ...patch } } }
        : job
    )
  );
}

async function runStage(jobId: string, stage: RecalcStage, signal: SignalCase): Promise<void> {
  for (;;) {
    if (!stillOwned(jobId)) return;
    const job = get(jobsStore).find((item) => item.id === jobId);
    if (!job || job.state !== 'running') return;
    if (job.stages[stage].state === 'done' && job.stages[stage].output) return; // 已存档，续算时跳过

    patchStage(jobId, stage, {
      state: 'running',
      attempts: job.stages[stage].attempts + 1,
      lastError: null
    });
    touchLease(jobId);
    await wait(STAGE_DELAY_MS); // 模拟阶段计算耗时
    if (!stillOwned(jobId)) return;

    const output: StageOutput =
      stage === 'signals'
        ? { kind: 'signals', reading: computeSignalReading(signal) }
        : stage === 'batches'
          ? {
              kind: 'batches',
              batches: Array.from(
                new Set([
                  signal.batch,
                  ...signal.affectedBatches,
                  ...signal.evidence.map((item) => item.batch)
                ])
              ).sort()
            }
          : {
              kind: 'trends',
              trends: isPumpSignal(signal)
                ? computePumpTrend(get(readModelStore).trends.pumpOcclusion, computeSignalReading(signal))
                : get(readModelStore).trends.pumpOcclusion.map((point) => ({ ...point }))
            };

    // 阶段存档：失败时保留上一版已发布结果，标记本阶段失败并继续重试
    let archived = false;
    await withArchiveRetry(
      () => {
        jobsStore.update((jobs) =>
          jobs.map((item) => {
            if (item.id !== jobId) return item;
            const updatedStage = {
              ...item.stages[stage],
              state: 'done' as const,
              updatedAt: nowIso(),
              lastError: null,
              output
            };
            return {
              ...item,
              leaseUntil: new Date(Date.now() + LEASE_MS).toISOString(),
              stages: { ...item.stages, [stage]: updatedStage }
            };
          })
        );
        persistJobs();
        archived = true;
      },
      (attempts) => {
        patchStage(jobId, stage, {
          state: 'failed',
          lastError: `存档失败（第 ${attempts} 次重试），上一版结果继续有效`
        });
      }
    );
    if (archived) return;
  }
}

function touchLease(jobId: string): void {
  jobsStore.update((jobs) =>
    jobs.map((job) =>
      job.id === jobId
        ? { ...job, leaseUntil: new Date(Date.now() + LEASE_MS).toISOString() }
        : job
    )
  );
}

/** 三阶段全部存档成功后，汇总候选完整结果；存档失败则重试，未完成部分不丢 */
async function archiveCandidate(jobId: string, signal: SignalCase): Promise<void> {
  for (;;) {
    if (!stillOwned(jobId)) return;
    const job = get(jobsStore).find((item) => item.id === jobId);
    if (!job || job.state !== 'running') return;
    if (job.candidate) return; // 候选已汇总（通常已转待确认），不重复归档

    const signalsOutput = job.stages.signals.output as StageOutput | null;
    const trendsOutput = job.stages.trends.output as StageOutput | null;
    if (
      !signalsOutput ||
      signalsOutput.kind !== 'signals' ||
      !trendsOutput ||
      trendsOutput.kind !== 'trends'
    ) {
      return; // 阶段未完成（不应发生），由下一拍续算
    }

    let archived = false;
    await withArchiveRetry(
      () => {
        jobsStore.update((jobs) =>
          jobs.map((item) =>
            item.id === jobId
              ? {
                  ...item,
                  state: 'awaiting_confirmation',
                  finishedAt: nowIso(),
                  archivedAttempts: item.archivedAttempts + 1,
                  leaseUntil: undefined,
                  candidate: {
                    reading: signalsOutput.reading,
                    trends: trendsOutput.trends,
                    evidenceBasis: signal.evidence.map((item) => item.id)
                  }
                }
              : item
          )
        );
        persistJobs();
        archived = true;
      },
      (attempts) => {
        jobsStore.update((jobs) =>
          jobs.map((item) =>
            item.id === jobId
              ? {
                  ...item,
                  archivedAttempts: attempts,
                  stages: {
                    ...item.stages,
                    trends: {
                      ...item.stages.trends,
                      state: 'failed',
                      lastError: `候选结果存档失败（第 ${attempts} 次重试），上一版结果继续有效`
                    }
                  }
                }
              : item
          )
        );
      }
    );
    if (archived) return;
  }
}

/* ------------------------------------------------------------------ */
/* 提交重算：同一信号只受理一个作业，后到窗口并入现有作业               */
/* ------------------------------------------------------------------ */

export interface SubmitRecalcResult {
  outcome: 'started' | 'joined' | 'superseded';
  job: RecalcJob;
}

export async function submitRecalc(
  signal: SignalCase,
  correction: EvidenceCorrection,
  options: { clientSession?: string; clientLabel?: string } = {}
): Promise<SubmitRecalcResult> {
  hydrate();
  const clientSession = options.clientSession ?? sessionId;
  const clientLabel = options.clientLabel ?? sessionLabel(clientSession);

  // 1) 决策只做一次：基于当前存档决定"受理 / 并入 / 作废旧候选后受理"
  const decision = (() => {
    const jobs = get(jobsStore);
    const running = jobs.find(
      (job) => job.signalId === signal.id && (job.state === 'running' || job.state === 'awaiting_confirmation')
    );
    if (running && running.state === 'running') {
      const alreadyJoined =
        running.ownerSession === clientSession ||
        running.joinedSessions.some((entry) => entry.session === clientSession);
      return {
        kind: 'joined' as const,
        jobId: running.id,
        addSession: !alreadyJoined
      };
    }
    // 固定 id：存档失败重试时不会产生第二个作业/失效登记
    const newJobId = makeId('JOB');
    return {
      kind: running ? 'superseded' as const : 'started' as const,
      jobId: newJobId,
      supersededJobId: running?.id,
      staleFromVersion: get(readModelStore).version
    };
  })();

  // 2) 幂等应用 + 持久化：重试时根据 id 判断，绝不重复受理或重复并入
  await withArchiveRetry(() => {
    const ts = nowIso();
    if (decision.kind === 'joined') {
      if (decision.addSession) {
        let applied = false;
        jobsStore.update((list) =>
          list.map((job) => {
            if (job.id !== decision.jobId) return job;
            if (job.joinedSessions.some((entry) => entry.session === clientSession)) return job;
            applied = true;
            return {
              ...job,
              joinedSessions: [...job.joinedSessions, { session: clientSession, label: clientLabel, at: ts }]
            };
          })
        );
        if (applied) persistJobs();
      }
      return;
    }

    const job: RecalcJob = {
      id: decision.jobId,
      signalId: signal.id,
      state: 'running',
      ownerSession: clientSession,
      joinedSessions: [{ session: clientSession, label: clientLabel, at: ts }],
      submittedAt: ts,
      startedAt: ts,
      finishedAt: null,
      leaseUntil: new Date(Date.now() + LEASE_MS).toISOString(),
      stages: {
        signals: { state: 'pending', attempts: 0, updatedAt: null, output: null, lastError: null },
        batches: { state: 'pending', attempts: 0, updatedAt: null, output: null, lastError: null },
        trends: { state: 'pending', attempts: 0, updatedAt: null, output: null, lastError: null }
      },
      candidate: null,
      archivedAttempts: 0,
      correction
    };

    const invalidation: Invalidation = {
      signalId: signal.id,
      invalidatedAt: ts,
      actor: correction.actor,
      reason: correction.reason,
      evidenceId: correction.evidenceId,
      staleFromVersion: decision.staleFromVersion,
      jobId: decision.jobId
    };

    // 两份存档都按固定 id 幂等写入：第一次若在半途失败，重试只会补齐而不是重复建单
    const persistJobsIdempotent = () => {
      const withNew = capJobs([
        job,
        ...get(jobsStore)
          .filter((item) => item.id !== decision.jobId)
          .map((item) =>
            item.id === decision.supersededJobId
              ? { ...item, state: 'superseded' as const, finishedAt: ts }
              : item
          )
      ]);
      jobsStore.set(withNew);
      persistJobs();
    };
    const persistInvalidationsIdempotent = () => {
      invalidationsStore.set([
        invalidation,
        ...get(invalidationsStore).filter((item) => item.signalId !== signal.id)
      ]);
      persistInvalidations();
    };
    persistJobsIdempotent();
    persistInvalidationsIdempotent();
  });

  const job = get(jobsStore).find((item) => item.id === decision.jobId);
  if (!job) throw new Error('重算作业创建失败');

  // runJob 入口自带 localRunners 去重，这里直接启动（成功受理才执行）
  if (decision.kind !== 'joined') {
    void runJob(job.id, signal);
  }
  return { outcome: decision.kind, job };
}

function capJobs(jobs: RecalcJob[]): RecalcJob[] {
  const kept = [...jobs];
  while (kept.length > MAX_KEPT_JOBS) {
    const oldestIndex = kept.reduce(
      (oldest, job, index) =>
        job.state === 'confirmed' || job.state === 'superseded'
          ? (oldest === -1 || kept[oldest].submittedAt > job.submittedAt ? index : oldest)
          : oldest,
      -1
    );
    if (oldestIndex === -1) break;
    kept.splice(oldestIndex, 1);
  }
  return kept;
}

/* ------------------------------------------------------------------ */
/* 复核确认：三处读数一起换版，留下前后依据                             */
/* ------------------------------------------------------------------ */

export async function confirmCandidate(
  signalId: string,
  jobId: string
): Promise<ConfirmedChange> {
  hydrate();

  // 目标状态只计算一次，存档失败重试时重复应用同一份结果（幂等换版）
  const previousModel = get(readModelStore);
  const job = get(jobsStore).find((item) => item.id === jobId && item.signalId === signalId);
  if (!job) throw new Error('JOB_NOT_FOUND');

  const previousReading: SignalReading =
    previousModel.signals.find((item) => item.signalId === signalId) ?? {
      signalId,
      reportCount: 0,
      exposedUnits: 0,
      occurrenceRate: 0,
      affectedBatches: [],
      evidenceBasis: []
    };

  const newModel: ReadModel = {
    version: previousModel.version + 1,
    publishedAt: nowIso(),
    signals: [
      ...previousModel.signals.filter((item) => item.signalId !== signalId),
      ...(job.candidate ? [job.candidate.reading] : [])
    ].sort((a, b) => a.signalId.localeCompare(b.signalId)),
    trends: { pumpOcclusion: job.candidate?.trends ?? previousModel.trends.pumpOcclusion }
  };
  const confirmedJob: RecalcJob = {
    ...job,
    state: 'confirmed',
    finishedAt: job.finishedAt ?? newModel.publishedAt,
    leaseUntil: undefined
  };

  let change: ConfirmedChange | null = null;

  await withArchiveRetry(() => {
    // 重试时作业可能已在内存中转为 confirmed：这是同一次换版的补齐存档，不是新版本
    const currentJob = get(jobsStore).find((item) => item.id === jobId);
    const alreadyApplied =
      currentJob?.state === 'confirmed' ||
      get(readModelStore).signals.find((item) => item.signalId === signalId)?.reportCount ===
        newModel.signals.find((item) => item.signalId === signalId)?.reportCount &&
        get(readModelStore).version === newModel.version;

    if (currentJob?.state !== 'confirmed' && currentJob?.state !== 'awaiting_confirmation') {
      throw new Error('JOB_NOT_READY');
    }

    readModelStore.set(newModel);
    jobsStore.set(
      capJobs(
        get(jobsStore).map((item) =>
          item.id === jobId
            ? { ...item, state: 'confirmed' as const, finishedAt: confirmedJob.finishedAt, leaseUntil: undefined }
            : item
        )
      )
    );
    invalidationsStore.set(
      get(invalidationsStore).filter((item) => item.signalId !== signalId)
    );

    // 三处存档逐个写：中途失败后重试补齐，已写的保持同值，不会再升一个版本
    persistReadModel();
    persistJobs();
    persistInvalidations();

    if (!alreadyApplied && !job.candidate) throw new Error('JOB_NOT_READY');
    change = {
      job: confirmedJob,
      previousModel,
      newModel,
      previousReading,
      newReading: job.candidate!.reading
    };
  });

  return change!;
}

/* ------------------------------------------------------------------ */
/* 查询辅助                                                             */
/* ------------------------------------------------------------------ */

/** 演示用：模拟另一窗口对同一信号提交重算，应并入现有作业而不是重复受理 */
export async function simulateConcurrentSubmit(
  signalId: string
): Promise<{ outcome: 'joined' | 'idle'; jobId?: string }> {
  hydrate();
  const otherSession = `WIN-${makeId('x').slice(-8)}`;
  const running = get(jobsStore).find(
    (job) => job.signalId === signalId && (job.state === 'running' || job.state === 'awaiting_confirmation')
  );
  if (!running) return { outcome: 'idle' };

  await withArchiveRetry(() => {
    jobsStore.update((list) =>
      list.map((job) =>
        job.id === running.id &&
        !job.joinedSessions.some((entry) => entry.session === otherSession)
          ? {
              ...job,
              joinedSessions: [
                ...job.joinedSessions,
                { session: otherSession, label: sessionLabel(otherSession), at: nowIso() }
              ]
            }
          : job
      )
    );
    persistJobs();
  });
  return { outcome: 'joined', jobId: running.id };
}

export function getActiveJob(signalId: string): RecalcJob | undefined {
  return get(jobsStore).find(
    (job) => job.signalId === signalId && (job.state === 'running' || job.state === 'awaiting_confirmation')
  );
}

/**
 * 预判本次提交的受理结果，不产生任何写入：
 * - 'joined'：已有在途作业，本次只并入，调用方不应再次修改证据
 * - 'started' / 'superseded'：本次会受理新作业，调用方应先落证据更正
 */
export function peekSubmitDecision(signalId: string): 'joined' | 'started' | 'superseded' {
  hydrate();
  const active = getActiveJob(signalId);
  if (active?.state === 'running') return 'joined';
  return active?.state === 'awaiting_confirmation' ? 'superseded' : 'started';
}

export function getInvalidation(signalId: string): Invalidation | undefined {
  return get(invalidationsStore).find((item) => item.signalId === signalId);
}

/** 台账/批次/趋势三处统一取数：取已发布版本中该信号的读数 */
export function getPublishedReading(signalId: string): SignalReading | undefined {
  return get(readModelStore).signals.find((item) => item.signalId === signalId);
}

hydrate();
