import { clone, deepEqual, newId } from './diff';
import type { ConflictRecord, ConflictResolution, ObjectType, PlanState } from './types';

const FIELD_LABELS: Record<string, string> = {
  title: '标题',
  time: '时间',
  loadRate: '荷载率',
  clearance: '最小净空',
  wind: '风速',
  radius: '作业半径',
  boom: '臂长',
  status: '状态',
  note: '步骤说明',
  content: '意见内容',
  author: '作者',
  role: '角色',
  stepId: '所属步骤',
  severity: '严重度',
  rule: '规则',
  message: '冲突信息',
  conclusion: '冲突结论',
  person: '签署人',
  team: '单位',
  scope: '签署范围',
  state: '签署状态',
  valid: '有效性',
  signedAt: '签署时间',
  basedOnRevision: '签署基线版本',
  locked: '锁定状态',
  revision: '发布版本',
  lockedBy: '锁定人',
  lockedAt: '锁定时间'
};

export function fieldLabel(field: string): string {
  return FIELD_LABELS[field] ?? field;
}

function objectLabel(type: ObjectType, obj: Record<string, any> | null): string {
  if (!obj) return '（已删除）';
  switch (type) {
    case 'step':
      return `${obj.id} · ${obj.title}`;
    case 'comment':
      return `${obj.author} 的评论`;
    case 'finding':
      return String(obj.message);
    case 'signoff':
      return `${obj.person}（${obj.role}）会签`;
    case 'lock':
      return '发布锁';
  }
}

type Entity = { id: string; version: number };

/** 计算本地与远端相对基线各自改动的字段；双方都改但值相同的字段不算冲突 */
function changedFields(base: Record<string, any> | null, local: Record<string, any> | null, remote: Record<string, any> | null) {
  const keys = new Set<string>([
    ...Object.keys(base ?? {}),
    ...Object.keys(local ?? {}),
    ...Object.keys(remote ?? {})
  ]);
  const localChanged: string[] = [];
  const remoteChanged: string[] = [];
  const both: string[] = [];
  for (const key of keys) {
    if (key === 'id' || key === 'version') continue;
    const lc = base ? !deepEqual(base[key], local?.[key]) : true;
    const rc = base ? !deepEqual(base[key], remote?.[key]) : true;
    if (lc && rc) {
      if (!deepEqual(local?.[key], remote?.[key])) both.push(key);
    } else if (lc) {
      localChanged.push(key);
    } else if (rc) {
      remoteChanged.push(key);
    }
  }
  return { localChanged, remoteChanged, both };
}

/** 按字段合并：单边改动采用该方，双边改动默认采用本地（用户可在冲突清单改选） */
function autoMerged(type: ObjectType, b: Record<string, any>, l: Record<string, any>, r: Record<string, any>): Record<string, any> {
  const { localChanged, remoteChanged, both } = changedFields(b, l, r);
  const result = clone(b);
  for (const field of localChanged) result[field] = clone(l[field]);
  for (const field of remoteChanged) result[field] = clone(r[field]);
  for (const field of both) result[field] = clone(l[field]);
  return bumpVersion(result, b, l, r);
}

function buildConflict(
  type: ObjectType,
  base: Record<string, any> | null,
  local: Record<string, any> | null,
  remote: Record<string, any> | null
): ConflictRecord {
  const { localChanged, remoteChanged, both } = changedFields(base, local, remote);
  const fieldConflicts = both.map((field) => ({
    field,
    label: fieldLabel(field),
    base: base?.[field],
    local: local?.[field],
    remote: remote?.[field],
    pick: 'local' as const
  }));
  const supportsMerge = !!base && !!local && !!remote;
  return {
    objectType: type,
    objectId: (base ?? local ?? remote)!.id,
    label: objectLabel(type, base ?? local ?? remote),
    base,
    local,
    remote,
    localChangedFields: localChanged,
    remoteChangedFields: remoteChanged,
    fieldConflicts,
    resolution: 'merge',
    supportsMerge,
    supportsBoth: type === 'comment' || type === 'finding',
    merged: null
  };
}

function bumpVersion(obj: Record<string, any>, base: Record<string, any> | null, local: Record<string, any> | null, remote: Record<string, any> | null) {
  obj.version = Math.max(base?.version ?? 0, local?.version ?? 0, remote?.version ?? 0) + 1;
  return obj;
}

/** 按用户选定的合并方式生成最终对象 */
export function computeMerged(record: ConflictRecord): void {
  const { base, local, remote, resolution } = record as {
    base: Record<string, any> | null;
    local: Record<string, any> | null;
    remote: Record<string, any> | null;
    resolution: ConflictResolution;
  };
  if (resolution === 'keep-local') {
    record.merged = bumpVersion(clone(local ?? base)!, base, local, remote);
    return;
  }
  if (resolution === 'keep-remote') {
    record.merged = bumpVersion(clone(remote ?? base)!, base, local, remote);
    return;
  }
  if (resolution === 'keep-both' && local && remote) {
    const localCopy = bumpVersion(clone(local)!, base, local, remote);
    const remoteCopy = { ...clone(remote), id: newId(record.objectType === 'comment' ? 'C' : 'F'), version: 1 };
    record.merged = [localCopy, remoteCopy];
    return;
  }
  // 按字段合并：单边改动直接采用，双边改动按字段选择
  const result = clone(base)!;
  for (const field of record.localChangedFields) result[field] = clone(local![field]);
  for (const field of record.remoteChangedFields) result[field] = clone(remote![field]);
  for (const fc of record.fieldConflicts) {
    result[fc.field] = fc.pick === 'local' ? clone(fc.local) : clone(fc.remote);
  }
  record.merged = bumpVersion(result, base, local, remote);
}

function mergeList<T extends Entity>(
  type: ObjectType,
  base: T[],
  local: T[],
  remote: T[],
  conflicts: ConflictRecord[]
): T[] {
  const baseMap = new Map(base.map((item) => [item.id, item]));
  const localMap = new Map(local.map((item) => [item.id, item]));
  const remoteMap = new Map(remote.map((item) => [item.id, item]));
  const ids = new Set([...baseMap.keys(), ...localMap.keys(), ...remoteMap.keys()]);
  const out: T[] = [];
  for (const id of ids) {
    const b = (baseMap.get(id) as Record<string, any>) ?? null;
    const l = (localMap.get(id) as Record<string, any>) ?? null;
    const r = (remoteMap.get(id) as Record<string, any>) ?? null;
    if (b && l && r) {
      const lc = !deepEqual(b, l);
      const rc = !deepEqual(b, r);
      if (!lc && !rc) {
        out.push(clone(b) as T);
      } else if (lc && rc) {
        const { both } = changedFields(b, l, r);
        if (both.length > 0) {
          // 同一字段双方改法不一致 → 整批退回冲突清单
          conflicts.push(buildConflict(type, b, l, r));
        }
        // 不同字段各自改动，或同字段改法一致 → 按字段自动合并
        out.push(autoMerged(type, b, l, r) as T);
      } else if (lc) {
        out.push(autoMerged(type, b, l, r) as T);
      } else {
        out.push(clone(r) as T);
      }
    } else if (!b) {
      if (l && r) {
        // 双方各自新增了同 id 的对象
        conflicts.push(buildConflict(type, null, l, r));
        out.push(clone(l) as T);
      } else {
        out.push(clone((l ?? r)!) as T);
      }
    } else if (b && !l) {
      // 本地删除
      if (r && !deepEqual(b, r)) conflicts.push(buildConflict(type, b, null, r));
      // 远端也删除或未改动：接受删除
    } else if (b && !r) {
      // 远端删除
      if (l && !deepEqual(b, l)) {
        conflicts.push(buildConflict(type, b, l, null));
        out.push(clone(l) as T);
      }
      // 本地未改动：接受远端删除
    }
  }
  return out;
}

function mergeLock(base: PlanState['lock'], local: PlanState['lock'], remote: PlanState['lock'], conflicts: ConflictRecord[]): PlanState['lock'] {
  const b = base as unknown as Record<string, any>;
  const l = local as unknown as Record<string, any>;
  const r = remote as unknown as Record<string, any>;
  const lc = !deepEqual(b, l);
  const rc = !deepEqual(b, r);
  if (lc && rc) {
    const { both } = changedFields(b, l, r);
    if (both.length > 0) conflicts.push(buildConflict('lock', b, l, r));
    return autoMerged('lock', b, l, r) as unknown as PlanState['lock'];
  }
  if (lc) return autoMerged('lock', b, l, r) as unknown as PlanState['lock'];
  return clone(r) as unknown as PlanState['lock'];
}

/**
 * 以基线为基准，对本地工作副本与服务端最新状态做三路合并。
 * 无冲突时直接返回可提交的 plan；有冲突时 plan 中为占位值，
 * 冲突明细在 conflicts 中，经 applyResolutions 处理后再提交。
 */
export function mergePlans(base: PlanState, local: PlanState, remote: PlanState): { plan: PlanState; conflicts: ConflictRecord[] } {
  const conflicts: ConflictRecord[] = [];
  const plan: PlanState = {
    revision: 0,
    steps: mergeList('step', base.steps, local.steps, remote.steps, conflicts),
    comments: mergeList('comment', base.comments, local.comments, remote.comments, conflicts),
    findings: mergeList('finding', base.findings, local.findings, remote.findings, conflicts),
    signoffs: mergeList('signoff', base.signoffs, local.signoffs, remote.signoffs, conflicts),
    lock: mergeLock(base.lock, local.lock, remote.lock, conflicts)
  };
  plan.revision = Math.max(base.revision, remote.revision) + 1;
  return { plan, conflicts };
}

const LIST_KEY: Record<ObjectType, 'steps' | 'comments' | 'findings' | 'signoffs' | 'lock'> = {
  step: 'steps',
  comment: 'comments',
  finding: 'findings',
  signoff: 'signoffs',
  lock: 'lock'
};

/** 将用户对每条冲突的合并方式应用到 mergePlans 产出的 plan 上 */
export function applyRecord(plan: PlanState, record: ConflictRecord): void {
  const key = LIST_KEY[record.objectType];
  if (key === 'lock') {
    if (record.resolution === 'keep-local') plan.lock = clone(record.local ?? record.remote) as unknown as PlanState['lock'];
    else if (record.resolution === 'keep-remote') plan.lock = clone(record.remote ?? record.local) as unknown as PlanState['lock'];
    else plan.lock = clone(record.merged) as unknown as PlanState['lock'];
    return;
  }
  const list = plan[key] as Entity[];
  const index = list.findIndex((item) => item.id === record.objectId);
  const hasLocalDelete = record.base && !record.local;
  const hasRemoteDelete = record.base && !record.remote;

  if (hasLocalDelete) {
    // 本地删除 vs 远端修改
    if (record.resolution === 'keep-local' || record.resolution === 'merge') {
      if (index >= 0) list.splice(index, 1);
    } else if (index >= 0) {
      list.splice(index, 1, clone(record.remote) as Entity);
    }
    return;
  }
  if (hasRemoteDelete) {
    // 本地修改 vs 远端删除
    if (record.resolution === 'keep-remote') {
      if (index >= 0) list.splice(index, 1);
    } else if (index >= 0) {
      list.splice(index, 1, clone(record.local) as Entity);
    }
    return;
  }
  if (record.resolution === 'keep-both' && Array.isArray(record.merged)) {
    if (index >= 0) list.splice(index, 1, ...(record.merged as Entity[]).map((item) => clone(item)));
    else list.push(...(record.merged as Entity[]).map((item) => clone(item)));
    return;
  }
  const merged = clone(record.merged) as Entity;
  if (index >= 0) list.splice(index, 1, merged);
  else list.push(merged);
}
