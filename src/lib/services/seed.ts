import type { SignalCase, SignalReadings } from '$lib/models/signal';

function baselineReadings(input: {
  version?: number;
  reportCount: number;
  exposedUnits: number;
  riskLevel: SignalReadings['riskLevel'];
  affectedBatches: string[];
  basis: string;
  confirmedAt: string;
  confirmedBy: string;
}): SignalReadings {
  return {
    version: input.version ?? 1,
    reportCount: input.reportCount,
    exposedUnits: input.exposedUnits,
    occurrenceRate:
      input.exposedUnits > 0
        ? Math.round((input.reportCount / input.exposedUnits) * 10000) / 100
        : 0,
    riskLevel: input.riskLevel,
    affectedBatches: input.affectedBatches,
    basis: input.basis,
    confirmedAt: input.confirmedAt,
    confirmedBy: input.confirmedBy,
    confirmNote: '台账、批次追踪与趋势核对三处一致的初始基线读数。'
  };
}

export const seedSignals: SignalCase[] = [
  {
    id: 'SIG-2026-018',
    title: '输注泵阻塞报警集中发生于同一批管路',
    product: '智能输液泵 IP-800',
    batch: 'IP8-260401',
    sourceType: 'complaint',
    status: 'investigating',
    riskLevel: 'high',
    severity: 4,
    reportCount: 17,
    exposedUnits: 2048,
    occurrenceRate: 0.83,
    occurredAt: '2026-09-08',
    openedAt: '2026-09-09T02:10:00.000Z',
    updatedAt: '2026-09-28T08:30:00.000Z',
    owner: '周宁',
    description: '投诉、维修与现场报告均出现阻塞压力提前触发，集中在同一批高分子管路。',
    affectedBatches: ['IP8-260401', 'IP8-260403'],
    readings: baselineReadings({
      reportCount: 17,
      exposedUnits: 2048,
      riskLevel: 'high',
      affectedBatches: ['IP8-260401', 'IP8-260403'],
      basis:
        'V1 基线：合并投诉工单 11 条与维修记录 6 条（共 17 条），暴露台数取两批管路装机量 2048 台；批号覆盖 IP8-260401 与留样批 IP8-260403；相反证据（留样测试）报告数计 0。',
      confirmedAt: '2026-09-24T10:00:00.000Z',
      confirmedBy: '周宁'
    }),
    readingsHistory: [],
    evidence: [
      {
        id: 'E-018-01',
        type: 'complaint',
        title: '华东区域 11 起同类投诉',
        source: '客服工单系统',
        strength: 'strong',
        batch: 'IP8-260401',
        note: '报警发生时间集中在装机后第 7 至 14 天。',
        createdAt: '2026-09-09T02:30:00.000Z',
        reports: 11,
        exposed: 2048
      },
      {
        id: 'E-018-02',
        type: 'repair',
        title: '压力传感器零点漂移记录',
        source: '维修记录 R-9081',
        strength: 'moderate',
        batch: 'IP8-260401',
        note: '更换传感器后 3 台设备未复现，不能排除装配扭矩影响。',
        createdAt: '2026-09-14T06:20:00.000Z',
        reports: 6,
        exposed: 2048
      },
      {
        id: 'E-018-03',
        type: 'test',
        title: '留样压力曲线对比',
        source: '可靠性实验室',
        strength: 'contrary',
        batch: 'IP8-260403',
        note: '留样在标准测试条件下未出现同类波动，需补充现场使用条件。',
        createdAt: '2026-09-24T09:15:00.000Z',
        reports: 0,
        exposed: 2048
      }
    ],
    tasks: [
      {
        id: 'T-018-01',
        title: '核对现场使用环境与安装扭矩',
        owner: '赵珂',
        dueAt: '2026-10-03',
        status: 'in_progress'
      },
      {
        id: 'T-018-02',
        title: '追回异常批次传感器装配记录',
        owner: '陈明',
        dueAt: '2026-10-05',
        status: 'open'
      }
    ],
    versions: [
      {
        id: 'V-018-01',
        version: 1,
        author: '周宁',
        summary: '投诉与维修记录支持传感器装配异常假设，尚需现场数据确认。',
        disposition: 'continue_observation',
        rationale: '实验室留样未复现，当前证据不足以直接启动召回。',
        createdAt: '2026-09-24T10:00:00.000Z'
      }
    ],
    audit: [
      {
        id: 'A-018-01',
        actor: '系统',
        action: '自动聚类',
        detail: '按产品、批号和阻塞故障模式合并 17 条报告。',
        createdAt: '2026-09-09T02:10:00.000Z'
      },
      {
        id: 'A-018-02',
        actor: '周宁',
        action: '转入调查',
        detail: '风险等级调整为高，并建立现场核查任务。',
        createdAt: '2026-09-10T03:00:00.000Z'
      }
    ],
    reopenedCount: 0
  },
  {
    id: 'SIG-2026-015',
    title: '监护仪电池续航低于标称值',
    product: '多参数监护仪 M12',
    batch: 'M12-251118',
    sourceType: 'repair',
    status: 'observed',
    riskLevel: 'medium',
    severity: 3,
    reportCount: 9,
    exposedUnits: 876,
    occurrenceRate: 1.03,
    occurredAt: '2026-08-22',
    openedAt: '2026-08-23T05:00:00.000Z',
    updatedAt: '2026-09-25T04:30:00.000Z',
    owner: '林澈',
    description: '医院反馈满电后连续使用时间下降约 23%，尚未发现患者伤害。',
    affectedBatches: ['M12-251118'],
    readings: baselineReadings({
      reportCount: 9,
      exposedUnits: 876,
      riskLevel: 'medium',
      affectedBatches: ['M12-251118'],
      basis:
        'V1 基线：区域维修中心容量测试覆盖 6 台、现场服务报告补充 3 条（共 9 条），暴露台数取该批装机量 876 台；批号覆盖 M12-251118；弱支持证据未重复计报告。',
      confirmedAt: '2026-09-25T04:25:00.000Z',
      confirmedBy: '林澈'
    }),
    readingsHistory: [],
    evidence: [
      {
        id: 'E-015-01',
        type: 'repair',
        title: '电池容量测试记录',
        source: '区域维修中心',
        strength: 'strong',
        batch: 'M12-251118',
        note: '6 台设备容量均低于出厂规格下限。',
        createdAt: '2026-08-25T03:10:00.000Z',
        reports: 9,
        exposed: 876
      },
      {
        id: 'E-015-02',
        type: 'field_report',
        title: '充电柜批次核查',
        source: '现场服务报告 F-771',
        strength: 'weak',
        batch: 'M12-251118',
        note: '两家医院使用相同型号充电柜，使用条件尚不一致。',
        createdAt: '2026-09-02T07:20:00.000Z',
        reports: 0,
        exposed: 876
      }
    ],
    tasks: [
      {
        id: 'T-015-01',
        title: '汇总近六个月容量衰减曲线',
        owner: '林澈',
        dueAt: '2026-10-02',
        status: 'in_progress'
      }
    ],
    versions: [
      {
        id: 'V-015-01',
        version: 1,
        author: '林澈',
        summary: '维持观察，补充充电环境分层分析。',
        disposition: 'continue_observation',
        rationale: '暂无临床风险升级证据，但衰减比例超出预期。',
        createdAt: '2026-09-25T04:25:00.000Z'
      }
    ],
    audit: [
      {
        id: 'A-015-01',
        actor: '林澈',
        action: '建立信号',
        detail: '合并相同故障模式的维修记录。',
        createdAt: '2026-08-23T05:00:00.000Z'
      }
    ],
    reopenedCount: 0
  },
  {
    id: 'SIG-2026-011',
    title: '影像工作站测量工具结果偶发偏差',
    product: '影像工作站 WS-5',
    batch: 'SW-5.3.1',
    sourceType: 'field_report',
    status: 'closed',
    riskLevel: 'low',
    severity: 2,
    reportCount: 4,
    exposedUnits: 310,
    occurrenceRate: 1.29,
    occurredAt: '2026-06-11',
    openedAt: '2026-06-12T01:40:00.000Z',
    updatedAt: '2026-08-18T09:30:00.000Z',
    owner: '高远',
    description: '测量结果在切换显示器缩放比例后发生偏差，重启软件可恢复。',
    affectedBatches: ['SW-5.3.1'],
    readings: baselineReadings({
      reportCount: 4,
      exposedUnits: 310,
      riskLevel: 'low',
      affectedBatches: ['SW-5.3.1'],
      basis:
        'V1 基线：合并 4 条现场测量偏差报告，暴露台数取 5.3.1 版本装机 310 台；批号（软件版本）覆盖 SW-5.3.1。',
      confirmedAt: '2026-08-18T09:30:00.000Z',
      confirmedBy: '高远'
    }),
    readingsHistory: [],
    evidence: [
      {
        id: 'E-011-01',
        type: 'test',
        title: '5.3.2 修复版本回归报告',
        source: '软件测试报告 TR-4402',
        strength: 'strong',
        batch: 'SW-5.3.1',
        note: '连续执行 500 次缩放切换未复现。',
        createdAt: '2026-08-10T02:00:00.000Z',
        reports: 4,
        exposed: 310
      }
    ],
    tasks: [
      {
        id: 'T-011-01',
        title: '跟踪修复版本部署与残余投诉',
        owner: '高远',
        dueAt: '2026-09-20',
        status: 'done'
      }
    ],
    versions: [
      {
        id: 'V-011-01',
        version: 1,
        author: '高远',
        summary: '确认版本修复有效，关闭信号并保留 90 天监测。',
        disposition: 'corrective_action',
        rationale: '修复版本已解决绘制坐标缓存问题。',
        createdAt: '2026-08-18T09:30:00.000Z'
      }
    ],
    audit: [
      {
        id: 'A-011-01',
        actor: '高远',
        action: '关闭信号',
        detail: '修复版本部署完成，残余投诉为零。',
        createdAt: '2026-08-18T09:30:00.000Z'
      }
    ],
    reopenedCount: 0
  },
  {
    id: 'SIG-2026-019',
    title: '除颤器充电过程温升异常',
    product: '双相波除颤器 D9',
    batch: 'D9-260722',
    sourceType: 'adverse_event',
    status: 'action_required',
    riskLevel: 'critical',
    severity: 5,
    reportCount: 3,
    exposedUnits: 120,
    occurrenceRate: 2.5,
    occurredAt: '2026-09-21',
    openedAt: '2026-09-22T00:20:00.000Z',
    updatedAt: '2026-09-28T11:40:00.000Z',
    owner: '顾岚',
    description: '一台设备充电模组外壳变形并触发过温保护，现场已停用同批 12 台设备。',
    affectedBatches: ['D9-260722'],
    readings: baselineReadings({
      reportCount: 3,
      exposedUnits: 120,
      riskLevel: 'critical',
      affectedBatches: ['D9-260722'],
      basis:
        'V1 基线：不良事件报告 3 条（含 1 起过温保护触发），暴露台数取同批在用量 120 台；拆机热成像证据不计新增报告；批号覆盖 D9-260722。',
      confirmedAt: '2026-09-28T11:40:00.000Z',
      confirmedBy: '顾岚'
    }),
    readingsHistory: [],
    evidence: [
      {
        id: 'E-019-01',
        type: 'adverse_event',
        title: '过温保护触发事件报告',
        source: '不良事件报告 AE-260921',
        strength: 'strong',
        batch: 'D9-260722',
        note: '设备未造成人员伤害，但备用电池无法完成充电。',
        createdAt: '2026-09-22T00:30:00.000Z',
        reports: 3,
        exposed: 120
      },
      {
        id: 'E-019-02',
        type: 'test',
        title: '首批拆机与热成像记录',
        source: '质量实验室',
        strength: 'strong',
        batch: 'D9-260722',
        note: '两套模组焊点阻抗偏高，温度高于控制上限。',
        createdAt: '2026-09-27T08:00:00.000Z',
        reports: 0,
        exposed: 120
      }
    ],
    tasks: [
      {
        id: 'T-019-01',
        title: '完成同批全量风险评估',
        owner: '顾岚',
        dueAt: '2026-09-30',
        status: 'in_progress'
      },
      {
        id: 'T-019-02',
        title: '起草医疗机构风险沟通函',
        owner: '沈瑜',
        dueAt: '2026-09-30',
        status: 'open'
      }
    ],
    versions: [
      {
        id: 'V-019-01',
        version: 1,
        author: '顾岚',
        summary: '初判为充电模组焊接缺陷，进入纠正措施与风险沟通准备。',
        disposition: 'risk_communication',
        rationale: '已有拆机证据支持批次性制造偏差。',
        createdAt: '2026-09-28T11:40:00.000Z'
      }
    ],
    audit: [
      {
        id: 'A-019-01',
        actor: '顾岚',
        action: '升级风险',
        detail: '严重度评级 5，进入纠正措施决策。',
        createdAt: '2026-09-28T11:40:00.000Z'
      }
    ],
    reopenedCount: 0
  }
];
