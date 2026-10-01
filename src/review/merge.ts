// 冲突退回后的三种处理：保留双方（both）、保留一方（mine/theirs）、按字段合并（fields）。
import type {
  BatchChange,
  BatchConflict,
  ConflictResolution,
  LiftStep,
  MergeStrategy,
  ObjectType,
  ServerComment,
  ServerConflictReview,
  ServerSignOff,
  ServerStep,
  StepStatus
} from './types';

const STEP_MERGE_FIELDS = ['title', 'time', 'loadRate', 'clearance', 'wind', 'radius', 'boom', 'status', 'note'] as const;
const COMMENT_MERGE_FIELDS = ['content', 'status'] as const;
const CONFLICT_MERGE_FIELDS = ['decision', 'conclusion'] as const;
const SIGN_MERGE_FIELDS = ['covers'] as const;

export function mergeableFields(type: ObjectType): string[] {
  switch (type) {
    case 'step':
      return [...STEP_MERGE_FIELDS];
    case 'comment':
      return [...COMMENT_MERGE_FIELDS];
    case 'conflict':
      return [...CONFLICT_MERGE_FIELDS];
    case 'signoff':
      return [...SIGN_MERGE_FIELDS];
  }
}

export function changedFieldsOf(base: unknown, mine: unknown, type: ObjectType): string[] {
  const baseObj = (base ?? {}) as Record<string, unknown>;
  const mineObj = (mine ?? {}) as Record<string, unknown>;
  return mergeableFields(type).filter((field) => JSON.stringify(baseObj[field]) !== JSON.stringify(mineObj[field]));
}

/** 服务端他人版本中，与我这一批提交产生差异的字段（即他们改过、我基线里没有的） */
export function driftedFields(base: unknown, theirs: unknown, type: ObjectType): string[] {
  const baseObj = (base ?? {}) as Record<string, unknown>;
  const theirsObj = (theirs ?? {}) as Record<string, unknown>;
  return mergeableFields(type).filter((field) => JSON.stringify(baseObj[field]) !== JSON.stringify(theirsObj[field]));
}

const STATUS_RANK: Record<StepStatus, number> = { passed: 0, pending: 1, blocked: 2 };

function conservativeNumber(a: number, b: number, field: string): number {
  // 荷载率/风速取更高风险值（更大），净空取更高风险值（更小）；其余参数取双方记录（数值取较保守一侧）
  if (field === 'clearance') return Math.min(a, b);
  return Math.max(a, b);
}

function conservativeStatus(a: StepStatus, b: StepStatus): StepStatus {
  return STATUS_RANK[a] >= STATUS_RANK[b] ? a : b;
}

function joinNote(a: string, b: string, mineBy: string, theirsBy: string): string {
  const left = `【保留本方 ${mineBy}】${a}`;
  const right = `【保留对方 ${theirsBy}】${b}`;
  return `${left}\n${right}`;
}

/** 保留双方：数值取双方（按安全保守侧落地），文本拼接双稿，结论取更严格一侧，双方修改都不丢 */
export function mergeKeepBoth(
  type: ObjectType,
  mine: Record<string, unknown>,
  theirs: Record<string, unknown>,
  mineBy: string,
  theirsBy: string
): Record<string, unknown> {
  if (type === 'step') {
    const out: Record<string, unknown> = { id: mine.id ?? theirs.id };
    for (const field of STEP_MERGE_FIELDS) {
      const a = mine[field];
      const b = theirs[field];
      if (a === b) {
        out[field] = a;
      } else if (field === 'note') {
        out[field] = joinNote(String(a ?? ''), String(b ?? ''), mineBy, theirsBy);
      } else if (field === 'status') {
        out[field] = conservativeStatus(a as StepStatus, b as StepStatus);
      } else if (field === 'title' || field === 'time') {
        out[field] = `${a ?? ''}｜${b ?? ''}`;
      } else {
        out[field] = conservativeNumber(Number(a ?? 0), Number(b ?? 0), field);
      }
    }
    return out;
  }
  if (type === 'comment') {
    return {
      ...theirs,
      ...mine,
      content: aOrB(mine.content, theirs.content, mineBy, theirsBy),
      // 状态取更保守：任一方未解决则保持开放
      status: mine.status === 'open' || theirs.status === 'open' ? 'open' : 'resolved'
    };
  }
  if (type === 'conflict') {
    const rank = { 'false-alarm': 0, pending: 1, mitigated: 2 } as const;
    const pick = rank[(mine.decision as keyof typeof rank) ?? 'pending'] >= rank[(theirs.decision as keyof typeof rank) ?? 'pending'] ? mine : theirs;
    return {
      ...theirs,
      ...mine,
      decision: pick.decision,
      conclusion: aOrB(mine.conclusion, theirs.conclusion, mineBy, theirsBy)
    };
  }
  return { ...theirs, ...mine };
}

function aOrB(a: unknown, b: unknown, mineBy: string, theirsBy: string): string {
  if (a === b) return String(a ?? '');
  return `【本方 ${mineBy}】${a ?? ''}\n【对方 ${theirsBy}】${b ?? ''}`;
}

/** 按字段合并：每个差异字段单独决定保留哪一侧 */
export function mergeByFields(
  type: ObjectType,
  mine: Record<string, unknown>,
  theirs: Record<string, unknown>,
  fieldChoice: Record<string, 'mine' | 'theirs'>
): Record<string, unknown> {
  const out: Record<string, unknown> = { id: mine.id ?? theirs.id };
  for (const field of mergeableFields(type)) {
    const side = fieldChoice[field];
    out[field] = side === 'mine' ? mine[field] : side === 'theirs' ? theirs[field] : mine[field] ?? theirs[field];
  }
  // 保留不在可合并列表中的展示字段（作者、步骤归属等）
  for (const key of Object.keys(theirs)) {
    if (!(key in out)) out[key] = theirs[key];
  }
  return out;
}

/** 按策略计算最终写入载荷（业务字段，不含版本元数据） */
export function applyResolution(
  conflict: BatchConflict,
  resolution: ConflictResolution,
  mineBy: string,
  theirsBy: string
): Record<string, unknown> {
  const mine = (conflict.mine ?? {}) as Record<string, unknown>;
  const theirs = (conflict.theirs ?? {}) as Record<string, unknown>;
  const strategy: MergeStrategy = resolution.strategy;
  if (strategy === 'mine') return { ...theirs, ...mine };
  if (strategy === 'theirs') return { ...mine, ...theirs };
  if (strategy === 'fields') return mergeByFields(conflict.type, mine, theirs, resolution.fields ?? {});
  return mergeKeepBoth(conflict.type, mine, theirs, mineBy, theirsBy);
}

/** 由批次变更 + 基线，重建“我的整批结果”对象（用于冲突对比展示） */
export function buildMinePayload(change: BatchChange): Record<string, unknown> {
  return (change.payload ?? {}) as Record<string, unknown>;
}

export function stripVersion<T extends object>(item: T): Omit<T, 'version' | 'updatedAt' | 'updatedBy'> {
  const { version: _v, updatedAt: _at, updatedBy: _by, ...rest } = item as T & { version?: number; updatedAt?: string; updatedBy?: string };
  return rest;
}

export type { LiftStep, ServerStep, ServerComment, ServerConflictReview, ServerSignOff };
