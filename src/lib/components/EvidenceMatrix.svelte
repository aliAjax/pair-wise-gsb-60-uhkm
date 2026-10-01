<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import type { EvidenceItem } from '$lib/models/signal';

  export let evidence: EvidenceItem[];

  const dispatch = createEventDispatcher<{ correct: EvidenceItem }>();

  const strengthLabels: Record<EvidenceItem['strength'], string> = {
    strong: '强支持',
    moderate: '中等支持',
    weak: '弱支持',
    contrary: '相反证据'
  };

  const typeLabels: Record<EvidenceItem['type'], string> = {
    complaint: '投诉',
    repair: '维修',
    adverse_event: '不良事件',
    field_report: '现场报告',
    test: '测试',
    literature: '文献'
  };
</script>

<div class="grid gap-3 lg:grid-cols-2">
  {#each evidence as item (item.id)}
    <article
      class="rounded border p-4 {item.superseded
        ? 'border-surface-400-600 bg-surface-200-800 opacity-70'
        : item.strength === 'strong'
          ? 'border-surface-300-700 evidence-strong'
          : item.strength === 'contrary'
            ? 'border-surface-300-700 evidence-conflicting'
            : 'border-surface-300-700 evidence-weak'}"
    >
      <div class="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p class="text-xs font-medium text-surface-500-400">{typeLabels[item.type]}</p>
          <h4 class="mt-1 font-semibold">{item.title}</h4>
        </div>
        <div class="flex flex-col items-end gap-1">
          <span class="badge">{strengthLabels[item.strength]}</span>
          {#if item.superseded}<span class="badge bg-surface-400-600 text-white">已更正失效</span>{/if}
        </div>
      </div>
      <p class="mt-3 text-sm text-surface-600-300">{item.note}</p>
      <div class="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-surface-500-400">
        <span>来源：{item.source}</span>
        <span>批号：{item.batch}</span>
        <span>报告 {item.reports ?? 0} 条</span>
        <span>暴露 {item.exposed ?? 0} 台</span>
        <span>录入：{item.createdAt.slice(0, 10)}</span>
      </div>

      {#if !item.superseded}
        <button
          class="btn btn-sm mt-3 variant-ghost-surface"
          type="button"
          on:click={() => dispatch('correct', item)}
        >
          更正此证据记录
        </button>
      {/if}

      {#if item.corrections}
        <div class="mt-3 space-y-2 border-t border-surface-400-600 pt-2 text-xs text-surface-600-300">
          {#each item.corrections as correction}
            <div>
              <p class="font-medium">
                {correction.correctedAt.slice(0, 16).replace('T', ' ')} · {correction.actor} 更正（记录保留不删除）
              </p>
              <p class="mt-1">原始记录：{correction.previous.title}｜{correction.previous.source}｜强度
                {strengthLabels[correction.previous.strength]}｜批号 {correction.previous.batch}｜
                报告 {correction.previous.reports} 条｜暴露 {correction.previous.exposed} 台
              </p>
              <p class="mt-1">原始说明：{correction.previous.note}</p>
              <p class="mt-1 text-orange-800 dark:text-orange-300">更正原因：{correction.reason}</p>
              {#if item.replacedBy}<p class="mt-1">替代证据：{item.replacedBy}</p>{/if}
            </div>
          {/each}
        </div>
      {/if}
    </article>
  {/each}
</div>
