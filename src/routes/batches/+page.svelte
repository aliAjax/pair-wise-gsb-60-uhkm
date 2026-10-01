<script lang="ts">
  import ReadingVersionBadge from '$lib/components/ReadingVersionBadge.svelte';
  import RiskBadge from '$lib/components/RiskBadge.svelte';
  import type { SignalReading } from '$lib/models/recalc';
  import { readModel, recalcInvalidations } from '$lib/services/recalc-store';
  import { signalStore } from '$lib/stores/signal-store';

  $: signals = $signalStore;
  $: model = $readModel;
  $: invalidations = $recalcInvalidations;

  const readingOf = (id: string): SignalReading | undefined =>
    model.signals.find((item) => item.signalId === id);
  const isStale = (id: string): boolean => invalidations.some((item) => item.signalId === id);

  let selectedBatch = 'all';

  // 批次覆盖也读已发布读数版本；未确认的重算不会改变这里
  $: batches = Array.from(
    new Set(
      signals.flatMap((signal) => readingOf(signal.id)?.affectedBatches ?? signal.affectedBatches)
    )
  ).sort();
  $: visibleSignals = signals.filter((signal) => {
    const batchesOfSignal = readingOf(signal.id)?.affectedBatches ?? signal.affectedBatches;
    return selectedBatch === 'all' || batchesOfSignal.includes(selectedBatch);
  });
  $: staleCount = visibleSignals.filter((signal) => isStale(signal.id)).length;
</script>

<svelte:head><title>批次追踪 | 医疗器械安全信号核查平台</title></svelte:head>

<div class="mb-6 flex flex-wrap items-end justify-between gap-3">
  <div>
    <h1 class="text-2xl font-semibold">批次追踪</h1>
    <p class="mt-1 text-sm text-surface-600-300">按生产批号或软件版本追踪信号覆盖、报告数量和高风险关联。</p>
  </div>
  <label class="min-w-[240px]">
    <span class="mb-1 block text-sm font-medium">目标批号（已发布覆盖 V{model.version}）</span>
    <select class="select" bind:value={selectedBatch}>
      <option value="all">全部批号</option>
      {#each batches as batch}
        <option value={batch}>{batch}</option>
      {/each}
    </select>
  </label>
</div>

{#if staleCount > 0}
  <div class="mb-5 rounded border border-amber-400 bg-amber-50 p-3 text-sm text-amber-950">
    {staleCount} 个信号的证据已更正，批次覆盖仍显示上一版 V{model.version} 结果；待重算经复核确认后整体换版。
  </div>
{/if}

<section class="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
  {#each visibleSignals as signal (signal.id)}
    {@const reading = readingOf(signal.id)}
    {@const stale = isStale(signal.id)}
    <article class="rounded border {stale ? 'border-amber-400' : 'border-surface-300-700'} bg-surface-100-900 p-4">
      <div class="flex items-start justify-between gap-3">
        <div>
          <p class="text-sm text-surface-500-400">{signal.product}</p>
          <h2 class="mt-1 font-semibold">{signal.batch}</h2>
        </div>
        <RiskBadge risk={signal.riskLevel} status={signal.status} />
      </div>
      <dl class="mt-4 grid grid-cols-2 gap-3 text-sm">
        <div>
          <dt class="text-surface-500-400">报告数量（已发布）</dt>
          <dd class="metric-value mt-1 font-semibold">{reading?.reportCount ?? signal.reportCount}</dd>
        </div>
        <div>
          <dt class="text-surface-500-400">暴露数量</dt>
          <dd class="metric-value mt-1 font-semibold">{reading?.exposedUnits ?? signal.exposedUnits}</dd>
        </div>
      </dl>
      <p class="mt-4 text-sm text-surface-600-300">
        覆盖批号：{(reading?.affectedBatches ?? signal.affectedBatches).join('、')}
      </p>
      <div class="mt-4 flex flex-wrap items-center justify-between gap-2">
        <ReadingVersionBadge signalId={signal.id} />
        <a class="btn btn-sm variant-soft-primary" href={`/signals/${signal.id}`}>查看批次证据</a>
      </div>
    </article>
  {/each}
</section>
