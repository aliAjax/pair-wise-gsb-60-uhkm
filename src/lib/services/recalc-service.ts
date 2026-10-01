import type { RecalcJob, RecalcPhase, SignalCase } from '$lib/models/signal';
import { signalStore } from '$lib/stores/signal-store';
import { activeReadings, buildCandidateReadings, phaseOrder } from '$lib/services/readings';

/** 运行时能力检测：重算依赖 localStorage/锁等浏览器能力，SSR 阶段直接跳过 */
const isBrowser = (): boolean => typeof window !== 'undefined';

/**
 * 重算编排（可恢复流水线）：
 * 证据更正 -> 受影响读数失效 -> 台账读数 / 批次覆盖 / 趋势核对 / 版本存档逐检查点重算
 * -> 复核人确认 -> 三处一起换版。
 *
 * 并发：同一信号全窗口只受理一个作业（Web Locks 互斥；无该 API 时以持久化作业表兜底），
 * 后到提交登记到 job.attached 后并入等待，不重复计算。
 * 恢复：检查点与候选读数先落 localStorage；存档失败保留上一版结果并退避重试，
 * 只重试存档；刷新页面后扫描未完成作业，从最后一个检查点续算。
 */

const PHASE_DURATION_MS: Record<RecalcPhase, number> = {
  ledger: 700,
  batches: 700,
  trends: 800,
  archive: 0
};
const ARCHIVE_BACKOFF_MS = 1200;
/** 演示用确定性存档故障：每个作业前两次存档失败、第三次成功 */
const ARCHIVE_FAILURES = 2;
const POLL_INTERVAL_MS = 400;
const MAX_WAIT_POLLS = 600;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function clientId(): string {
  if (!isBrowser()) return 'server';
  const key = 'medical-safety-client-id';
  let id = sessionStorage.getItem(key);
  if (!id) {
    const rand = Math.floor(Math.random() * 100000).toString(36);
    id = `窗口-${rand}`;
    sessionStorage.setItem(key, id);
  }
  return id;
}

/** 当前窗口正在执行的作业（同窗口并发提交直接并入） */
const localRuns = new Map<string, Promise<RecalcJob | undefined>>();

function activeJob(signal: SignalCase): RecalcJob | undefined {
  const job = signal.recalcJob;
  if (!job || job.status === 'superseded') return undefined;
  return job;
}

function recordAudit(signalId: string, actor: string, action: string, detail: string) {
  signalStore.addAudit(signalId, {
    id: `AUD-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    actor,
    action,
    detail,
    createdAt: new Date().toISOString()
  });
}

function isStale(signalId: string, jobId: string, generation: number): boolean {
  const signal = signalStore.getSnapshot().find((item) => item.id === signalId);
  const job = signal?.recalcJob;
  return !signal || !job || job.id !== jobId || job.generation !== generation || job.status === 'superseded';
}

function completePhase(signalId: string, jobId: string, generation: number, phase: RecalcPhase): void {
  signalStore.updateRecalcJob(signalId, jobId, (job) => {
    if (job.generation !== generation) return;
    if (!job.completedPhases.includes(phase)) job.completedPhases.push(phase);
    if (phase === 'trends') {
      const signal = signalStore.getSnapshot().find((item) => item.id === signalId);
      if (signal) {
        // 候选读数在此冻结；复核确认前三处页面仍展示上一版
        job.candidate = buildCandidateReadings(signal, activeReadings(signal));
      }
    }
    job.status = 'running';
  });
}

async function attemptArchive(signalId: string, generation: number): Promise<void> {
  const job = signalStore.getRecalcJob(signalId);
  if (!job) return;
  const attempt = job.archiveAttempts + 1;
  const currentVersion = signalStore.getSnapshot().find((s) => s.id === signalId)?.readings.version;

  if (attempt <= ARCHIVE_FAILURES) {
    // 存档失败：候选版本留在作业里，上一版已确认读数原样不动
    signalStore.updateRecalcJob(signalId, job.id, (j) => {
      if (j.generation !== generation) return;
      j.archiveAttempts = attempt;
      j.status = 'archive_retrying';
      j.lastError = `存档服务暂不可用（第 ${attempt}/${ARCHIVE_FAILURES + 1} 次尝试失败），上一版完整结果继续可用，将自动退避重试存档。`;
    });
    recordAudit(
      signalId,
      '重算流水线',
      '存档失败保留旧结果',
      `作业 ${job.id} 第 ${attempt} 次存档失败：台账、批次追踪、趋势核对继续显示 V${currentVersion} 上一版完整结果；` +
        `候选版本与已完成检查点已保留，${ARCHIVE_BACKOFF_MS}ms 后仅重试未完成的存档步骤。`
    );
    return;
  }

  signalStore.updateRecalcJob(signalId, job.id, (j) => {
    if (j.generation !== generation) return;
    j.archiveAttempts = attempt;
    j.lastError = undefined;
    if (!j.completedPhases.includes('archive')) j.completedPhases.push('archive');
    j.status = 'awaiting_review';
  });
  const candidate = signalStore.getRecalcJob(signalId)?.candidate;
  recordAudit(
    signalId,
    '重算流水线',
    '重算存档完成待复核',
    `作业 ${job.id} 第 ${attempt} 次存档成功，候选 V${candidate?.version ?? '?'} 已冻结，等待复核人确认；` +
      `确认前三处继续展示上一版结果。新版取数依据：${candidate?.basis ?? ''}`
  );
}

async function runJob(signalId: string, initialJob: RecalcJob): Promise<RecalcJob | undefined> {
  for (;;) {
    const current = signalStore.getRecalcJob(signalId);
    if (!current || current.status === 'superseded') return current;
    if (current.status === 'awaiting_review') return current;

    const { id: jobId, generation } = current;

    // 跳过已完成检查点：刷新或存档失败后从断点续算，未完成部分接着算
    for (const phase of phaseOrder) {
      if (isStale(signalId, jobId, generation)) break;
      const fresh = signalStore.getRecalcJob(signalId);
      if (!fresh || fresh.completedPhases.includes(phase)) continue;

      if (phase !== 'archive') {
        await wait(PHASE_DURATION_MS[phase]);
        if (isStale(signalId, jobId, generation)) break;
        completePhase(signalId, jobId, generation, phase);
        const label = phase === 'ledger' ? '台账读数' : phase === 'batches' ? '批次覆盖' : '趋势核对';
        recordAudit(
          signalId,
          '重算流水线',
          '重算检查点完成',
          `作业 ${jobId} 完成「${label}」检查点；复核确认前三处页面继续展示上一版完整读数。`
        );
      } else {
        await attemptArchive(signalId, generation);
        if (isStale(signalId, jobId, generation)) break;
        const retrying = signalStore.getRecalcJob(signalId);
        if (retrying?.status === 'archive_retrying') {
          await wait(ARCHIVE_BACKOFF_MS);
          if (isStale(signalId, jobId, generation)) break;
          // 下一轮循环只重试 archive
        }
      }
    }

    const after = signalStore.getRecalcJob(signalId);
    if (!after || after.status === 'awaiting_review' || after.status === 'superseded') return after;
    if (after.generation !== generation) continue; // 证据被再次更正：旧回合作废，从头重算
    if (after.status === 'archive_retrying') continue;
    return after;
  }
}

async function waitForJobCompletion(signalId: string, jobId: string): Promise<RecalcJob | undefined> {
  // storage 事件会驱动 store 刷新，轮询仅作跨环境兜底
  for (let i = 0; i < MAX_WAIT_POLLS; i++) {
    await wait(POLL_INTERVAL_MS);
    const job = signalStore.getRecalcJob(signalId);
    if (!job || job.id !== jobId || job.status === 'awaiting_review' || job.status === 'superseded') {
      return job;
    }
  }
  return signalStore.getRecalcJob(signalId);
}

/**
 * 立即尝试持有跨窗口锁并在持锁期间执行 task。
 * 返回 null 表示锁被另一窗口持有。
 */
function withRecalcLock<T>(
  signalId: string,
  task: () => Promise<T>
): Promise<{ acquired: true; value: T } | { acquired: false }> {
  const locks = (navigator as Navigator & { locks?: LockManager }).locks;
  if (!locks?.request) {
    // 无 Web Locks 环境：退化为持久化作业表去重（其他窗口的 storage 同步可见）
    return task().then((value) => ({ acquired: true, value }));
  }
  return new Promise((resolve, reject) => {
    locks
      .request(`medical-safety-recalc:${signalId}`, { ifAvailable: true }, async () => {
        return task();
      })
      .then(
        (value) => {
          if (value === null) resolve({ acquired: false });
          else resolve({ acquired: true, value: value as T });
        },
        (error) => reject(error)
      );
  });
}

export interface RecalcRequestResult {
  job?: RecalcJob;
  /** true = 本次提交并入了已有作业（另一窗口或本窗口正在算），未重复受理 */
  joined: boolean;
}

/**
 * 发起或并入某信号的重算。
 * 证据更正后 store 中已有 running 作业；手动入口可 createIfNone 补建。
 */
export async function requestRecalculation(
  signalId: string,
  options: { by?: string; reason?: string; createIfNone?: boolean } = {}
): Promise<RecalcRequestResult> {
  if (!isBrowser()) return { joined: false };
  const by = options.by ?? clientId();

  const local = localRuns.get(signalId);
  if (local) {
    const job = signalStore.getRecalcJob(signalId);
    if (job) signalStore.attachRecalcJob(signalId, job.id, by);
    return { job: await local, joined: true };
  }

  let job = signalStore
    .getSnapshot()
    .map((s) => activeJob(s))
    .find((j): j is RecalcJob => Boolean(j && j.signalId === signalId));

  if (!job && options.createIfNone) {
    const timestamp = new Date().toISOString();
    const jobId = `JOB-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    signalStore.addAudit(signalId, {
      id: `AUD-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      actor: by,
      action: '请求重算',
      detail: options.reason ?? '人工发起读数重算。',
      createdAt: timestamp
    });
    signalStore.ensureRecalcJob(signalId, {
      id: jobId,
      signalId,
      generation: 1,
      status: 'running',
      completedPhases: [],
      reason: options.reason ?? '人工发起读数重算。',
      requestedBy: by,
      startedAt: timestamp,
      updatedAt: timestamp,
      archiveAttempts: 0,
      attached: [],
      correctionIds: []
    });
    job = signalStore.getRecalcJob(signalId);
  }

  if (!job) return { joined: false };
  if (job.status === 'awaiting_review') return { job, joined: true };

  const result = await withRecalcLock(signalId, () => {
    const run = runJob(signalId, job as RecalcJob).finally(() => localRuns.delete(signalId));
    localRuns.set(signalId, run);
    return run;
  });

  if (!result.acquired) {
    // 后到窗口：接到现有作业（登记并入），等待持锁窗口的结果，不重复受理
    signalStore.attachRecalcJob(signalId, job.id, by);
    recordAudit(
      signalId,
      by,
      '重算提交并入',
      `另一窗口正在执行作业 ${job.id}，本次提交不重复受理，已并入现有作业并等待结果。`
    );
    return { job: await waitForJobCompletion(signalId, job.id), joined: true };
  }

  return { job: result.value, joined: false };
}

/** 页面加载后恢复：所有未完成作业从最后一个检查点续算，上一版读数继续展示 */
export function resumeUnfinishedJobs(): void {
  if (!isBrowser()) return;
  const pending = signalStore
    .getSnapshot()
    .flatMap((signal) =>
      signal.recalcJob &&
      (signal.recalcJob.status === 'running' || signal.recalcJob.status === 'archive_retrying')
        ? [{ signalId: signal.id, job: signal.recalcJob }]
        : []
    );

  for (const { signalId, job } of pending) {
    recordAudit(
      signalId,
      '重算流水线',
      '恢复未完成重算',
      `检测到未完成作业 ${job.id}（已完成检查点：${job.completedPhases.join('、') || '无'}），自断点续算；` +
        '未完成部分接着算，台账/批次/趋势继续展示上一版完整结果。'
    );
    void requestRecalculation(signalId, { by: clientId(), reason: '页面加载后恢复未完成作业' });
  }
}
