<script lang="ts">
  import ReadingsBadge from '$lib/components/ReadingsBadge.svelte';
  import RiskBadge from '$lib/components/RiskBadge.svelte';
  import { isReadingsStale } from '$lib/services/readings';
  import { signalStore } from '$lib/stores/signal-store';

  $: signals = $signalStore;
  let selectedBatch = 'all';

  $: batches = Array.from(
    new Set(signals.flatMap((signal) => signal.readings.affectedBatches))
  ).sort();
  $: visibleSignals = signals.filter(
    (signal) =>
      selectedBatch === 'all' || signal.readings.affectedBatches.includes(selectedBatch)
  );
  $: staleCount = visibleSignals.filter((signal) => isReadingsStale(signal)).length;
</script>

<svelte:head><title>批次追踪 | 医疗器械安全信号核查平台</title></svelte:head>

<div class="mb-6 flex flex-wrap items-end justify-between gap-3">
  <div>
    <h1 class="text-2xl font-semibold">批次追踪</h1>
    <p class="mt-1 text-sm text-surface-600-300">按生产批号或软件版本追踪信号覆盖、报告数量和高风险关联。</p>
  </div>
  <label class="min-w-[240px]">
    <span class="mb-1 block text-sm font-medium">目标批号</span>
    <select class="select" bind:value={selectedBatch}>
      <option value="all">全部批号</option>
      {#each batches as batch}
        <option value={batch}>{batch}</option>
      {/each}
    </select>
  </label>
</div>

{#if staleCount > 0}
  <div class="mb-5 rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
    {staleCount} 个信号的批次覆盖读数已随证据更正失效、重算未完成；下列覆盖批号、报告与暴露数量仍为上一版完整结果，复核确认后自动换读。
  </div>
{/if}

<section class="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
  {#each visibleSignals as signal}
    {@const stale = isReadingsStale(signal)}
    <article
      class="rounded border bg-surface-100-900 p-4 {stale
        ? 'border-amber-400'
        : 'border-surface-300-700'}"
    >
      <div class="flex items-start justify-between gap-3">
        <div>
          <p class="text-sm text-surface-500-400">{signal.product}</p>
          <h2 class="mt-1 font-semibold">{signal.batch}</h2>
        </div>
        <RiskBadge risk={signal.readings.riskLevel} status={signal.status} />
      </div>
      <div class="mt-3"><ReadingsBadge {signal} /></div>
      <dl class="mt-4 grid grid-cols-2 gap-3 text-sm">
        <div>
          <dt class="text-surface-500-400">报告数量{stale ? '（上一版）' : ''}</dt>
          <dd class="metric-value mt-1 font-semibold">{signal.readings.reportCount}</dd>
        </div>
        <div>
          <dt class="text-surface-500-400">暴露数量{stale ? '（上一版）' : ''}</dt>
          <dd class="metric-value mt-1 font-semibold">{signal.readings.exposedUnits}</dd>
        </div>
      </dl>
      <p class="mt-4 text-sm text-surface-600-300">
        覆盖批号：{signal.readings.affectedBatches.join('、')}
      </p>
      <a class="btn btn-sm mt-4 variant-soft-primary" href={`/signals/${signal.id}`}>
        {signal.recalcJob?.status === 'awaiting_review' ? '前往复核换版' : '查看批次证据'}
      </a>
    </article>
  {/each}
</section>
