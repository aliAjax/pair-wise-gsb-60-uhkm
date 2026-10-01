import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---- 最小浏览器环境桩 ----
const storage = new Map<string, string>();
const storageLike = {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => void storage.set(k, String(v)),
  removeItem: (k: string) => void storage.delete(k)
};
vi.stubGlobal('localStorage', storageLike);
vi.stubGlobal('sessionStorage', storageLike);
vi.stubGlobal('window', { addEventListener: () => {} });
vi.stubGlobal('navigator', {});
vi.stubGlobal('crypto', { randomUUID: () => 'uuid-' + Math.random().toString(36).slice(2) });

import { signalStore } from '$lib/stores/signal-store';
import { requestRecalculation, resumeUnfinishedJobs } from '$lib/services/recalc-service';
import { buildCandidateReadings } from '$lib/services/readings';
import type { EvidenceItem } from '$lib/models/signal';

beforeEach(() => {
  storage.clear();
  signalStore.reset();
});

describe('证据更正 -> 失效 -> 重算 -> 存档重试 -> 确认换版', () => {
  it('完整流水线（无 Web Locks 兜底路径）', async () => {
    const id = 'SIG-2026-018';
    const before = signalStore.getSnapshot().find((s) => s.id === id)!;
    expect(before.readings.reportCount).toBe(17);

    const target = before.evidence.find((e) => e.id === 'E-018-01')!;
    const replacement: Omit<EvidenceItem, 'id' | 'createdAt'> = {
      type: target.type, title: target.title, source: target.source, strength: target.strength,
      batch: target.batch, note: target.note, reports: 6, exposed: 2048
    };
    signalStore.correctEvidence(id, { evidenceId: target.id, item: replacement, actor: '周宁', reason: '安全团队核对原始工单确认5条为重复登记' });

    const after = signalStore.getSnapshot().find((s) => s.id === id)!;
    // 读数失效但上一版完整结果保留
    expect(after.recalcJob?.status).toBe('running');
    expect(after.readings.reportCount).toBe(17);
    expect(after.evidence.find((e) => e.id === target.id)?.superseded).toBe(true);

    const { joined } = await requestRecalculation(id, { by: '窗口A' });
    expect(joined).toBe(false);
    let job = signalStore.getRecalcJob(id)!;
    expect(job.status).toBe('awaiting_review');
    expect(job.completedPhases).toEqual(['ledger','batches','trends','archive']);
    expect(job.archiveAttempts).toBe(3); // 前两次失败、第三次成功
    expect(job.candidate?.reportCount).toBe(12);
    // 确认前仍是旧读数
    expect(signalStore.getSnapshot().find((s) => s.id === id)!.readings.reportCount).toBe(17);

    const ok = signalStore.confirmRecalculation(id, job.id, '复核人李娜', '取数口径核对一致，接受重复登记修正');
    expect(ok).toBe(true);
    const confirmed = signalStore.getSnapshot().find((s) => s.id === id)!;
    expect(confirmed.recalcJob).toBeUndefined();
    expect(confirmed.readings.version).toBe(2);
    expect(confirmed.readings.reportCount).toBe(12);
    expect(confirmed.readingsHistory).toHaveLength(1);
    expect(confirmed.readingsHistory[0].reportCount).toBe(17);
    // 顶层兼容字段同步
    expect(confirmed.reportCount).toBe(12);
    const audit = confirmed.audit.map((a) => a.action);
    expect(audit).toContain('复核确认换版');
    expect(audit).toContain('存档失败保留旧结果');
    expect(audit).toContain('证据更正');
  }, 30000);

  it('两个窗口同时提交同一信号：只受理一个，后到并入', async () => {
    const id = 'SIG-2026-019';
    const before = signalStore.getSnapshot().find((s) => s.id === id)!;
    const target = before.evidence.find((e) => e.id === 'E-019-01')!;
    const item: Omit<EvidenceItem, 'id' | 'createdAt'> = {
      ...target, reports: 2
    };
    signalStore.correctEvidence(id, { evidenceId: target.id, item, actor: '顾岚', reason: '其中一条报告归属另一产品型号，需要更正重复聚类' });

    const [a, b] = await Promise.all([
      requestRecalculation(id, { by: '窗口A' }),
      requestRecalculation(id, { by: '窗口B' })
    ]);
    // 无锁环境：两个都可能进入 runJob，但作业状态机以同一 jobId 持久化推进；
    // 同窗口 localRuns 保证第二个直接并入
    expect(a.joined === false || b.joined === false).toBe(true);
    expect(a.joined !== b.joined).toBe(true);
    const job = signalStore.getRecalcJob(id);
    expect(job?.status).toBe('awaiting_review');
  }, 30000);

  it('存档中途刷新页面：保留候选与检查点，恢复后只续算未完成部分', async () => {
    const id = 'SIG-2026-015';
    const before = signalStore.getSnapshot().find((s) => s.id === id)!;
    const target = before.evidence.find((e) => e.id === 'E-015-01')!;
    const { jobId } = signalStore.correctEvidence(id, {
      evidenceId: target.id,
      item: { ...target, reports: 7 },
      actor: '林澈',
      reason: '2 条维修记录实为同一设备复测，需扣除重复计数'
    });

    // 定格“第一次存档失败后页面被关闭”的持久化快照：
    // 前三个检查点与候选读数已落盘，archive 未完成，旧读数保持 V1
    const snapSignal = signalStore.getSnapshot().find((s) => s.id === id)!;
    const candidate = buildCandidateReadings(snapSignal, snapSignal.readings);
    signalStore.updateRecalcJob(id, jobId, (job) => {
      job.completedPhases = ['ledger', 'batches', 'trends'];
      job.candidate = candidate;
      job.archiveAttempts = 1;
      job.status = 'archive_retrying';
      job.lastError = '模拟快照：第 1 次存档失败';
    });
    expect(signalStore.getSnapshot().find((s) => s.id === id)!.readings.reportCount).toBe(9);

    // 重新加载页面：resume 扫描未完成作业，从 archive 断点续算，前三个检查点不重跑
    resumeUnfinishedJobs();
    await new Promise((r) => setTimeout(r, 4000));
    const finalJob = signalStore.getRecalcJob(id);
    expect(finalJob?.status).toBe('awaiting_review');
    expect(finalJob?.archiveAttempts).toBe(3); // 恢复后又尝试 2 次
    expect(finalJob?.completedPhases).toEqual(['ledger', 'batches', 'trends', 'archive']);
    expect(finalJob?.candidate?.reportCount).toBe(7);
    // 恢复期间旧读数仍不动，直到复核确认
    expect(signalStore.getSnapshot().find((s) => s.id === id)!.readings.reportCount).toBe(9);

    // 恢复审计可追溯
    const resumed = signalStore
      .getSnapshot()
      .find((s) => s.id === id)!
      .audit.some((a) => a.action === '恢复未完成重算');
    expect(resumed).toBe(true);
  }, 30000);

  it('Web Locks 互斥：后到窗口拿不到锁，并入现有作业并等待同一结果', async () => {
    // 假 LockManager：ifAvailable 拿不到锁时按规范 resolve null
    const held = new Set<string>();
    const fakeLocks = {
      request: (name: string, opts: any, cb?: any) => {
        const callback = typeof opts === 'function' ? opts : cb;
        const options = typeof opts === 'function' ? {} : opts;
        if (held.has(name)) {
          return options.ifAvailable ? Promise.resolve(null) : new Promise(() => {});
        }
        held.add(name);
        return Promise.resolve()
          .then(() => callback!({}))
          .finally(() => held.delete(name));
      }
    };
    (globalThis as any).navigator.locks = fakeLocks;

    const id = 'SIG-2026-018';
    const target = signalStore.getSnapshot().find((s) => s.id === id)!.evidence[0];
    signalStore.correctEvidence(id, {
      evidenceId: target.id,
      item: {
        type: target.type,
        title: target.title,
        source: target.source,
        strength: target.strength,
        batch: target.batch,
        note: target.note,
        reports: 10,
        exposed: target.exposed
      },
      actor: '周宁',
      reason: '跨两个窗口同时提交同一信号重算的互斥验证'
    });

    const [a, b] = await Promise.all([
      requestRecalculation(id, { by: '窗口A' }),
      requestRecalculation(id, { by: '窗口B' })
    ]);

    expect(a.joined).toBe(false); // 先到者受理
    expect(b.joined).toBe(true); // 后到者拿不到锁，并入
    const job = signalStore.getRecalcJob(id)!;
    expect(job.status).toBe('awaiting_review');
    expect(job.attached.map((x) => x.by)).toContain('窗口B');
    expect(job.attached.map((x) => x.by)).not.toContain('窗口A');
    expect(job.candidate?.reportCount).toBe(16); // 10 + 6
  }, 30000);
});
