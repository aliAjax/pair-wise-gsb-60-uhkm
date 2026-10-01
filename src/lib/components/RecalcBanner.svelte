<script lang="ts">
  import { enhance } from '$app/forms';
  import { createEventDispatcher } from 'svelte';
  import type { SignalCase } from '$lib/models/signal';
  import { phaseLabels, phaseOrder, diffReadings } from '$lib/services/readings';
  import { requestRecalculation } from '$lib/services/recalc-service';
  import { signalStore } from '$lib/stores/signal-store';

  export let signal: SignalCase;

  const dispatch = createEventDispatcher<{ changed: void }>();
  let busy = false;

  $: job = signal.recalcJob;
  $: candidate = job?.candidate;
  $: diffs = candidate ? diffReadings(signal.readings, candidate) : [];

  async function retryArchive() {
    if (busy || !job) return;
    busy = true;
    try {
      await requestRecalculation(signal.id, {
        by: signal.owner,
        reason: '人工触发继续存档重试',
        createIfNone: false
      });
    } finally {
      busy = false;
      dispatch('changed');
    }
  }
</script>

{#if job && job.status !== 'superseded'}
  <section
    class="mb-6 rounded border-2 p-4 {job.status === 'archive_retrying'
      ? 'border-orange-400 bg-orange-50'
      : job.status === 'awaiting_review'
        ? 'border-sky-400 bg-sky-50'
        : 'border-amber-400 bg-amber-50'}"
  >
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 class="font-semibold text-surface-900-50">
          {#if job.status === 'awaiting_review'}
            重算 V{candidate?.version} 已存档，等待复核人确认
          {:else if job.status === 'archive_retrying'}
            存档失败，台账/批次/趋势仍显示 V{signal.readings.version} 上一版完整结果
          {:else}
            读数重算进行中，三处页面继续给出上一版完整结果
          {/if}
        </h2>
        <p class="mt-1 text-sm text-surface-700-300">
          作业 {job.id} · 第 {job.generation} 代 · 发起人 {job.requestedBy} · {job.reason}
        </p>
      </div>
      <span
        class="badge {job.status === 'running'
          ? 'bg-amber-200 text-amber-950'
          : job.status === 'archive_retrying'
            ? 'bg-orange-200 text-orange-950'
            : 'bg-sky-200 text-sky-950'}"
      >
        {job.status === 'running' ? '未完成' : job.status === 'archive_retrying' ? '未完成·重试中' : '未完成·待复核'}
      </span>
    </div>

    <!-- 检查点进度 -->
    <ol class="mt-4 grid gap-2 md:grid-cols-4">
      {#each phaseOrder as phase}
        {@const done = job.completedPhases.includes(phase)}
        {@const retrying = phase === 'archive' && job.status === 'archive_retrying'}
        <li
          class="flex items-center gap-2 rounded border px-3 py-2 text-sm {done
            ? 'border-teal-400 bg-teal-50 text-teal-900'
            : retrying
              ? 'border-orange-400 bg-white text-orange-900'
              : 'border-surface-300-700 bg-white text-surface-500-400'}"
        >
          <span aria-hidden="true">{done ? '✓' : retrying ? '↻' : '○'}</span>
          <span>{phaseLabels[phase]}</span>
          {#if retrying}<span class="ml-auto text-xs">第 {job.archiveAttempts} 次失败</span>{/if}
        </li>
      {/each}
    </ol>

    {#if job.lastError}
      <div class="mt-3 rounded border border-orange-300 bg-white p-3 text-sm text-orange-900">
        <p class="font-medium">存档未成功，旧结果保留中：</p>
        <p class="mt-1">{job.lastError}</p>
        <p class="mt-1 text-xs">已完成的台账、批次覆盖、趋势核对检查点不重跑，系统将自动退避重试存档；也可手动继续。</p>
        <button class="btn btn-sm mt-2 variant-soft-primary" type="button" disabled={busy} on:click={retryArchive}>
          {busy ? '正在重试…' : '立即继续存档'}
        </button>
      </div>
    {/if}

    {#if job.attached.length > 0}
      <p class="mt-3 text-xs text-surface-600-300">
        本作业已并入 {job.attached.length} 次重复提交（同一信号的并发重算只受理一个，后到提交接到本作业）：
        {job.attached.map((a) => a.by).join('、')}
      </p>
    {/if}

    {#if candidate && job.status === 'awaiting_review'}
      <div class="mt-4 rounded border border-sky-300 bg-white p-4">
        <h3 class="font-semibold">前后读数对照（复核确认后台账、批次追踪、趋势核对三处一起换版）</h3>
        <div class="mt-3 overflow-x-auto">
          <table class="data-table min-w-[560px]">
            <thead>
              <tr>
                <th>读数项</th>
                <th>上一版 V{signal.readings.version}（当前展示）</th>
                <th>候选 V{candidate.version}（确认后生效）</th>
              </tr>
            </thead>
            <tbody>
              {#each diffs as row}
                <tr class={row.changed ? 'bg-sky-50' : ''}>
                  <td>{row.label}</td>
                  <td class:line-through={row.changed}>{row.before}</td>
                  <td class="font-medium">{row.after}{row.changed ? '（变化）' : ''}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
        <p class="mt-3 text-xs text-surface-600-300">新版依据：{candidate.basis}</p>

        <form
          class="mt-4 grid gap-3 md:grid-cols-[minmax(160px,240px)_1fr_auto] md:items-end"
          method="POST"
          action="?/confirmReadings"
          use:enhance={() =>
            async ({ result, update }) => {
              if (result.type === 'success') {
                const payload = result.data as {
                  confirm?: { id: string; jobId: string; reviewer: string; note: string };
                };
                if (payload.confirm) {
                  signalStore.confirmRecalculation(
                    payload.confirm.id,
                    payload.confirm.jobId,
                    payload.confirm.reviewer,
                    payload.confirm.note
                  );
                }
              }
              await update({ reset: true });
              dispatch('changed');
            }}
        >
          <input type="hidden" name="id" value={signal.id} />
          <input type="hidden" name="jobId" value={job.id} />
          <label>
            <span class="mb-1 block text-sm font-medium">复核人</span>
            <input class="input" name="reviewer" value={signal.owner} required />
          </label>
          <label>
            <span class="mb-1 block text-sm font-medium">复核依据（确认新版本）</span>
            <input
              class="input"
              name="note"
              placeholder="说明取数口径核对结论与前后版本差异判断"
              required
              minlength="6"
            />
          </label>
          <button class="btn variant-filled-primary" type="submit">确认换版（三处一起）</button>
        </form>
      </div>
    {/if}
  </section>
{/if}
