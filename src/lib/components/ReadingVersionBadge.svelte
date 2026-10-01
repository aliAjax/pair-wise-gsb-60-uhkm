<script lang="ts">
  import { readModel, recalcInvalidations } from '$lib/services/recalc-store';

  export let signalId: string;
  export let size: 'sm' | 'md' = 'sm';

  $: invalidation = $recalcInvalidations.find((item) => item.signalId === signalId);
  $: version = $readModel.version;
</script>

<span
  class="badge {size === 'md' ? 'px-3 py-1 text-sm' : ''} {invalidation
    ? 'bg-amber-100 text-amber-950'
    : 'bg-surface-200-800'}"
  title={invalidation
    ? `该读数来自上一版 V${version}，证据已于 ${invalidation.invalidatedAt.slice(0, 16).replace('T', ' ')} 更正并失效，重算${invalidation ? '未完成/未确认' : ''}，确认前继续展示旧结果`
    : `当前已发布读数版本 V${version}`}
>
  {#if invalidation}
    上一版 V{version} · 重算未完成
  {:else}
    读数 V{version}
  {/if}
</span>
