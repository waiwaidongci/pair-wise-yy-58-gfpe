import type {
  ActorRole,
  ConflictDecision,
  ConflictRule,
  ConflictReview,
  InvalidatedSign,
  LiftStep,
  ServerComment,
  ServerConflictReview,
  ServerSignOff,
  ServerState,
  ServerStep,
  SignRole
} from './types';

export interface DerivedConflict {
  id: string;
  stepId: string;
  rule: ConflictRule;
  message: string;
  severity: 'high' | 'medium';
}

/** 规则引擎：由步骤参数派生当前仍存在的规则冲突，冲突 id 与步骤+规则绑定 */
export function deriveConflicts(steps: LiftStep[]): DerivedConflict[] {
  const issues: Array<{ stepId: string; rule: ConflictRule; message: string; blocked: boolean }> = [];
  for (const step of steps) {
    if (step.loadRate > 90) issues.push({ stepId: step.id, rule: 'loadRate', message: `荷载率 ${step.loadRate}% 超过 90% 阈值`, blocked: step.status === 'blocked' });
    if (step.clearance < 1.5) issues.push({ stepId: step.id, rule: 'clearance', message: `净空 ${step.clearance}m 小于 1.5m`, blocked: step.status === 'blocked' });
    if (step.wind > 8) issues.push({ stepId: step.id, rule: 'wind', message: `风速 ${step.wind}m/s 超过暂停值`, blocked: step.status === 'blocked' });
    if (step.radius > step.boom * 0.62) issues.push({ stepId: step.id, rule: 'radius', message: '工作半径接近额定幅度', blocked: step.status === 'blocked' });
  }
  return issues.map((issue) => ({
    id: `${issue.stepId}:${issue.rule}`,
    stepId: issue.stepId,
    rule: issue.rule,
    message: issue.message,
    severity: issue.blocked ? 'high' : 'medium'
  }));
}

export function reviewFor(conflict: DerivedConflict, reviews: ConflictReview[]): ConflictReview | undefined {
  return reviews.find((item) => item.id === conflict.id);
}

export const CONFLICT_DECISIONS: ConflictDecision[] = ['pending', 'mitigated', 'false-alarm'];

/**
 * 各角色会签管辖的步骤字段。参数变化时只有管辖该字段的角色会签失效，
 * 未受影响的角色签署继续有效，避免一方改参数盖掉全部会签。
 */
export const STEP_FIELD_ROLES: Record<string, SignRole[]> = {
  loadRate: ['设备', '方案'],
  clearance: ['安全'],
  wind: ['安全'],
  radius: ['设备', '方案'],
  boom: ['设备', '方案'],
  time: ['总包'],
  title: ['总包'],
  status: ['总包', '现场', '安全', '设备', '方案'] as SignRole[],
  note: ['总包', '现场', '安全', '设备', '方案'] as SignRole[]
};

const STEP_SCOPE_FIELDS: Record<SignRole, string[]> = {
  设备: ['loadRate', 'radius', 'boom', 'status', 'note'],
  安全: ['clearance', 'wind', 'status', 'note'],
  总包: ['time', 'title', 'status', 'note'],
  方案: ['loadRate', 'radius', 'boom', 'status', 'note']
};

export const ROLE_SCOPE_LABEL: Record<SignRole, string> = {
  总包: '吊装工序与场地移交',
  设备: '吊车参数与支腿地基',
  安全: '净空、风速与冲突结论',
  方案: '载荷计算、路径参数与冲突结论'
};

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`)
    .join(',')}}`;
}

function hash(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i += 1) {
    h = ((h << 5) + h + input.charCodeAt(i)) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** 签署指纹：角色只覆盖自己管辖的数据，安全/总包还覆盖开放意见，安全/方案还覆盖冲突结论 */
export function scopeDigest(role: SignRole, data: {
  steps: LiftStep[];
  comments: Pick<ServerComment, 'stepId' | 'content' | 'status' | 'id'>[];
  conflicts: Pick<ServerConflictReview, 'id' | 'decision' | 'conclusion'>[];
}): string {
  const stepSlice = data.steps.map((step) => {
    const picked: Record<string, unknown> = { id: step.id };
    for (const field of STEP_SCOPE_FIELDS[role]) picked[field] = (step as unknown as Record<string, unknown>)[field];
    return picked;
  });
  const parts: unknown[] = [stepSlice];
  if (role === '安全' || role === '总包') {
    parts.push(data.comments.map((comment) => ({ id: comment.id, s: comment.status })));
  }
  if (role === '安全' || role === '方案') {
    parts.push(data.conflicts.map((review) => ({ id: review.id, d: review.decision, c: review.conclusion })));
  }
  return hash(stableStringify(parts));
}

export function fieldRoles(type: 'step' | 'comment' | 'conflict', changedFields: string[]): SignRole[] {
  const roles = new Set<SignRole>();
  if (type === 'step') {
    for (const field of changedFields) (STEP_FIELD_ROLES[field] ?? []).forEach((role) => roles.add(role));
  } else if (type === 'comment') {
    ['安全', '总包'].forEach((role) => roles.add(role as SignRole));
  } else {
    ['安全', '方案'].forEach((role) => roles.add(role as SignRole));
  }
  return [...roles];
}

/** 计算一次提交对已存在会签的影响 */
export function evaluateInvalidations(
  before: ServerState,
  afterSteps: ServerStep[],
  afterComments: ServerComment[],
  afterReviews: ServerConflictReview[]
): InvalidatedSign[] {
  const digestInput = {
    steps: afterSteps,
    comments: afterComments,
    conflicts: afterReviews
  };
  const result: InvalidatedSign[] = [];
  const seen = new Set<SignRole>();
  for (const sign of before.signoffs) {
    const digest = scopeDigest(sign.role, digestInput);
    if (digest !== sign.covers && !seen.has(sign.role)) {
      seen.add(sign.role);
      result.push({ role: sign.role, reason: invalidReason(sign.role, before, afterSteps, afterComments, afterReviews) });
    }
  }
  return result;
}

function invalidReason(
  role: SignRole,
  before: ServerState,
  afterSteps: ServerStep[],
  afterComments: ServerComment[],
  afterReviews: ServerConflictReview[]
): string {
  const labels: string[] = [];
  const fields = STEP_SCOPE_FIELDS[role];
  for (const next of afterSteps) {
    const prev = before.steps.find((item) => item.id === next.id);
    if (!prev) continue;
    for (const field of fields) {
      if ((prev as unknown as Record<string, unknown>)[field] !== (next as unknown as Record<string, unknown>)[field]) {
        labels.push(`${next.id} 参数更新`);
        break;
      }
    }
  }
  if ((role === '安全' || role === '总包') && before.comments.some((comment) => {
    const next = afterComments.find((item) => item.id === comment.id);
    return !next || next.content !== comment.content || next.status !== comment.status;
  })) {
    labels.push('条件评论更新');
  }
  if ((role === '安全' || role === '方案') && before.conflictReviews.some((review) => {
    const next = afterReviews.find((item) => item.id === review.id);
    return !next || next.decision !== review.decision || next.conclusion !== review.conclusion;
  })) {
    labels.push('冲突结论更新');
  }
  return labels.length ? `${role}会签管辖的${[...new Set(labels)].join('、')}` : `${role}会签范围数据已变化`;
}

/** 发布门禁：冲突全部给出结论、无开放意见、四个角色会签全部有效 */
export function releaseBlockers(state: ServerState): string[] {
  const blockers: string[] = [];
  const live = deriveConflicts(state.steps);
  for (const conflict of live) {
    const review = state.conflictReviews.find((item) => item.id === conflict.id);
    if (!review || review.decision === 'pending') blockers.push(`冲突 ${conflict.id} 未给出复核结论`);
  }
  const openComments = state.comments.filter((comment) => comment.status === 'open');
  if (openComments.length) blockers.push(`${openComments.length} 条条件评论未关闭`);
  const roles: SignRole[] = ['总包', '设备', '安全', '方案'];
  for (const role of roles) {
    const sign = state.signoffs.filter((item) => item.role === role).sort((a, b) => b.signedAt.localeCompare(a.signedAt))[0];
    if (!sign) blockers.push(`${role}角色尚未会签`);
    else if (!sign.valid) blockers.push(`${role}角色会签已失效（${sign.invalidReason || '数据已变化'}）`);
  }
  return blockers;
}

export function signoffValid(sign: ServerSignOff, state: ServerState): { valid: boolean; reason: string } {
  const digest = scopeDigest(sign.role, { steps: state.steps, comments: state.comments, conflicts: state.conflictReviews });
  if (digest !== sign.covers) return { valid: false, reason: '管辖数据已更新，签署失效' };
  return { valid: true, reason: '' };
}

export function canSign(role: ActorRole): role is SignRole {
  return role !== '现场';
}
