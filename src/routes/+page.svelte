<script lang="ts">
  import ReadingsBadge from '$lib/components/ReadingsBadge.svelte';
  import RiskBadge from '$lib/components/RiskBadge.svelte';
  import { isReadingsStale } from '$lib/services/readings';
  import { signalStore } from '$lib/stores/signal-store';

  $: signals = $signalStore;
  $: openSignals = signals.filter((signal) => signal.status !== 'closed');
  $: criticalSignals = signals.filter(
    (signal) =>
      signal.readings.riskLevel === 'critical' || signal.readings.riskLevel === 'high'
  );
  $: overdueTasks = signals.flatMap((signal) =>
    signal.tasks
      .filter((task) => task.status !== 'done' && task.dueAt < new Date().toISOString().slice(0, 10))
      .map((task) => ({ ...task, signalId: signal.id }))
  );
  $: recalculatingSignals = signals.filter((signal) => isReadingsStale(signal));
  $: awaitingReview = signals.filter(
    (signal) => signal.recalcJob?.status === 'awaiting_review'
  );

  $: metrics = [
    { label: '开放信号', value: openSignals.length, note: '含调查、观察与处置队列' },
    { label: '高及以上风险', value: criticalSignals.length, note: '按当前读数版本计算' },
    {
      label: '未关闭任务',
      value: signals.flatMap((signal) => signal.tasks).filter((task) => task.status !== 'done').length,
      note: '跨信号调查任务'
    },
    { label: '逾期任务', value: overdueTasks.length, note: '按任务截止日计算' }
  ];
</script>

<svelte:head><title>总览 | 医疗器械安全信号核查平台</title></svelte:head>

<div class="mb-6 flex flex-wrap items-end justify-between gap-3">
  <div>
    <p class="text-sm font-medium text-teal-700">上市后安全运营</p>
    <h1 class="mt-1 text-2xl font-semibold tracking-normal">信号核查总览</h1>
    <p class="mt-2 text-sm text-surface-600-300">汇总投诉、维修、不良事件和现场报告，按风险推进核查闭环。</p>
  </div>
  <a class="btn variant-filled-primary" href="/signals">进入信号台账</a>
</div>

{#if recalculatingSignals.length > 0}
  <section class="mb-6 rounded border border-amber-300 bg-amber-50 p-4">
    <div class="flex flex-wrap items-center justify-between gap-3">
              <p class="text-sm font-medium text-amber-900">
                {recalculatingSignals.length} 个信号存在未完成的证据重算：台账、批次追踪、趋势核对继续展示上一版完整结果并标明未完成。
              </p>
              {#if awaitingReview.length > 0}
                <a class="btn btn-sm variant-filled-primary" href={`/signals/${awaitingReview[0].id}`}>
                  {awaitingReview.length} 个待复核版本，前往确认换版
                </a>
              {/if}
    </div>
    <ul class="mt-2 flex flex-wrap gap-2">
      {#each recalculatingSignals as signal}
        <li>
          <a class="badge bg-white text-amber-900 hover:underline" href={`/signals/${signal.id}`}>
            {signal.id} · {signal.recalcJob?.status === 'awaiting_review' ? '待复核' : signal.recalcJob?.status === 'archive_retrying' ? '存档重试' : '重算中'}
          </a>
        </li>
      {/each}
    </ul>
  </section>
{/if}

<section class="workspace-grid mb-6">
  {#each metrics as metric}
    <article class="col-span-12 rounded border border-surface-300-700 bg-surface-100-900 p-4 sm:col-span-6 xl:col-span-3">
      <p class="text-sm text-surface-500-400">{metric.label}</p>
      <p class="metric-value mt-2 text-3xl font-semibold">{metric.value}</p>
      <p class="mt-2 text-xs text-surface-500-400">{metric.note}</p>
    </article>
  {/each}
</section>

<div class="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
  <section class="rounded border border-surface-300-700 bg-surface-100-900">
    <div class="flex items-center justify-between border-b border-surface-300-700 px-4 py-3">
      <div>
        <h2 class="font-semibold">近期信号</h2>
        <p class="text-xs text-surface-500-400">按最后更新时间排序</p>
      </div>
      <a class="text-sm text-primary-700-300 hover:underline" href="/signals">查看全部</a>
    </div>
    <div class="divide-y divide-surface-300-700">
      {#each signals.slice(0, 4) as signal}
        {@const stale = isReadingsStale(signal)}
        <a class="block px-4 py-4 hover:bg-surface-200-800" href={`/signals/${signal.id}`}>
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p class="text-xs text-surface-500-400">{signal.id} · {signal.product}</p>
              <h3 class="mt-1 font-medium">{signal.title}</h3>
            </div>
            <div class="flex flex-col items-end gap-1">
              <RiskBadge risk={signal.readings.riskLevel} status={signal.status} />
              <ReadingsBadge {signal} />
            </div>
          </div>
          <p class="mt-2 text-sm text-surface-600-300">
            {signal.readings.reportCount} 条报告 · 发生率 {signal.readings.occurrenceRate.toFixed(2)}% · 负责人 {signal.owner}
            {#if stale}<span class="ml-1 text-xs text-amber-800 dark:text-amber-300">（读数上一版，重算未完成）</span>{/if}
          </p>
        </a>
      {/each}
    </div>
  </section>

  <aside class="rounded border border-surface-300-700 bg-surface-100-900">
    <div class="border-b border-surface-300-700 px-4 py-3">
      <h2 class="font-semibold">任务与复核提醒</h2>
      <p class="text-xs text-surface-500-400">优先处理逾期及高风险事项</p>
    </div>
    <div class="space-y-4 p-4">
      {#each signals.flatMap((signal) => signal.tasks.map((task) => ({ ...task, signalId: signal.id }))).filter((task) => task.status !== 'done').slice(0, 5) as task}
        <div class="border-l-2 border-amber-500 pl-3">
          <p class="text-sm font-medium">{task.title}</p>
          <p class="mt-1 text-xs text-surface-500-400">{task.signalId} · {task.owner} · 截止 {task.dueAt}</p>
        </div>
      {/each}
    </div>
  </aside>
</div>
