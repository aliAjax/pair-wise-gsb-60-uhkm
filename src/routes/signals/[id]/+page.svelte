<script lang="ts">
  import { enhance } from '$app/forms';
  import type { SubmitFunction } from '@sveltejs/kit';
  import EvidenceMatrix from '$lib/components/EvidenceMatrix.svelte';
  import ReadingVersionBadge from '$lib/components/ReadingVersionBadge.svelte';
  import RecalcPanel from '$lib/components/RecalcPanel.svelte';
  import RiskBadge from '$lib/components/RiskBadge.svelte';
  import type { AuditEntry, CaseVersion, EvidenceItem, SignalStatus } from '$lib/models/signal';
  import type { EvidenceCorrection } from '$lib/models/recalc';
  import { exportSignalReport } from '$lib/services/signal-service';
  import { readModel } from '$lib/services/recalc-store';
  import { signalStore } from '$lib/stores/signal-store';
  import type { ActionData, PageData } from './$types';

  export let data: PageData;
  export let form: ActionData;

  $: signal = $signalStore.find((item) => item.id === data.id);
  $: nextVersion = (signal?.versions[0]?.version ?? 0) + 1;
  // 台账、批次、趋势三处统一从已发布读数版本取数；重算未确认前这里仍是上一版
  $: published = $readModel.signals.find((item) => item.signalId === data.id);

  // 证据更正表单：打开时冻结"更正前"快照，提交后与更正后字段一起留痕
  let correctingItem: EvidenceItem | null = null;
  let correctingBefore: EvidenceCorrection['before'] | null = null;
  let submittingCorrection = false;
  let correctionError = '';

  function startCorrect(item: EvidenceItem) {
    correctingItem = item;
    correctingBefore = {
      title: item.title,
      source: item.source,
      strength: item.strength,
      batch: item.batch,
      note: item.note,
      reports: item.reports ?? 1
    };
    correctionError = '';
  }

  function cancelCorrect() {
    correctingItem = null;
    correctingBefore = null;
    correctionError = '';
  }

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

  const correctHandler: SubmitFunction = () => {
    return async ({ result, update }) => {
      if (result.type === 'success' && correctingItem && correctingBefore) {
        const payload = result.data as {
          correction?: Omit<EvidenceCorrection, 'before' | 'createdAt' | 'id'> & { id?: string };
        };
        const value = payload.correction;
        if (value) {
          submittingCorrection = true;
          correctionError = '';
          try {
            // 1) 保存更正前后依据并更新证据 → 2) 旧读数失效 → 3) 受理/并入重算作业
            await signalStore.correctEvidence(data.id, {
              evidenceId: value.evidenceId,
              actor: value.actor,
              reason: value.reason,
              before: correctingBefore,
              after: value.after
            });
            cancelCorrect();
          } catch (error) {
            correctionError = (error as Error)?.message ?? '更正提交失败，请重试';
          } finally {
            submittingCorrection = false;
          }
        }
      } else if (result.type !== 'success') {
        correctionError = '表单校验失败，请检查必填项与字数要求。';
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
        <RiskBadge risk={signal.riskLevel} status={signal.status} />
        <ReadingVersionBadge signalId={signal.id} size="md" />
      </div>
    </div>
    <button class="btn variant-soft-primary" type="button" on:click={() => exportSignalReport(signal.id)}>
      导出可追溯报告
    </button>
  </div>

  {#if form?.message}
    <div class="mb-5 rounded border border-error-300 bg-error-50 p-3 text-sm text-error-900">{form.message}</div>
  {/if}

  <RecalcPanel {signal} />

  <section class="workspace-grid mb-6">
    <article class="col-span-12 rounded border border-surface-300-700 bg-surface-100-900 p-4 xl:col-span-8">
      <div class="mb-3 flex items-center justify-between gap-3">
        <p class="text-xs font-medium text-surface-500-400">下列读数来自已发布版本，重算确认前不随证据改动变化</p>
        <ReadingVersionBadge signalId={signal.id} />
      </div>
      <div class="grid gap-5 md:grid-cols-2">
        <div>
          <p class="text-xs font-medium text-surface-500-400">产品与批号</p>
          <p class="mt-1 font-medium">{signal.product}</p>
          <p class="mt-1 text-sm text-surface-600-300">{(published?.affectedBatches ?? signal.affectedBatches).join(' / ')}</p>
        </div>
        <div>
          <p class="text-xs font-medium text-surface-500-400">调查负责人</p>
          <p class="mt-1 font-medium">{signal.owner}</p>
          <p class="mt-1 text-sm text-surface-600-300">最后更新 {signal.updatedAt.slice(0, 16).replace('T', ' ')}</p>
        </div>
        <div>
          <p class="text-xs font-medium text-surface-500-400">报告与暴露（已发布读数）</p>
          <p class="metric-value mt-1 font-medium">{published?.reportCount ?? signal.reportCount} 条 / {published?.exposedUnits ?? signal.exposedUnits} 台</p>
        </div>
        <div>
          <p class="text-xs font-medium text-surface-500-400">核查发生率（已发布读数）</p>
          <p class="metric-value mt-1 font-medium">{(published?.occurrenceRate ?? signal.occurrenceRate).toFixed(2)}%</p>
        </div>
      </div>
      <div class="section-rule mt-5 pt-5">
        <p class="text-sm leading-6 text-surface-700-300">{signal.description}</p>
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
          强支持、弱支持和相反证据并列保存；安全团队更正记录后，旧读数先失效再重算，更正前后均留痕。
        </p>
      </div>
      <span class="badge">{signal.evidence.length} 项证据 · {signal.corrections.length} 次更正</span>
    </div>
    <EvidenceMatrix
      evidence={signal.evidence}
      correctingId={correctingItem?.id ?? null}
      on:correct={(event) => startCorrect(event.detail)}
    />
  </section>

  {#if correctingItem && correctingBefore}
    <section class="mb-6 rounded border-2 border-amber-500 bg-amber-50 p-5">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 class="text-lg font-semibold text-amber-950">更正证据记录 · {correctingItem.id}</h2>
          <p class="mt-1 text-sm text-amber-900">
            提交后：① 保存下表"更正前 → 更正后"；② 台账/批次/趋势中该信号旧读数立即失效（页面仍展示上一版并标明未完成）；③ 受理一个重算作业。
          </p>
        </div>
        <button class="btn btn-sm variant-ghost-surface" type="button" on:click={cancelCorrect}>取消</button>
      </div>

      <form
        class="mt-4 grid gap-4 md:grid-cols-2"
        method="POST"
        action="?/correct"
        use:enhance={correctHandler}
      >
        <input type="hidden" name="id" value={signal.id} />
        <input type="hidden" name="evidenceId" value={correctingItem.id} />

        <div class="rounded border border-amber-300 bg-white/70 p-3 text-xs md:col-span-2">
          <p class="font-semibold text-amber-950">更正前（将保留在更正历史中）</p>
          <div class="mt-2 grid gap-1 md:grid-cols-3">
            <span>名称：{correctingBefore.title}</span>
            <span>来源：{correctingBefore.source}</span>
            <span>批号：{correctingBefore.batch}</span>
            <span>强度：{correctingBefore.strength}</span>
            <span>归因报告：{correctingBefore.reports} 条</span>
          </div>
          <p class="mt-2 text-surface-600-300">说明：{correctingBefore.note}</p>
        </div>

        <label>
          <span class="mb-1 block text-sm font-medium">更正后 · 证据名称</span>
          <input class="input" name="title" value={correctingItem.title} required minlength="4" />
        </label>
        <label>
          <span class="mb-1 block text-sm font-medium">更正后 · 来源</span>
          <input class="input" name="source" value={correctingItem.source} required minlength="2" />
        </label>
        <label>
          <span class="mb-1 block text-sm font-medium">更正后 · 证据强度</span>
          <select class="select" name="strength" value={correctingItem.strength}>
            <option value="strong">强支持</option>
            <option value="moderate">中等支持</option>
            <option value="weak">弱支持</option>
            <option value="contrary">相反证据</option>
          </select>
        </label>
        <label>
          <span class="mb-1 block text-sm font-medium">更正后 · 关联批号</span>
          <input class="input" name="batch" value={correctingItem.batch} required />
        </label>
        <label>
          <span class="mb-1 block text-sm font-medium">更正后 · 归因报告数</span>
          <input class="input" name="reports" type="number" min="0" max="9999" step="1" value={correctingItem.reports ?? 1} required />
        </label>
        <label>
          <span class="mb-1 block text-sm font-medium">操作人</span>
          <input class="input" name="actor" value={signal.owner} required minlength="2" />
        </label>
        <label class="md:col-span-2">
          <span class="mb-1 block text-sm font-medium">更正后 · 核查说明</span>
          <textarea class="textarea" name="note" rows="2" required minlength="4">{correctingItem.note}</textarea>
        </label>
        <label class="md:col-span-2">
          <span class="mb-1 block text-sm font-medium">更正依据（旧记录为何错误，复核人解释当时依据用）</span>
          <textarea class="textarea" name="reason" rows="2" required minlength="6" placeholder="例如：客服工单去重后确认仅 6 起独立投诉，原 11 起含 5 条重复建单"></textarea>
        </label>
        {#if correctionError}
          <p class="text-sm text-red-700 md:col-span-2">{correctionError}</p>
        {/if}
        <div class="md:col-span-2">
          <button class="btn variant-filled-primary" type="submit" disabled={submittingCorrection}>
            {submittingCorrection ? '正在失效旧读数并提交重算…' : '保存更正：失效旧读数并重算'}
          </button>
        </div>
      </form>
    </section>
  {/if}

  {#if signal.corrections.length > 0}
    <section class="mb-6 rounded border border-surface-300-700 bg-surface-100-900 p-4">
      <h2 class="font-semibold">证据更正历史（前后依据）</h2>
      <div class="mt-4 space-y-4">
        {#each signal.corrections as correction (correction.id)}
          <article class="rounded border border-surface-300-700 p-4 text-sm">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <p class="font-medium">{correction.evidenceId} · {correction.actor}</p>
              <span class="text-xs text-surface-500-400">{correction.createdAt.slice(0, 16).replace('T', ' ')}</span>
            </div>
            <div class="mt-3 grid gap-3 md:grid-cols-2">
              <div class="rounded border-l-2 border-surface-400 pl-3">
                <p class="text-xs font-medium text-surface-500-400">更正前</p>
                <p class="mt-1">《{correction.before.title}》· {correction.before.source}</p>
                <p class="mt-1 text-xs text-surface-600-300">
                  批号 {correction.before.batch} · 强度 {correction.before.strength} · 归因 {correction.before.reports} 条
                </p>
                <p class="mt-1 text-xs text-surface-600-300">{correction.before.note}</p>
              </div>
              <div class="rounded border-l-2 border-teal-600 pl-3">
                <p class="text-xs font-medium text-teal-700">更正后</p>
                <p class="mt-1">《{correction.after.title}》· {correction.after.source}</p>
                <p class="mt-1 text-xs text-surface-600-300">
                  批号 {correction.after.batch} · 强度 {correction.after.strength} · 归因 {correction.after.reports} 条
                </p>
                <p class="mt-1 text-xs text-surface-600-300">{correction.after.note}</p>
              </div>
            </div>
            <p class="mt-3 text-xs text-surface-600-300">更正依据：{correction.reason}</p>
          </article>
        {/each}
      </div>
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
          <span class="mb-1 block text-sm font-medium">归因报告数</span>
          <input class="input" name="reports" type="number" min="0" step="1" value="1" />
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
