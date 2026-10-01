import type { Comment, Finding, LiftStep, PlanState, Signoff } from './types';

export const initialSteps: Omit<LiftStep, 'version'>[] = [
  { id: 'S-01', title: '吊车支腿就位与地耐力复核', time: '07:30', loadRate: 0, clearance: 4.2, wind: 3.4, radius: 18, boom: 42, status: 'passed', note: '支腿钢板 2.4m × 2.4m，已完成压实度复检。' },
  { id: 'S-02', title: '空钩回转与障碍物净空检查', time: '08:10', loadRate: 28, clearance: 1.2, wind: 4.1, radius: 22, boom: 46, status: 'blocked', note: '东侧临时配电箱侵入回转半径 0.6m。' },
  { id: 'S-03', title: '桁架试吊离地 300mm', time: '08:45', loadRate: 76, clearance: 2.8, wind: 5.2, radius: 20, boom: 44, status: 'pending', note: '需安全员确认吊点受力均匀。' },
  { id: 'S-04', title: '主吊回转至安装轴线', time: '09:20', loadRate: 83, clearance: 1.8, wind: 6.8, radius: 24, boom: 48, status: 'pending', note: '风速超过 8m/s 立即停止。' },
  { id: 'S-05', title: '双机抬吊姿态调整', time: '10:05', loadRate: 92, clearance: 1.3, wind: 7.2, radius: 27, boom: 52, status: 'blocked', note: '辅吊荷载率超过方案控制值。' },
  { id: 'S-06', title: '就位、临时固定与摘钩', time: '10:50', loadRate: 68, clearance: 2.1, wind: 5.6, radius: 21, boom: 45, status: 'pending', note: '四组临时螺栓到位后方可摘钩。' }
];

export const initialComments: Omit<Comment, 'version'>[] = [
  { id: 'C-11', author: '周工', role: '安全', content: 'S-02 回转路径与配电箱净空不足，请调整吊车站位或迁移配电箱。', status: 'open', stepId: 'S-02' },
  { id: 'C-12', author: '刘明', role: '设备', content: '辅吊支腿下方需要补充路基板，提供地耐力实测记录。', status: 'open', stepId: 'S-05' },
  { id: 'C-13', author: '陈晓', role: '总包', content: '同意主吊选型，建议把第三检查点前移到试吊阶段。', status: 'resolved', stepId: 'S-03' }
];

export function defaultSignoffs(): Signoff[] {
  return [
    { id: 'SIGN-01', role: '现场', person: '陈晓', team: '总包项目部', scope: '吊装工序与场地移交', stepIds: [], state: 'accepted', valid: true, signedAt: '2026-09-18T08:00:00.000Z', basedOnRevision: 4, version: 1 },
    { id: 'SIGN-02', role: '设备', person: '刘明', team: '设备管理', scope: '吊车参数与支腿地基', stepIds: ['S-01', 'S-02', 'S-05'], state: 'pending', valid: true, signedAt: null, basedOnRevision: null, version: 1 },
    { id: 'SIGN-03', role: '安全', person: '周工', team: '安全监督', scope: '净空、风速与警戒区', stepIds: ['S-02', 'S-04', 'S-05'], state: 'reserved', valid: true, signedAt: null, basedOnRevision: null, version: 1 },
    { id: 'SIGN-04', role: '方案', person: '赵磊', team: '方案工程', scope: '载荷计算与路径参数', stepIds: ['S-03', 'S-04', 'S-05', 'S-06'], state: 'pending', valid: true, signedAt: null, basedOnRevision: null, version: 1 }
  ];
}

export function ruleIssues(step: LiftStep): { rule: string; severity: 'high' | 'medium'; message: string }[] {
  const issues: { rule: string; severity: 'high' | 'medium'; message: string }[] = [];
  if (step.loadRate > 90) issues.push({ rule: 'load-rate', severity: 'high', message: `荷载率 ${step.loadRate}% 超过 90% 阈值` });
  if (step.clearance < 1.5) issues.push({ rule: 'clearance', severity: step.status === 'blocked' ? 'high' : 'medium', message: `净空 ${step.clearance}m 小于 1.5m` });
  if (step.wind > 8) issues.push({ rule: 'wind', severity: 'high', message: `风速 ${step.wind}m/s 超过暂停值` });
  if (step.radius > step.boom * 0.62) issues.push({ rule: 'radius', severity: 'medium', message: '工作半径接近额定幅度' });
  return issues;
}

/**
 * 规则引擎根据步骤参数重新生成冲突项；
 * 已有的冲突项保留其状态、结论和版本，规则不再触发的标记为已关闭。
 */
export function recomputeFindings(steps: LiftStep[], existing: Finding[]): Finding[] {
  const result: Finding[] = [];
  for (const step of steps) {
    for (const issue of ruleIssues(step)) {
      const fid = `F-${step.id}-${issue.rule}`;
      const prev = existing.find((f) => f.id === fid);
      if (prev) {
        const changed = prev.severity !== issue.severity || prev.message !== issue.message;
        result.push({ ...prev, severity: issue.severity, message: issue.message, stepId: step.id, version: changed ? prev.version + 1 : prev.version });
      } else {
        result.push({ id: fid, stepId: step.id, severity: issue.severity, rule: issue.rule, message: issue.message, status: 'open', conclusion: '', version: 1 });
      }
    }
  }
  for (const f of existing) {
    if (!result.some((r) => r.id === f.id)) result.push({ ...f, status: 'resolved' });
  }
  return result;
}

export function seedPlan(): PlanState {
  const steps: LiftStep[] = initialSteps.map((s) => ({ ...s, version: 1 }));
  const comments: Comment[] = initialComments.map((c) => ({ ...c, version: 1 }));
  const findings = recomputeFindings(steps, []);
  return {
    revision: 4,
    steps,
    comments,
    findings,
    signoffs: defaultSignoffs(),
    lock: { locked: false, revision: null, lockedBy: null, lockedAt: null, version: 1 }
  };
}
