<script lang="ts">
  import { enhance } from '$app/forms';
  import type { SubmitFunction } from '@sveltejs/kit';
  import type { SignalCase } from '$lib/models/signal';
  import type { RecalcStage } from '$lib/models/recalc';
  import { recalcStages, stageLabels } from '$lib/models/recalc';
  import {
    injectArchiveFailures,
    readModel,
    recalcInvalidations,
    recalcJobs,
    sessionId,
    simulateConcurrentSubmit
  } from '$lib/services/recalc-store';
  import { signalStore } from '$lib/stores/signal-store';

  export let signal: SignalCase;

  $: jobs = $recalcJobs.filter((job) => job.signalId === signal.id);
  $: activeJob = jobs.find((job) => job.state === 'running' || job.state === 'awaiting_confirmation');
  $: invalidation = $recalcInvalidations.find((item) => item.signalId === signal.id);
  $: model = $readModel;
  $: previousReading = model.signals.find((item) => item.signalId === signal.id);
  $: history = jobs.filter((job) => job.state === 'confirmed' || job.state === 'superseded').slice(0, 3);

  let confirmError = '';
  let confirming = false;
  let busyConcurrent = false;
  let injected = false;

  const stageStateLabel: Record<string, string> = {
    pending: '待计算',
    running: '计算中',
    done: '已存档',
    failed: '存档失败 · 重试中'
  };

  const confirmHandler: SubmitFunction = () => {
    return async ({ result, update }) => {
      if (result.type === 'success') {
        const payload = result.data as {
          confirmation?: { signalId: string; jobId: string; reviewer: string; note: string };
        };
        if (payload.confirmation && activeJob) {
          confirming = true;
          confirmError = '';
          try {
            await signalStore.confirmReading({
              signalId: payload.confirmation.signalId,
              jobId: activeJob.id,
              reviewer: payload.confirmation.reviewer,
              note: payload.confirmation.note
            });
          } catch (error) {
            confirmError = (error as Error)?.message === 'JOB_NOT_READY'
              ? '该作业尚未完成或已被确认，请刷新后核对。'
              : '换版失败，请重试。';
          } finally {
            confirming = false;
          }
        }
      }
      await update({ reset: true });
    };
  };

  async function triggerConcurrent() {
    busyConcurrent = true;
    try {
      await simulateConcurrentSubmit(signal.id);
    } finally {
      busyConcurrent = false;
    }
  }

  function injectFailures() {
    injectArchiveFailures(2);
    injected = true;
  }

  function fmt(iso: string | null): string {
    return iso ? iso.slice(11, 19) : '—';
  }
</script>

{#if activeJob || invalidation}
  <section class="mb-6 rounded border border-amber-400 bg-amber-50 p-4 text-sm text-amber-950">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <p class="font-semibold">
          {#if activeJob?.state === 'running'}
            重算未完成 · 台账、批次追踪、趋势核对继续展示上一版（V{invalidation?.staleFromVersion ?? model.version}）完整结果
          {:else}
            重算完成，等待复核确认 · 当前各处仍为 V{invalidation?.staleFromVersion ?? model.version} 旧读数
          {/if}
        </p>
        <p class="mt-1 text-xs">
          触发更正：{activeJob?.correction.after.title ?? invalidation?.evidenceId}；
          旧读数已于 {invalidation?.invalidatedAt.slice(0, 16).replace('T', ' ')} 失效，
          未确认前三处均不换数。
        </p>
      </div>
      <span class="badge {activeJob?.state === 'running' ? 'bg-amber-200' : 'bg-teal-200'} text-amber-950">
        {activeJob?.state === 'running' ? '重算中' : '待复核'}
      </span>
    </div>

    {#if activeJob}
      <ol class="mt-4 grid gap-2 md:grid-cols-3">
        {#each recalcStages as stage (stage)}
          {@const record = activeJob.stages[stage as RecalcStage]}
          <li class="rounded border border-amber-300 bg-white/70 p-3">
            <div class="flex items-center justify-between gap-2">
              <span class="font-medium">{stageLabels[stage as RecalcStage]}</span>
              <span
                class="badge {record.state === 'done'
                  ? 'bg-emerald-100 text-emerald-900'
                  : record.state === 'failed'
                    ? 'bg-red-100 text-red-900'
                    : record.state === 'running'
                      ? 'bg-amber-100 text-amber-900'
                      : 'bg-surface-200-800'}"
              >
                {stageStateLabel[record.state]}
              </span>
            </div>
            <p class="mt-2 text-xs text-surface-600-300">
              尝试 {record.attempts} 次 · 最近存档 {fmt(record.updatedAt)}
            </p>
            {#if record.lastError}
              <p class="mt-1 text-xs text-red-700">{record.lastError}</p>
            {/if}
          </li>
        {/each}
      </ol>

      <div class="mt-3 flex flex-wrap items-center gap-2 text-xs">
        <button class="btn btn-sm variant-soft-primary" type="button" disabled={busyConcurrent} on:click={triggerConcurrent}>
          模拟第二窗口同时提交同一信号
        </button>
        <button class="btn btn-sm variant-soft-error" type="button" disabled={injected} on:click={injectFailures}>
          {injected ? '已注入：接下来 2 次存档将失败并自动重试' : '演练：注入 2 次存档失败'}
        </button>
        <span class="text-surface-600-300">
          受理窗口 {activeJob.ownerSession === sessionId ? '本窗口' : '另一窗口'}
          （{activeJob.ownerSession.slice(-6)}）；并入 {Math.max(0, activeJob.joinedSessions.length - 1)} 个后到窗口
        </span>
      </div>
      {#if activeJob.joinedSessions.length > 1}
        <ul class="mt-2 space-y-1 text-xs text-surface-700-300">
          {#each activeJob.joinedSessions as entry}
            <li>· {entry.label} 于 {entry.at.slice(11, 19)} {entry.label.includes('接管') ? '' : '提交，并入现有作业'}</li>
          {/each}
        </ul>
      {/if}
    {/if}
  </section>
{/if}

{#if activeJob?.state === 'awaiting_confirmation' && activeJob.candidate}
  <section class="mb-6 rounded border border-teal-500 bg-surface-100-900 p-5">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h2 class="text-lg font-semibold">复核确认 · 三处一起换版</h2>
        <p class="mt-1 text-sm text-surface-500-400">
          候选 V{model.version + 1} 已完成三阶段重算。确认后台账、批次覆盖、趋势核对同时切换读数，并各自留下前后依据。
        </p>
      </div>
      <span class="badge bg-teal-100 text-teal-900">作业 {activeJob.id.slice(-6)}</span>
    </div>

    <div class="mt-4 overflow-x-auto">
      <table class="data-table min-w-[720px]">
        <thead>
          <tr>
            <th>读数位置</th>
            <th>上一版 V{model.version}（继续展示中）</th>
            <th>候选新版本</th>
            <th>依据</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>台账 · 报告数</td>
            <td>{previousReading?.reportCount ?? '—'}</td>
            <td class="font-semibold text-teal-700">{activeJob.candidate.reading.reportCount}</td>
            <td rowspan="3" class="text-xs text-surface-600-300">
              证据依据：{activeJob.candidate.evidenceBasis.join('、')}
              <br />更正依据：{activeJob.correction.reason}
            </td>
          </tr>
          <tr>
            <td>台账 · 核查发生率</td>
            <td>{previousReading ? previousReading.occurrenceRate.toFixed(2) : '—'}%</td>
            <td class="font-semibold text-teal-700">{activeJob.candidate.reading.occurrenceRate.toFixed(2)}%</td>
          </tr>
          <tr>
            <td>批次覆盖</td>
            <td class="text-xs">{previousReading?.affectedBatches.join('、') ?? '—'}</td>

            <td class="text-xs font-semibold text-teal-700">{activeJob.candidate.reading.affectedBatches.join('、')}</td>
          </tr>
          <tr>
            <td>趋势 · 近月发生率</td>
            <td>{model.trends.pumpOcclusion.at(-1)?.value.toFixed(2)}%</td>
            <td class="font-semibold text-teal-700">{activeJob.candidate.trends.at(-1)?.value.toFixed(2)}%</td>
            <td class="text-xs text-surface-600-300">阈值 0.75%，历史点不变，仅重算近月点</td>
          </tr>
        </tbody>
      </table>
    </div>

    <form method="POST" action="?/confirm" class="mt-5 grid gap-4 md:grid-cols-[200px_1fr_auto] md:items-end" use:enhance={confirmHandler}>
      <input type="hidden" name="signalId" value={signal.id} />
      <input type="hidden" name="jobId" value={activeJob.id} />
      <label>
        <span class="mb-1 block text-sm font-medium">复核人</span>
        <input class="input" name="reviewer" value={signal.owner} required minlength="2" />
      </label>
      <label>
        <span class="mb-1 block text-sm font-medium">复核确认依据</span>
        <input
          class="input"
          name="note"
          required
          minlength="6"
          placeholder="说明接受新报告数/发生率与批次覆盖的理由，将分别写入三处审计"
        />
      </label>
      <button class="btn variant-filled-primary" type="submit" disabled={confirming}>
        {confirming ? '正在换版…' : '确认新版本，三处一起换读数'}
      </button>
    </form>
    {#if confirmError}
      <p class="mt-3 text-sm text-red-700">{confirmError}</p>
    {/if}
  </section>
{/if}

{#if history.length > 0}
  <section class="mb-6 rounded border border-surface-300-700 bg-surface-100-900 p-4">
    <h2 class="font-semibold">重算与换版记录</h2>
    <ul class="mt-3 space-y-2 text-xs text-surface-600-300">
      {#each history as job (job.id)}
        <li class="flex flex-wrap gap-x-3 gap-y-1">
          <span class="badge {job.state === 'confirmed' ? 'bg-emerald-100 text-emerald-900' : 'bg-surface-200-800'}">
            {job.state === 'confirmed' ? '已确认换版' : '已被新更正作废'}
          </span>
          <span>作业 {job.id.slice(-8)}</span>
          <span>发起 {job.submittedAt.slice(0, 16).replace('T', ' ')}</span>
          {#if job.finishedAt}<span>完成 {job.finishedAt.slice(0, 16).replace('T', ' ')}</span>{/if}
          <span>归档尝试 {job.archivedAttempts} 次</span>
          <span>涉及证据 {job.correction.evidenceId}</span>
        </li>
      {/each}
    </ul>
  </section>
{/if}
