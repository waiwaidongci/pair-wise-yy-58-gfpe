export type StepStatus = 'pending' | 'passed' | 'blocked';
export type CommentStatus = 'open' | 'resolved';
export type FindingStatus = 'open' | 'resolved' | 'waived';
export type SignoffState = 'pending' | 'accepted' | 'reserved';

export type LiftStep = {
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
  version: number;
};

export type Comment = {
  id: string;
  author: string;
  role: string;
  content: string;
  status: CommentStatus;
  stepId: string;
  version: number;
};

export type Finding = {
  id: string;
  stepId: string;
  severity: 'high' | 'medium';
  rule: string;
  message: string;
  status: FindingStatus;
  conclusion: string;
  version: number;
};

export type Signoff = {
  id: string;
  role: string;
  person: string;
  team: string;
  scope: string;
  /** 覆盖的步骤 id；空数组表示覆盖全部步骤 */
  stepIds: string[];
  state: SignoffState;
  /** 参数或评论变更后失效，需重新签署 */
  valid: boolean;
  signedAt: string | null;
  basedOnRevision: number | null;
  version: number;
};

export type ReleaseLock = {
  locked: boolean;
  revision: number | null;
  lockedBy: string | null;
  lockedAt: string | null;
  version: number;
};

export type PlanState = {
  revision: number;
  steps: LiftStep[];
  comments: Comment[];
  findings: Finding[];
  signoffs: Signoff[];
  lock: ReleaseLock;
};

export type ObjectType = 'step' | 'comment' | 'finding' | 'signoff' | 'lock';

export type FieldConflict = {
  field: string;
  label: string;
  base: unknown;
  local: unknown;
  remote: unknown;
  pick: 'local' | 'remote';
};

export type ConflictResolution = 'merge' | 'keep-local' | 'keep-remote' | 'keep-both';

export type ConflictRecord = {
  objectType: ObjectType;
  objectId: string;
  label: string;
  /** 基线版本中的对象；删除冲突时可能为 null */
  base: unknown | null;
  /** 本地工作副本中的对象；删除冲突时可能为 null */
  local: unknown | null;
  /** 服务端最新对象；对方删除时可能为 null */
  remote: unknown | null;
  localChangedFields: string[];
  remoteChangedFields: string[];
  fieldConflicts: FieldConflict[];
  resolution: ConflictResolution;
  supportsMerge: boolean;
  supportsBoth: boolean;
  /** 合并后的对象；keep-both 时为数组（本地副本 + 对方副本） */
  merged: unknown | unknown[] | null;
};

export type BatchStatus = 'editing' | 'conflict' | 'saved';

export type ReviewBatch = {
  batchId: number;
  /** 取批次号时的基线快照 */
  baseline: PlanState;
  acquiredAt: string;
  status: BatchStatus;
  offline: boolean;
};
