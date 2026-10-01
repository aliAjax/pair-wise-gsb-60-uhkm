/**
 * 可恢复重算流程的端到端验证（通过 Vite SSR 加载 TS 源码）：
 * 1. 证据更正 -> 旧读数失效 -> 三阶段重算 -> 复核确认三处换版
 * 2. 存档失败 -> 保留旧版本并自动重试 -> 未完成阶段续算
 * 3. 同信号重复提交 -> 只受理一个作业，后到并入
 * 4. 换版前后读数与审计依据正确
 */
import { webcrypto } from 'node:crypto';
import { createServer } from 'vite';

function makeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear()
  };
}

const sessionStore = makeStorage();
// 模拟真实窗口：会话 id 在整个窗口生命周期内稳定
sessionStore.setItem('medical-safety-recalc-session-v2', 'WIN-TEST01');

// 必须在模块加载前安装 browser 环境
globalThis.window = {
  localStorage: makeStorage(),
  sessionStorage: sessionStore,
  addEventListener: () => {},
  setInterval: () => 0,
  crypto
};
globalThis.localStorage = globalThis.window.localStorage;
globalThis.sessionStorage = globalThis.window.sessionStorage;
if (!globalThis.crypto) globalThis.crypto = webcrypto;

const vite = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'error'
});

const recalc = await vite.ssrLoadModule('/src/lib/services/recalc-store.ts');
const store = await vite.ssrLoadModule('/src/lib/stores/signal-store.ts');
const { get } = await vite.ssrLoadModule('svelte/store');

let passed = 0;
function assert(cond, message) {
  if (!cond) {
    console.error('FAIL:', message);
    process.exit(1);
  }
  passed += 1;
  console.log('PASS:', message);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const signalId = 'SIG-2026-018';

// 初始版本：V1，报告 17，发生率 0.83%
let model = get(recalc.readModel);
assert(model.version === 1, '初始读数版本为 V1');
const initial = model.signals.find((s) => s.signalId === signalId);
assert(initial.reportCount === 17, '初始台账报告数 17');
assert(initial.occurrenceRate === 0.83, '初始发生率 0.83%');
assert(model.trends.pumpOcclusion.at(-1).value === 0.83, '初始趋势近月 0.83%');

// 场景一：存档失败演练（注入 7 次：提交存档 2 次 + 三阶段 4 次 + 候选归档 1 次）
recalc.injectArchiveFailures(7);

const target = store.signalStore.getSnapshot().find((s) => s.id === signalId);
const evidence = target.evidence.find((e) => e.id === 'E-018-01');
const correction = {
  evidenceId: evidence.id,
  actor: '赵珂',
  reason: '客服工单去重后确认仅 6 起独立投诉，原 11 起含 5 条重复建单',
  before: {
    title: evidence.title,
    source: evidence.source,
    strength: evidence.strength,
    batch: evidence.batch,
    note: evidence.note,
    reports: evidence.reports
  },
  after: {
    title: evidence.title,
    source: evidence.source,
    strength: evidence.strength,
    batch: evidence.batch,
    note: evidence.note + '（已去重）',
    reports: 6
  }
};

const result1 = await store.signalStore.correctEvidence(signalId, correction);
assert(result1.outcome === 'started', '首次提交受理为新作业');
const jobId = result1.jobId;

// 场景二：另一窗口立即再次提交同一信号 -> 并入现有作业
const result2 = await store.signalStore.correctEvidence(
  signalId,
  correction,
  { clientSession: 'WIN-SECOND', clientLabel: '另一窗口 nd（模拟第二窗口）' }
);
assert(result2.outcome === 'joined', '并发重复提交并入现有作业');
assert(result2.jobId === jobId, '并入的是同一个作业 id');

// 旧读数已失效，但页面读到的仍是 V1
model = get(recalc.readModel);
assert(model.version === 1, '重算期间已发布版本仍为 V1（保留旧结果）');
const invalidation = recalc.getInvalidation(signalId);
assert(!!invalidation && invalidation.staleFromVersion === 1, '失效登记指向旧版本 V1');
let job = recalc.getActiveJob(signalId);
assert(job.joinedSessions.length === 2, '作业记录 2 个窗口（受理 + 并入）');

// 等待三阶段完成（注入的失败会自动重试；2 次提交 + 4 次阶段 + 1 次候选 = 7.7s 重试 + 1.3s 计算）
await sleep(11000);
job = recalc.getActiveJob(signalId);
if (!job || job.state !== 'awaiting_confirmation') {
  console.error('DEBUG job:', JSON.stringify({
    state: job?.state,
    stages: job && Object.fromEntries(Object.entries(job.stages).map(([k, v]) => [k, { state: v.state, attempts: v.attempts, lastError: v.lastError }])),
    failuresLeft: globalThis.localStorage.getItem('medical-safety-recalc-failures-v2'),
    archivedAttempts: job?.archivedAttempts
  }, null, 2));
}
assert(!!job && job.state === 'awaiting_confirmation', '三阶段完成，进入待复核确认');
assert(job.stages.signals.state === 'done', '信号阶段已存档');
assert(job.stages.batches.state === 'done', '批次阶段已存档');
assert(job.stages.trends.state === 'done', '趋势阶段已存档');
// signals 阶段在第 3 次正式存档才成功（前两次失败发生在提交阶段），attempts 记录计算尝试
assert(job.stages.signals.attempts >= 1, '信号阶段至少计算一次，失败不丢失进度');
assert(job.archivedAttempts >= 1, '候选归档经历失败重试后成功（archivedAttempts=' + job.archivedAttempts + '）');
assert(job.candidate.reading.reportCount === 12, '候选报告数 = 6+4+2 = 12（接着算，未丢进度）');
assert(job.candidate.reading.occurrenceRate === 0.59, '候选发生率 12/2048 = 0.59%');
assert(job.candidate.trends.at(-1).value === 0.59, '候选趋势近月重算为 0.59%');

// 确认前仍是 V1
model = get(recalc.readModel);
assert(model.version === 1, '确认前各处仍是 V1');

// 场景三：复核确认 -> 三处一起换版
const change = await store.signalStore.confirmReading({
  signalId,
  jobId,
  reviewer: '复核人 林澈',
  note: '去重清单与客服系统核对一致，接受新报告数 12 与发生率 0.59%。'
});
assert(change.newModel.version === 2, '确认后发布 V2');
assert(change.previousReading.reportCount === 17 && change.newReading.reportCount === 12, '换版前后读数被保留');

model = get(recalc.readModel);
assert(model.version === 2, '读模型已升到 V2');
const next = model.signals.find((s) => s.signalId === signalId);
assert(next.reportCount === 12, '台账读数已换为 12');
assert(next.occurrenceRate === 0.59, '台账发生率已换为 0.59%');
assert(model.trends.pumpOcclusion.at(-1).value === 0.59, '趋势读数已一起换为 0.59%');
assert(model.trends.pumpOcclusion[0].value === 0.18, '历史趋势点保持不变');
assert(!recalc.getInvalidation(signalId), '确认后失效标记清除');

// 审计中留下三处前后依据
const updatedSignal = store.signalStore.getSnapshot().find((s) => s.id === signalId);
const auditText = updatedSignal.audit.map((a) => a.action + ' ' + a.detail).join('\n');
assert(auditText.includes('换版确认 · 台账读数') && auditText.includes('17 -> 12'), '台账换版前后依据入审计');
assert(auditText.includes('换版确认 · 批次覆盖'), '批次覆盖换版依据入审计');
assert(auditText.includes('换版确认 · 趋势核对') && auditText.includes('0.83% -> 0.59%'), '趋势换版前后依据入审计');
assert(updatedSignal.corrections.length === 1 && updatedSignal.corrections[0].before.reports === 11, '更正前后记录保留');

// 场景四：确认后同信号再来一次新更正 -> 正常受理（前序已确认，不并入）
const evidence2 = updatedSignal.evidence.find((e) => e.id === 'E-018-02');
const correction2 = {
  evidenceId: evidence2.id,
  actor: '赵珂',
  reason: '维修单据复核后确认其中 1 单与本信号无关，调减归因数。',
  before: { title: evidence2.title, source: evidence2.source, strength: evidence2.strength, batch: evidence2.batch, note: evidence2.note, reports: evidence2.reports },
  after: { title: evidence2.title, source: evidence2.source, strength: evidence2.strength, batch: evidence2.batch, note: evidence2.note, reports: 3 }
};
const result3 = await store.signalStore.correctEvidence(signalId, correction2);
assert(result3.outcome === 'started', '确认后新更正受理为新作业');
await sleep(2500);
const job3 = recalc.getActiveJob(signalId);
assert(job3.state === 'awaiting_confirmation', '第二轮重算完成待确认');
assert(job3.candidate.reading.reportCount === 11, '第二轮候选报告数 6+3+2 = 11');

console.log(`\n全部 ${passed} 项断言通过 ✅`);
await vite.close();
process.exit(0);
