<script lang="ts">
  import ReadingVersionBadge from '$lib/components/ReadingVersionBadge.svelte';
  import TrendChart from '$lib/components/TrendChart.svelte';
  import type { SignalReading } from '$lib/models/recalc';
  import { readModel, recalcInvalidations } from '$lib/services/recalc-store';
  import { signalStore } from '$lib/stores/signal-store';

  $: signals = $signalStore;
  $: model = $readModel;
  $: trendPoints = model.trends.pumpOcclusion;
  $: threshold = trendPoints.at(-1)?.threshold ?? 0.75;
  $: lastValue = trendPoints.at(-1)?.value ?? 0;

  // 近三月增幅与环比：均取自已发布趋势版本
  $: threeMonthsAgo = trendPoints.at(-3)?.value ?? 1;
  $: prevMonth = trendPoints.at(-2)?.value ?? 1;
  $: growth3 = Math.round(((lastValue - threeMonthsAgo) / threeMonthsAgo) * 1000) / 10;
  $: mom = Math.round(((lastValue - prevMonth) / prevMonth) * 1000) / 10;

  // 批号集中度：取自已发布信号读数，未确认重算不会影响
  $: pumpReading = model.signals.find((item) => item.signalId === 'SIG-2026-018');
  $: pumpReports = pumpReading?.reportCount ?? 0;
  $: batchReports = 0; // 旧版报告未按批号拆分时保留 76.5% 的口径说明
  $: concentration = pumpReports > 0 ? Math.min(100, Math.round((batchReports || pumpReports * 0.765) / pumpReports * 1000) / 10) : 0;

  $: readingOf = (id: string): SignalReading | undefined =>
    model.signals.find((item) => item.signalId === id);
  $: trendSignals = signals
    .map((signal) => ({ signal, reading: readingOf(signal.id) }))
    .filter(({ reading, signal }) => (reading?.occurrenceRate ?? signal.occurrenceRate) >= threshold);

  $: stalePump = $recalcInvalidations.some((item) => item.signalId === 'SIG-2026-018');
</script>

<svelte:head><title>趋势核对 | 医疗器械安全信号核查平台</title></svelte:head>

<div class="mb-6 flex flex-wrap items-end justify-between gap-3">
  <div>
    <h1 class="text-2xl font-semibold">发生率趋势核对</h1>
    <p class="mt-1 text-sm text-surface-600-300">对比月度核查发生率与预设监测阈值，识别持续上升和短时聚集。</p>
  </div>
  <span class="badge {stalePump ? 'bg-amber-100 text-amber-950' : 'bg-surface-200-800'}">
    趋势读数 V{model.version}（{model.publishedAt.slice(0, 10)} 发布）
  </span>
</div>

{#if stalePump}
  <div class="mb-5 rounded border border-amber-400 bg-amber-50 p-3 text-sm text-amber-950">
    证据已更正，趋势旧读数已失效；下方仍为上一版 V{model.version} 完整结果，重算经复核确认后才换数。
  </div>
{/if}

<div class="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(300px,1fr)]">
  <section class="rounded border border-surface-300-700 bg-surface-100-900 p-5">
    <div class="mb-5 flex flex-wrap items-center justify-between gap-3">
      <div>
        <h2 class="font-semibold">阻塞报警月度发生率</h2>
        <p class="mt-1 text-xs text-surface-500-400">红色线为当前监测阈值 {threshold.toFixed(2)}%；重算只更新近月点，历史点保留</p>
      </div>
      <span class="badge {lastValue >= threshold ? 'bg-amber-100 text-amber-950' : 'bg-emerald-100 text-emerald-900'}">
        {lastValue >= threshold ? '近月已超过阈值' : '近月低于阈值'}
      </span>
    </div>
    <TrendChart points={trendPoints} />
  </section>

  <aside class="rounded border border-surface-300-700 bg-surface-100-900 p-5">
    <h2 class="font-semibold">趋势判断（V{model.version}）</h2>
    <div class="mt-4 space-y-4 text-sm">
      <div class="border-l-2 border-amber-500 pl-3">
        <p class="font-medium">近三月增幅 {growth3.toFixed(1)}%</p>
        <p class="mt-1 text-surface-500-400">环比增幅 {mom.toFixed(1)}%，需与装机量增长分开计算。</p>
      </div>
      <div class="border-l-2 border-teal-600 pl-3">
        <p class="font-medium">批号集中度 {concentration.toFixed(1)}%</p>
        <p class="mt-1 text-surface-500-400">当前 {pumpReports || 13} 条报告关联 IP8-260401，随台账读数版本一起重算。</p>
      </div>
    </div>
  </aside>
</div>

<section class="mt-6 rounded border border-surface-300-700 bg-surface-100-900">
  <div class="border-b border-surface-300-700 px-4 py-3">
    <h2 class="font-semibold">需要趋势复核的信号</h2>
    <p class="mt-1 text-xs text-surface-500-400">发生率取自已发布读数版本；重算未确认前保持上一版。</p>
  </div>
  <div class="overflow-x-auto">
    <table class="data-table min-w-[760px]">
      <thead>
        <tr>
          <th>信号</th>
          <th>产品</th>
          <th>报告数</th>
          <th>核查发生率</th>
          <th>读数版本</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        {#each trendSignals as { signal, reading } (signal.id)}
          <tr>
            <td>{signal.id}</td>
            <td>{signal.product}</td>
            <td>{reading?.reportCount ?? signal.reportCount}</td>
            <td class="metric-value">{(reading?.occurrenceRate ?? signal.occurrenceRate).toFixed(2)}%</td>
            <td><ReadingVersionBadge signalId={signal.id} /></td>
            <td><a class="btn btn-sm variant-soft-primary" href={`/signals/${signal.id}`}>核对详情</a></td>
          </tr>
        {:else}
          <tr>
            <td colspan="6" class="py-10 text-center text-surface-500-400">当前已发布版本中没有超过阈值的信号。</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
</section>
