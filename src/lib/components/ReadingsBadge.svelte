<script lang="ts">
  import type { SignalCase } from '$lib/models/signal';
  import { isReadingsStale, readingsState } from '$lib/services/readings';

  export let signal: SignalCase;

  const stateLabels = {
    confirmed: '已确认',
    recalculating: '重算未完成',
    retry: '存档重试中',
    review: '待复核确认'
  } as const;

  const stateClasses = {
    confirmed: 'bg-teal-100 text-teal-900',
    recalculating: 'bg-amber-100 text-amber-950',
    retry: 'bg-orange-100 text-orange-950',
    review: 'bg-sky-100 text-sky-950'
  } as const;

  $: state = readingsState(signal);
  $: stale = isReadingsStale(signal);
</script>

<span class="badge px-2 py-1 {stateClasses[state]}" title={`读数版本 V${signal.readings.version}：${stateLabels[state]}`}>
  V{signal.readings.version} · {stateLabels[state]}{stale ? '（上一版）' : ''}
</span>
