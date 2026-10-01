// 复核批次领域模型：所有可被多方修改的对象都带版本号，整批基于同一组基线版本提交。

export type StepStatus = 'pending' | 'passed' | 'blocked';

export interface LiftStep {
  id: string;
  title: string;
  time: string;
  loadRate: number;
  clearance: number;
  wind: number;
  radius: number;
  boom: number;
  status: StepStatus;
  note: string;
}

export interface VersionMeta {
  version: number;
  updatedAt: string;
  updatedBy: string;
}

export type ServerStep = LiftStep & VersionMeta;

export type ConflictRule = 'loadRate' | 'clearance' | 'wind' | 'radius';
export type ConflictDecision = 'pending' | 'mitigated' | 'false-alarm';

/** 规则冲突的复核结论，本身也是可并发修改、需要会签覆盖的版本化对象 */
export interface ConflictReview {
  id: string;
  stepId: string;
  rule: ConflictRule;
  message: string;
  decision: ConflictDecision;
  conclusion: string;
  decidedBy: string;
}
export type ServerConflictReview = ConflictReview & VersionMeta;

export interface CommentRec {
  id: string;
  author: string;
  role: string;
  content: string;
  status: 'open' | 'resolved';
  stepId: string;
}
export type ServerComment = CommentRec & VersionMeta;

export type SignRole = '总包' | '设备' | '安全' | '方案';
export type ActorRole = '现场' | SignRole;

export interface SignOff {
  id: string;
  role: SignRole;
  name: string;
  signedAt: string;
  /** 签署时管辖范围的数据指纹；指纹不一致即为失效会签，门禁不得放行 */
  covers: string;
  valid: boolean;
  invalidReason: string;
}
export type ServerSignOff = SignOff & VersionMeta;

export type ObjectType = 'step' | 'comment' | 'conflict' | 'signoff';

export interface PlanMeta {
  id: string;
  name: string;
  revision: number;
  locked: boolean;
  lockedAt: string | null;
  unlockNote: string;
}

export interface ServerState {
  schemaVersion: 2;
  plan: PlanMeta;
  steps: ServerStep[];
  conflictReviews: ServerConflictReview[];
  comments: ServerComment[];
  signoffs: ServerSignOff[];
  seq: number;
  batches: Record<string, { id: string; openedBy: string; role: string; openedAt: string }>;
}

export interface Actor {
  name: string;
  role: ActorRole;
}

/** 批次内单条修改：payload 为完整业务字段（不含版本元数据），baseVersion 为取批次时的基线版本，0 表示新建 */
export interface BatchChange {
  type: ObjectType;
  id: string;
  baseVersion: number;
  insert: boolean;
  payload: unknown;
}

export type MergeStrategy = 'mine' | 'theirs' | 'both' | 'fields';

export interface ConflictResolution {
  strategy: MergeStrategy;
  /** 按字段合并时，每个差异字段保留 mine 还是 theirs */
  fields?: Record<string, 'mine' | 'theirs'>;
}

export interface BatchConflict {
  key: string;
  type: ObjectType;
  id: string;
  changedFields: string[];
  base: unknown;
  mine: unknown;
  theirs: unknown;
  /** 对方版本的最后保存人，便于退回清单中署名 */
  theirsUpdatedBy?: string;
  resolution: ConflictResolution | null;
}

export interface BaselineEntry {
  version: number;
  updatedBy: string;
  updatedAt: string;
  snapshot: unknown;
}

export interface ActiveBatch {
  id: string;
  openedAt: string;
  actor: Actor;
  /** 取批次号时刻全部对象的基线快照，key = `${type}:${id}` */
  baseline: Record<string, BaselineEntry>;
  changes: BatchChange[];
  status: 'editing' | 'rejected';
  conflicts: BatchConflict[];
  /** 断网下提交过：改动已本地暂存，等待恢复网络 */
  queued: boolean;
  /** 本次打开页面时从本地存储恢复 */
  restored: boolean;
}

export interface InvalidatedSign {
  role: SignRole;
  reason: string;
}

export type CommitResult =
  | { ok: true; revision: number; invalidated: InvalidatedSign[]; lockInvalidated: boolean }
  | { ok: false; conflicts: BatchConflict[] };

export interface MigrationNotice {
  at: string;
  legacyRevision: number;
  backupKey: string;
  objectCount: number;
}

export const FIELD_LABELS: Record<string, string> = {
  title: '步骤标题',
  time: '计划时间',
  loadRate: '荷载率',
  clearance: '最小净空',
  wind: '风速限制',
  radius: '作业半径',
  boom: '臂长',
  status: '步骤结论',
  note: '控制说明',
  content: '意见内容',
  decision: '冲突判定',
  conclusion: '冲突结论',
  covers: '签署范围'
};

export const STEP_STATUS_LABELS: Record<StepStatus, string> = {
  pending: '待复核',
  passed: '通过',
  blocked: '阻断'
};

export const CONFLICT_DECISION_LABELS: Record<ConflictDecision, string> = {
  pending: '待处理',
  mitigated: '已缓解',
  'false-alarm': '误报排除'
};
