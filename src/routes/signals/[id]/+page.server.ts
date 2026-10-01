import { fail } from '@sveltejs/kit';
import { evidenceSchema, transitionSchema, versionSchema } from '$lib/models/signal';
import { confirmReadingSchema, correctEvidenceSchema } from '$lib/models/recalc';

export function load({ params }) {
  return { id: params.id };
}

const actorName = (formData: FormData) => String(formData.get('actor') ?? '安全评审专员');

function failure(error: { issues: Array<{ message: string }> }) {
  return fail(400, {
    message: error.issues[0]?.message ?? '表单校验失败'
  });
}

export const actions = {
  transition: async ({ request }) => {
    const formData = await request.formData();
    const parsed = transitionSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return failure(parsed.error);

    return {
      success: true,
      transition: parsed.data
    };
  },

  evidence: async ({ request }) => {
    const formData = await request.formData();
    const parsed = evidenceSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return failure(parsed.error);

    return {
      success: true,
      evidence: {
        id: `E-${Date.now().toString(36)}`,
        type: parsed.data.evidenceType,
        title: parsed.data.title,
        source: parsed.data.source,
        strength: parsed.data.strength,
        batch: parsed.data.batch,
        reports: parsed.data.reports,
        note: parsed.data.note,
        createdAt: new Date().toISOString()
      },
      actor: actorName(formData)
    };
  },

  /** 更正证据：服务端先做 Zod 校验，客户端据此保存前后值、失效旧读数并提交重算 */
  correct: async ({ request }) => {
    const formData = await request.formData();
    const parsed = correctEvidenceSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return failure(parsed.error);

    return {
      success: true,
      correction: {
        id: parsed.data.id,
        evidenceId: parsed.data.evidenceId,
        actor: parsed.data.actor,
        reason: parsed.data.reason,
        after: {
          title: parsed.data.title,
          source: parsed.data.source,
          strength: parsed.data.strength,
          batch: parsed.data.batch,
          note: parsed.data.note,
          reports: parsed.data.reports
        }
      }
    };
  },

  /** 复核人确认新版本读数（台账/批次/趋势一起换版） */
  confirm: async ({ request }) => {
    const formData = await request.formData();
    const parsed = confirmReadingSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return failure(parsed.error);

    return {
      success: true,
      confirmation: parsed.data
    };
  },

  version: async ({ request }) => {
    const formData = await request.formData();
    const parsed = versionSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return failure(parsed.error);

    return {
      success: true,
      version: {
        id: `V-${Date.now().toString(36)}`,
        version: Number(formData.get('versionNumber') ?? 1),
        author: parsed.data.author,
        summary: parsed.data.summary,
        disposition: parsed.data.disposition,
        rationale: parsed.data.rationale,
        createdAt: new Date().toISOString()
      },
      actor: parsed.data.author
    };
  },

  reopen: async ({ request }) => {
    const formData = await request.formData();
    const actor = actorName(formData);
    const reason = String(formData.get('reason') ?? '').trim();
    const id = String(formData.get('id') ?? '');

    if (reason.length < 6) return fail(400, { message: '重新打开原因至少 6 个字符。' });

    return {
      success: true,
      reopen: { id, actor, reason, createdAt: new Date().toISOString() }
    };
  }
};
