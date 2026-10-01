<script lang="ts">
  import { enhance } from '$app/forms';
  import type { SubmitFunction } from '@sveltejs/kit';
  import EvidenceMatrix from '$lib/components/EvidenceMatrix.svelte';
  import ReadingsBadge from '$lib/components/ReadingsBadge.svelte';
  import RecalcBanner from '$lib/components/RecalcBanner.svelte';
  import RiskBadge from '$lib/components/RiskBadge.svelte';
  import type {
    AuditEntry,
    CaseVersion,
    EvidenceItem,
    EvidenceStrength,
    SignalStatus
  } from '$lib/models/signal';
  import { exportSignalReport } from '$lib/services/signal-service';
  import { requestRecalculation } from '$lib/services/recalc-service';
  import { activeReadings, isReadingsStale } from '$lib/services/readings';
  import { signalStore } from '$lib/stores/signal-store';
  import type { ActionData, PageData } from './$types';

  export let data: PageData;
  export let form: ActionData;

  $: signal = $signalStore.find((item) => item.id === data.id);
  $: readings = signal ? activeReadings(signal) : null;
  $: stale = signal ? isReadingsStale(signal) : false;
  $: nextVersion = (signal?.versions[0]?.version ?? 0) + 1;

  // 证据更正表单
  let correcting: EvidenceItem | null = null;
  const strengthOptions: Array<{ value: EvidenceStrength; label: string }> = [
    { value: 'strong', label: '强支持' },
    { value: 'moderate', label: '中等支持' },
    { value: 'weak', label: '弱支持' },
    { value: 'contrary', label: '相反证据' }
  ];

  const evidenceCorrectHandler: SubmitFunction = () => {
    return async ({ result, update }) => {
      if (result.type === 'success') {
        const payload = result.data as {
          correction?: {
            id: string;
            evidenceId: string;
            item: Omit<EvidenceItem, 'id' | 'createdAt'>;
            actor: string;
            reason: string;
          };
        };
        if (payload.correction && signal) {
          // 1) 旧证据失效、读数失效并（重开或新建）重算作业
          signalStore.correctEvidence(signal.id, payload.correction);
          // 2) 先让页面展示“上一版 + 未完成”横幅，重算在后台推进；
          //    若另一窗口已持锁执行同信号，本调用自动并入现有作业
          void requestRecalculation(signal.id, {
            by: payload.correction.actor,
            reason: payload.correction.reason
          });
          correcting = null;
        }
      }
      await update({ reset: true });
    };
  };

  const statusOptions: Array<{ value: SignalStatus; label: string }> = [
    { value: 'investigating', label: '转入调查' },
    { value: 'observed', label: '持续观察' },
    { value: 'action_required', label: '进入风险处置' },
    { value: 'review', label: '提交复核' },
    { value: 'closed', label: '关闭信号' }
  ];

  const transitionHandler: SubmitFunction = () => {
    return async ({ result, update }) => {
      if (result.type === 'success') {
        const payload = result.data as {
          transition?: { id: string; nextStatus: SignalStatus; reason: string; actor: string };
        };
        if (payload.transition) {
          signalStore.transition(
            payload.transition.id,
            payload.transition.nextStatus,
            payload.transition.reason,
            payload.transition.actor
          );
        }
      }
      await update({ reset: true });
    };
  };
</script>

<svelte:head><title>{signal?.id ?? data.id} | 信号核查详情</title></svelte:head>

{#if !signal}
  <section class="rounded border border-error-300 bg-error-50 p-6 text-error-900">
    未找到信号 {data.id}。它可能已被本地数据重置。
  </section>
{:else}
  <div class="mb-6 flex flex-wrap items-start justify-between gap-4">
    <div>
      <div class="flex flex-wrap items-center gap-3">
        <a class="text-sm text-primary-700-300 hover:underline" href="/signals">返回信号台账</a>
        <span class="text-surface-400">/</span>
        <span class="text-sm text-surface-500-400">{signal.id}</span>
      </div>
      <h1 class="mt-3 max-w-4xl text-2xl font-semibold">{signal.title}</h1>
      <div class="mt-3 flex flex-wrap items-center gap-2">
        <RiskBadge risk={signal.readings.riskLevel} status={signal.status} />
        <ReadingsBadge {signal} />
      </div>
    </div>
    <button class="btn variant-soft-primary" type="button" on:click={() => exportSignalReport(signal.id)}>
      导出可追溯报告
    </button>
  </div>

  {#if form?.message}
    <div class="mb-5 rounded border border-error-300 bg-error-50 p-3 text-sm text-error-900">{form.message}</div>
  {/if}

  <RecalcBanner {signal} />

  {#if stale}
    <div class="mb-5 rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
      受影响读数已随证据更正失效，重算尚未完成。以下台账、批次覆盖与发生率仍为
      <strong>V{readings?.version} 上一版完整结果</strong>，复核确认后三处一起换版。
    </div>
  {/if}

  <section class="workspace-grid mb-6">
    <article class="col-span-12 rounded border border-surface-300-700 bg-surface-100-900 p-4 xl:col-span-8">
      <div class="grid gap-5 md:grid-cols-2">
        <div>
          <p class="text-xs font-medium text-surface-500-400">产品与批号（读数版本 V{readings?.version}{stale ? '·上一版' : ''}）</p>
          <p class="mt-1 font-medium">{signal.product}</p>
          <p class="mt-1 text-sm text-surface-600-300">{readings?.affectedBatches.join(' / ')}</p>
        </div>
        <div>
          <p class="text-xs font-medium text-surface-500-400">调查负责人</p>
          <p class="mt-1 font-medium">{signal.owner}</p>
          <p class="mt-1 text-sm text-surface-600-300">最后更新 {signal.updatedAt.slice(0, 16).replace('T', ' ')}</p>
        </div>
        <div>
          <p class="text-xs font-medium text-surface-500-400">报告与暴露{stale ? '（上一版）' : ''}</p>
          <p class="metric-value mt-1 font-medium">
            {readings?.reportCount} 条 / {readings?.exposedUnits} 台
          </p>
        </div>
        <div>
          <p class="text-xs font-medium text-surface-500-400">核查发生率{stale ? '（上一版）' : ''}</p>
          <p class="metric-value mt-1 font-medium">{readings?.occurrenceRate.toFixed(2)}%</p>
        </div>
      </div>
      <div class="section-rule mt-5 pt-5">
        <p class="text-sm leading-6 text-surface-700-300">{signal.description}</p>
        <p class="mt-3 rounded bg-surface-200-800 p-2 text-xs text-surface-600-300">
          当前读数依据：{readings?.basis}
          {#if readings?.confirmedBy}（{readings.confirmedBy} 于 {readings.confirmedAt?.slice(0, 10)} 确认）{/if}
        </p>
      </div>
    </article>

    <aside class="col-span-12 rounded border border-surface-300-700 bg-surface-100-900 p-4 xl:col-span-4">
      <h2 class="font-semibold">状态流转</h2>
      <p class="mt-1 text-xs text-surface-500-400">每次流转都记录依据、操作人和时间。</p>
      <form
        class="mt-4 space-y-3"
        method="POST"
        action="?/transition"
        use:enhance={transitionHandler}
      >
        <input type="hidden" name="id" value={signal.id} />
        <label class="block">
          <span class="mb-1 block text-sm font-medium">目标状态</span>
          <select class="select" name="nextStatus">
            {#each statusOptions as option}
              <option value={option.value}>{option.label}</option>
            {/each}
          </select>
        </label>
        <label class="block">
          <span class="mb-1 block text-sm font-medium">操作人</span>
          <input class="input" name="actor" value={signal.owner} />
        </label>
        <label class="block">
          <span class="mb-1 block text-sm font-medium">流转依据</span>
          <textarea class="textarea" name="reason" rows="3" placeholder="说明新增证据、风险判断或复核结论"></textarea>
        </label>
        <button class="btn w-full variant-filled-primary" type="submit">提交状态流转</button>
      </form>

      {#if signal.status === 'closed'}
        <div class="section-rule mt-5 pt-5">
          <h3 class="font-medium">新事件重新打开</h3>
          <p class="mt-1 text-xs text-surface-500-400">关闭信号收到新报告时，不允许静默修改结论。</p>
          <form
            class="mt-3 space-y-3"
            method="POST"
            action="?/reopen"
            use:enhance={() =>
              async ({ result, update }) => {
                if (result.type === 'success') {
                  const payload = result.data as { reopen?: { id: string; actor: string; reason: string } };
                  if (payload.reopen) {
                    signalStore.reopen(payload.reopen.id, payload.reopen.actor, payload.reopen.reason);
                  }
                }
                await update({ reset: true });
              }}
          >
            <input type="hidden" name="id" value={signal.id} />
            <input class="input" name="actor" value={signal.owner} aria-label="操作人" />
            <textarea class="textarea" name="reason" rows="2" placeholder="描述新报告及其影响"></textarea>
            <button class="btn w-full variant-soft-error" type="submit">重新打开信号</button>
          </form>
        </div>
      {/if}
    </aside>
  </section>

  <section class="mb-6">
    <div class="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2 class="text-lg font-semibold">证据矩阵</h2>
        <p class="mt-1 text-sm text-surface-500-400">
          强支持、弱支持和相反证据并列保存；更正时旧记录标记失效并保留原始字段与更正原因，不静默覆盖。
        </p>
      </div>
      <span class="badge">{signal.evidence.filter((e) => !e.superseded).length} 项有效 / {signal.evidence.length} 项含历史</span>
    </div>
    <EvidenceMatrix evidence={signal.evidence} on:correct={(event) => (correcting = event.detail)} />
  </section>

  {#if correcting}
    <section class="mb-6 rounded border-2 border-orange-400 bg-orange-50 p-4">
      <div class="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 class="font-semibold">更正证据记录：{correcting.title}</h2>
          <p class="mt-1 text-sm text-surface-700-300">
            提交后原记录标记失效并保留，新记录接续；台账、批次追踪、趋势核对的当前读数即刻失效并启动重算，确认前继续展示上一版完整结果。
          </p>
        </div>
        <button class="btn btn-sm variant-ghost-surface" type="button" on:click={() => (correcting = null)}>取消更正</button>
      </div>
      <form
        class="grid gap-4 md:grid-cols-2"
        method="POST"
        action="?/correctEvidence"
        use:enhance={evidenceCorrectHandler}
      >
        <input type="hidden" name="id" value={signal.id} />
        <input type="hidden" name="evidenceId" value={correcting.id} />
        <label>
          <span class="mb-1 block text-sm font-medium">证据类型</span>
          <select class="select" name="evidenceType" value={correcting.type}>
            <option value="complaint">投诉</option>
            <option value="repair">维修</option>
            <option value="adverse_event">不良事件</option>
            <option value="field_report">现场报告</option>
            <option value="test">测试</option>
            <option value="literature">文献</option>
          </select>
        </label>
        <label>
          <span class="mb-1 block text-sm font-medium">证据强度</span>
          <select class="select" name="strength" value={correcting.strength}>
            {#each strengthOptions as option}
              <option value={option.value}>{option.label}</option>
            {/each}
          </select>
        </label>
        <label>
          <span class="mb-1 block text-sm font-medium">证据名称</span>
          <input class="input" name="title" value={correcting.title} />
        </label>
        <label>
          <span class="mb-1 block text-sm font-medium">来源</span>
          <input class="input" name="source" value={correcting.source} />
        </label>
        <label>
          <span class="mb-1 block text-sm font-medium">关联批号</span>
          <input class="input" name="batch" value={correcting.batch} />
        </label>
        <label>
          <span class="mb-1 block text-sm font-medium">更正人</span>
          <input class="input" name="actor" value={signal.owner} />
        </label>
        <label>
          <span class="mb-1 block text-sm font-medium">该证据支撑的报告数（台账读数依据）</span>
          <input class="input" name="reports" type="number" min="0" value={correcting.reports ?? 0} />
        </label>
        <label>
          <span class="mb-1 block text-sm font-medium">覆盖暴露台数</span>
          <input class="input" name="exposed" type="number" min="0" value={correcting.exposed ?? 0} />
        </label>
        <label class="md:col-span-2">
          <span class="mb-1 block text-sm font-medium">更正后的核查说明</span>
          <textarea class="textarea" name="note" rows="2">{correcting.note}</textarea>
        </label>
        <label class="md:col-span-2">
          <span class="mb-1 block text-sm font-medium text-orange-800">更正原因（将写入审计与旧记录，解释当时依据为何被取代）</span>
          <textarea class="textarea" name="reason" rows="2" placeholder="例如：安全团队核对原始工单后，确认其中 5 条报告属重复登记"></textarea>
        </label>
        {#if form?.message}
          <p class="rounded bg-error-100 p-3 text-sm text-error-900 md:col-span-2">{form.message}</p>
        {/if}
        <div class="md:col-span-2">
          <button class="btn variant-filled-secondary" type="submit">提交更正并使受影响读数失效</button>
        </div>
      </form>
    </section>
  {/if}

  <div class="grid gap-6 xl:grid-cols-2">
    <section class="rounded border border-surface-300-700 bg-surface-100-900 p-4">
      <h2 class="font-semibold">补充核查证据</h2>
      <form
        class="mt-4 grid gap-4 md:grid-cols-2"
        method="POST"
        action="?/evidence"
        use:enhance={() =>
          async ({ result, update }) => {
            if (result.type === 'success') {
              const payload = result.data as { evidence?: EvidenceItem; actor?: string };
              if (payload.evidence) signalStore.addEvidence(signal.id, payload.evidence, payload.actor ?? signal.owner);
            }
            await update({ reset: true });
          }}
      >
        <input type="hidden" name="id" value={signal.id} />
        <label>
          <span class="mb-1 block text-sm font-medium">证据类型</span>
          <select class="select" name="evidenceType">
            <option value="complaint">投诉</option>
            <option value="repair">维修</option>
            <option value="adverse_event">不良事件</option>
            <option value="field_report">现场报告</option>
            <option value="test">测试</option>
            <option value="literature">文献</option>
          </select>
        </label>
        <label>
          <span class="mb-1 block text-sm font-medium">证据强度</span>
          <select class="select" name="strength">
            <option value="strong">强支持</option>
            <option value="moderate">中等支持</option>
            <option value="weak">弱支持</option>
            <option value="contrary">相反证据</option>
          </select>
        </label>
        <label>
          <span class="mb-1 block text-sm font-medium">证据名称</span>
          <input class="input" name="title" />
        </label>
        <label>
          <span class="mb-1 block text-sm font-medium">来源</span>
          <input class="input" name="source" />
        </label>
        <label>
          <span class="mb-1 block text-sm font-medium">关联批号</span>
          <input class="input" name="batch" value={signal.batch} />
        </label>
        <label>
          <span class="mb-1 block text-sm font-medium">录入人</span>
          <input class="input" name="actor" value={signal.owner} />
        </label>
        <label class="md:col-span-2">
          <span class="mb-1 block text-sm font-medium">核查说明</span>
          <textarea class="textarea" name="note" rows="3"></textarea>
        </label>
        <div class="md:col-span-2">
          <button class="btn variant-filled-primary" type="submit">加入证据矩阵</button>
        </div>
      </form>
    </section>

    <section class="rounded border border-surface-300-700 bg-surface-100-900 p-4">
      <h2 class="font-semibold">形成结论版本</h2>
      <form
        class="mt-4 grid gap-4 md:grid-cols-2"
        method="POST"
        action="?/version"
        use:enhance={() =>
          async ({ result, update }) => {
            if (result.type === 'success') {
              const payload = result.data as { version?: CaseVersion; actor?: string };
              if (payload.version) signalStore.addVersion(signal.id, payload.version, payload.actor ?? signal.owner);
            }
            await update({ reset: true });
          }}
      >
        <input type="hidden" name="id" value={signal.id} />
        <input type="hidden" name="versionNumber" value={nextVersion} />
        <label>
          <span class="mb-1 block text-sm font-medium">版本作者</span>
          <input class="input" name="author" value={signal.owner} />
        </label>
        <label>
          <span class="mb-1 block text-sm font-medium">建议处置</span>
          <select class="select" name="disposition">
            <option value="continue_observation">继续观察</option>
            <option value="risk_communication">风险沟通</option>
            <option value="corrective_action">纠正措施</option>
          </select>
        </label>
        <label class="md:col-span-2">
          <span class="mb-1 block text-sm font-medium">结论摘要</span>
          <textarea class="textarea" name="summary" rows="2"></textarea>
        </label>
        <label class="md:col-span-2">
          <span class="mb-1 block text-sm font-medium">判断依据与替代解释</span>
          <textarea class="textarea" name="rationale" rows="3"></textarea>
        </label>
        <div class="md:col-span-2">
          <button class="btn variant-filled-secondary" type="submit">保存为 V{nextVersion}</button>
        </div>
      </form>
    </section>
  </div>

  <div class="mt-6 grid gap-6 xl:grid-cols-2">
    <section class="rounded border border-surface-300-700 bg-surface-100-900 p-4">
      <h2 class="font-semibold">结论版本</h2>
      <div class="mt-4 space-y-4">
        {#each signal.versions as version}
          <article class="border-l-2 border-teal-600 pl-4">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <p class="font-medium">V{version.version} · {version.author}</p>
              <span class="text-xs text-surface-500-400">{version.createdAt.slice(0, 10)}</span>
            </div>
            <p class="mt-2 text-sm">{version.summary}</p>
            <p class="mt-2 text-xs text-surface-500-400">{version.rationale}</p>
          </article>
        {:else}
          <p class="text-sm text-surface-500-400">尚未形成正式结论版本。</p>
        {/each}
      </div>
    </section>

    <section class="rounded border border-surface-300-700 bg-surface-100-900 p-4">
      <h2 class="font-semibold">读数版本依据（台账 / 批次 / 趋势同源）</h2>
      <div class="mt-4 space-y-4">
        <article class="border-l-2 border-teal-600 pl-4">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <p class="font-medium">V{signal.readings.version}（当前版本{stale ? '·上一版结果展示中' : ''}）</p>
            <span class="text-xs text-surface-500-400">
              {signal.readings.confirmedBy} 确认于 {signal.readings.confirmedAt?.slice(0, 10)}
            </span>
          </div>
          <p class="mt-2 text-xs leading-5 text-surface-600-300">{signal.readings.basis}</p>
          <p class="mt-1 text-xs text-surface-500-400">复核依据：{signal.readings.confirmNote}</p>
        </article>
        {#each signal.readingsHistory as item}
          <article class="border-l-2 border-surface-400-600 pl-4 opacity-80">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <p class="font-medium">V{item.version}（历史版本，已被替代）</p>
              <span class="text-xs text-surface-500-400">
                {item.confirmedBy} 确认于 {item.confirmedAt?.slice(0, 10)}
              </span>
            </div>
            <p class="mt-2 text-xs text-surface-600-300">
              {item.reportCount} 条 / {item.exposedUnits} 台 / {item.occurrenceRate.toFixed(2)}% / 批号
              {item.affectedBatches.join('、')}
            </p>
            <p class="mt-1 text-xs leading-5 text-surface-600-300">{item.basis}</p>
            <p class="mt-1 text-xs text-surface-500-400">当时复核依据：{item.confirmNote}</p>
          </article>
        {/each}
      </div>
    </section>
  </div>

  <div class="mt-6 grid gap-6 xl:grid-cols-2">
    <section class="rounded border border-surface-300-700 bg-surface-100-900 p-4">
      <h2 class="font-semibold">审计记录</h2>
      <div class="mt-4 space-y-5">
        {#each signal.audit as entry}
          <div class="timeline-item">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <p class="text-sm font-medium">{entry.action} · {entry.actor}</p>
              <span class="text-xs text-surface-500-400">{entry.createdAt.slice(0, 16).replace('T', ' ')}</span>
            </div>
            <p class="mt-1 text-xs text-surface-500-400">{entry.detail}</p>
          </div>
        {/each}
      </div>
    </section>
  </div>
{/if}
