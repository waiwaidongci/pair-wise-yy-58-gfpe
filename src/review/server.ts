// 模拟协作服务端：权威状态存 localStorage，跨标签页通过 storage 事件同步。
// 提交采用「基线版本号」乐观并发控制：别人改过的对象整批退回冲突清单。
import { deriveConflicts, evaluateInvalidations, releaseBlockers, scopeDigest } from './rules';
import { applyResolution, changedFieldsOf, stripVersion } from './merge';
import { graphqlClient, LIFT_PLAN_QUERY } from '../graphql';
import type {
  ActiveBatch,
  Actor,
  BatchChange,
  BatchConflict,
  ConflictResolution,
  InvalidatedSign,
  MigrationNotice,
  ServerComment,
  ServerConflictReview,
  ServerSignOff,
  ServerState,
  ServerStep,
  SignRole,
  VersionMeta
} from './types';

const SERVER_KEY = 'yy58-server-state-v2';
const OFFLINE_KEY = 'yy58-offline-flag';
const NOTICE_KEY = 'yy58-migration-notice';
const LEGACY_DRAFT_KEY = 'yy58-lift-plan-draft';
const LEGACY_BACKUP_KEY = 'yy58-lift-plan-draft-migrated-backup';

export class NetworkError extends Error {
  constructor() {
    super('当前处于离线状态，操作已保留在本批次中，网络恢复后可重新提交。');
    this.name = 'NetworkError';
  }
}

type Listener = (state: ServerState) => void;
const listeners = new Set<Listener>();

function now(): string {
  return new Date().toISOString();
}

function isOffline(): boolean {
  return typeof localStorage !== 'undefined' && localStorage.getItem(OFFLINE_KEY) === '1';
}

export function getOnline(): boolean {
  return !isOffline();
}

export function setOffline(offline: boolean) {
  if (offline) localStorage.setItem(OFFLINE_KEY, '1');
  else localStorage.removeItem(OFFLINE_KEY);
}

// ---------------------------------------------------------------------------
// 初始种子 / 旧稿迁移
// ---------------------------------------------------------------------------

function meta<T extends object>(item: T, version = 1, stamp = '2026-09-18T02:00:00.000Z', updatedBy = '方案初始化'): T & VersionMeta {
  return { ...item, version, updatedAt: stamp, updatedBy };
}

const seedSteps: ServerStep[] = [
  meta({ id: 'S-01', title: '吊车支腿就位与地耐力复核', time: '07:30', loadRate: 0, clearance: 4.2, wind: 3.4, radius: 18, boom: 42, status: 'passed', note: '支腿钢板 2.4m × 2.4m，已完成压实度复检。' }),
  meta({ id: 'S-02', title: '空钩回转与障碍物净空检查', time: '08:10', loadRate: 28, clearance: 1.2, wind: 4.1, radius: 22, boom: 46, status: 'blocked', note: '东侧临时配电箱侵入回转半径 0.6m。' }),
  meta({ id: 'S-03', title: '桁架试吊离地 300mm', time: '08:45', loadRate: 76, clearance: 2.8, wind: 5.2, radius: 20, boom: 44, status: 'pending', note: '需安全员确认吊点受力均匀。' }),
  meta({ id: 'S-04', title: '主吊回转至安装轴线', time: '09:20', loadRate: 83, clearance: 1.8, wind: 6.8, radius: 24, boom: 48, status: 'pending', note: '风速超过 8m/s 立即停止。' }),
  meta({ id: 'S-05', title: '双机抬吊姿态调整', time: '10:05', loadRate: 92, clearance: 1.3, wind: 7.2, radius: 27, boom: 52, status: 'blocked', note: '辅吊荷载率超过方案控制值。' }),
  meta({ id: 'S-06', title: '就位、临时固定与摘钩', time: '10:50', loadRate: 68, clearance: 2.1, wind: 5.6, radius: 21, boom: 45, status: 'pending', note: '四组临时螺栓到位后方可摘钩。' })
];

const seedComments: ServerComment[] = [
  meta({ id: 'C-11', author: '周工', role: '安全', content: 'S-02 回转路径与配电箱净空不足，请调整吊车站位或迁移配电箱。', status: 'open', stepId: 'S-02' }),
  meta({ id: 'C-12', author: '刘明', role: '设备', content: '辅吊支腿下方需要补充路基板，提供地耐力实测记录。', status: 'open', stepId: 'S-05' }),
  meta({ id: 'C-13', author: '陈晓', role: '总包', content: '同意主吊选型，建议把第三检查点前移到试吊阶段。', status: 'resolved', stepId: 'S-03' })
];

function pendingReviews(steps: ServerStep[], stamp: string, by: string): ServerConflictReview[] {
  return deriveConflicts(steps).map((conflict) =>
    meta(
      {
        id: conflict.id,
        stepId: conflict.stepId,
        rule: conflict.rule,
        message: conflict.message,
        decision: 'pending' as const,
        conclusion: '',
        decidedBy: ''
      },
      1,
      stamp,
      by
    )
  );
}

function buildSignoff(role: SignRole, name: string, state: ServerState, stamp: string): ServerSignOff {
  return meta(
    {
      id: `SO-${role}`,
      role,
      name,
      signedAt: stamp,
      covers: scopeDigest(role, { steps: state.steps, comments: state.comments, conflicts: state.conflictReviews }),
      valid: true,
      invalidReason: ''
    },
    1,
    stamp,
    name
  );
}

function seedState(revision: number, locked: boolean, stamp: string): ServerState {
  const state: ServerState = {
    schemaVersion: 2,
    plan: { id: 'LP-2026-0918', name: '东塔转换桁架吊装', revision, locked, lockedAt: locked ? stamp : null, unlockNote: '' },
    steps: seedSteps.map((step) => meta(stripVersion(step) as ServerStep, 1, stamp)),
    conflictReviews: [],
    comments: seedComments.map((comment) => meta(stripVersion(comment) as ServerComment, 1, stamp)),
    signoffs: [],
    seq: 100,
    batches: {}
  };
  state.conflictReviews = pendingReviews(state.steps, stamp, '方案初始化');
  state.signoffs = [buildSignoff('总包', '陈晓', state, stamp)];
  return state;
}

interface LegacyDraft {
  steps?: ServerStep[];
  comments?: ServerComment[];
  revision?: number;
  locked?: boolean;
  draftSavedAt?: string;
}

/** 旧稿没有版本号：全部对象升级为 V1，原始数据原样保留，旧文件另存备份 */
function migrateLegacy(draft: LegacyDraft): { state: ServerState; notice: MigrationNotice } {
  const stamp = draft.draftSavedAt ?? '2026-09-18T02:00:00.000Z';
  const migratedSteps: ServerStep[] = (draft.steps ?? []).map((step) => meta(stripVersion(step) as ServerStep, 1, stamp, '旧稿迁移'));
  const steps = migratedSteps.length ? migratedSteps : seedSteps.map((step) => meta(stripVersion(step) as ServerStep, 1, stamp, '旧稿迁移'));
  const comments: ServerComment[] = (draft.comments ?? []).map((comment) => meta(stripVersion(comment) as ServerComment, 1, stamp, '旧稿迁移'));
  const state: ServerState = {
    schemaVersion: 2,
    plan: {
      id: 'LP-2026-0918',
      name: '东塔转换桁架吊装',
      revision: draft.revision ?? 1,
      locked: draft.locked === true,
      lockedAt: draft.locked === true ? stamp : null,
      unlockNote: ''
    },
    steps,
    conflictReviews: pendingReviews(steps, stamp, '旧稿迁移'),
    comments,
    signoffs: [],
    seq: 100,
    batches: {}
  };
  // 旧 UI 中总包角色显示为「已接受」，迁移时保留该会签并按迁移后数据重算指纹
  state.signoffs = [buildSignoff('总包', '陈晓', state, stamp)];
  const notice: MigrationNotice = {
    at: now(),
    legacyRevision: draft.revision ?? 1,
    backupKey: LEGACY_BACKUP_KEY,
    objectCount: state.steps.length + state.comments.length + state.conflictReviews.length
  };
  return { state, notice };
}

function loadRaw(): ServerState | null {
  const raw = localStorage.getItem(SERVER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ServerState;
  } catch {
    return null;
  }
}

function save(state: ServerState) {
  localStorage.setItem(SERVER_KEY, JSON.stringify(state));
}

export function initServer(): { state: ServerState; migrated: MigrationNotice | null } {
  const existing = loadRaw();
  if (existing) return { state: existing, migrated: readNotice() };

  const legacyRaw = localStorage.getItem(LEGACY_DRAFT_KEY);
  if (legacyRaw) {
    let legacy: LegacyDraft | null = null;
    try {
      legacy = JSON.parse(legacyRaw) as LegacyDraft;
    } catch {
      legacy = null;
    }
    // 原始旧稿原样备份，升级失败也可回退
    localStorage.setItem(LEGACY_BACKUP_KEY, legacyRaw);
    if (legacy && Array.isArray(legacy.steps)) {
      const { state, notice } = migrateLegacy(legacy);
      save(state);
      localStorage.setItem(NOTICE_KEY, JSON.stringify(notice));
      return { state, migrated: notice };
    }
  }

  const state = seedState(4, false, '2026-09-18T02:00:00.000Z');
  save(state);
  return { state, migrated: null };
}

export function readNotice(): MigrationNotice | null {
  const raw = localStorage.getItem(NOTICE_KEY);
  return raw ? (JSON.parse(raw) as MigrationNotice) : null;
}

export function dismissNotice() {
  localStorage.removeItem(NOTICE_KEY);
}

export function getState(): ServerState {
  const state = loadRaw();
  if (state) return state;
  return initServer().state;
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  const handler = (event: StorageEvent) => {
    if (event.key === SERVER_KEY || event.key === OFFLINE_KEY) {
      const state = loadRaw();
      if (state) listener(state);
    }
  };
  if (typeof window !== 'undefined') window.addEventListener('storage', handler);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', handler);
  };
}

function emit(state: ServerState) {
  listeners.forEach((listener) => listener(state));
}

// ---------------------------------------------------------------------------
// 复核批次：先取批次号（含基线），再整批提交
// ---------------------------------------------------------------------------

export function startBatch(actor: Actor): { id: string } {
  if (isOffline()) throw new NetworkError();
  const state = getState();
  state.seq += 1;
  const id = `RB-${String(state.seq).padStart(4, '0')}`;
  state.batches[id] = { id, openedBy: actor.name, role: actor.role, openedAt: now() };
  save(state);
  emit(state);
  return { id };
}

type Collection = 'steps' | 'comments' | 'conflictReviews' | 'signoffs';

const COLLECTIONS: Record<BatchChange['type'], Collection> = {
  step: 'steps',
  comment: 'comments',
  conflict: 'conflictReviews',
  signoff: 'signoffs'
};

type VersionRow = Record<string, unknown> & VersionMeta;

function findObject(state: ServerState, type: BatchChange['type'], id: string): VersionRow | undefined {
  return (state[COLLECTIONS[type]] as unknown as VersionRow[]).find((item) => item.id === id);
}

interface EffectiveItem {
  change: BatchChange;
  payload: Record<string, unknown>;
}

export interface CommitOutcome {
  ok: boolean;
  state?: ServerState;
  conflicts?: BatchConflict[];
  /** 服务端返回他人当前版本，供客户端结合本地基线组装冲突清单 */
  theirs?: Record<string, Record<string, unknown>>;
  invalidated?: InvalidatedSign[];
  lockInvalidated?: boolean;
}

/** 整批提交：任一对象基线过期即整批退回，不产生部分写入；带处理意见的重试按意见合并后落库 */
export function commitBatch(
  batchId: string,
  changes: BatchChange[],
  resolutions: Record<string, ConflictResolution>,
  actor: Actor
): CommitOutcome {
  if (isOffline()) throw new NetworkError();
  const state = getState();
  if (!state.batches[batchId]) {
    throw new Error('批次号不存在或已关闭，请重新取号。');
  }

  // 提交前深快照，用于会签失效原因的前后对比
  const prior: ServerState = JSON.parse(JSON.stringify(state)) as ServerState;

  // 第一遍：逐个对象比对基线版本；过期且未给处理意见的收集为冲突，给了意见的合成合并载荷
  const unresolved: Array<{ change: BatchChange; current: VersionRow }> = [];
  const theirs: Record<string, Record<string, unknown>> = {};
  const effective: EffectiveItem[] = [];

  for (const change of changes) {
    const current = findObject(state, change.type, change.id);
    if (change.insert || !current) {
      effective.push({ change, payload: change.payload as Record<string, unknown> });
      continue;
    }
    if (current.version !== change.baseVersion) {
      const key = `${change.type}:${change.id}`;
      theirs[key] = stripVersion(current);
      const resolution = resolutions[key];
      if (resolution) {
        effective.push({
          change,
          payload: applyResolution(
            {
              key,
              type: change.type,
              id: change.id,
              changedFields: changedFieldsOf(stripVersion(current), change.payload, change.type),
              base: null,
              mine: change.payload,
              theirs: stripVersion(current),
              resolution
            },
            resolution,
            actor.name,
            current.updatedBy
          )
        });
      } else {
        unresolved.push({ change, current });
      }
      continue;
    }
    effective.push({ change, payload: change.payload as Record<string, unknown> });
  }

  if (unresolved.length) {
    return {
      ok: false,
      conflicts: unresolved.map(({ change, current }) => ({
        key: `${change.type}:${change.id}`,
        type: change.type,
        id: change.id,
        changedFields: changedFieldsOf(stripVersion(current), change.payload, change.type),
        base: null,
        mine: change.payload,
        theirs: stripVersion(current),
        theirsUpdatedBy: current.updatedBy,
        resolution: null
      })),
      theirs
    };
  }

  // 第二遍：无未决冲突才整体落库（原子语义）
  const stamp = now();
  const signoffIdsChanged = new Set<string>();
  let touchedData = false;

  for (const { change, payload } of effective) {
    const collection = state[COLLECTIONS[change.type]] as unknown as VersionRow[];
    const index = collection.findIndex((row) => row.id === change.id);
    if (index >= 0) {
      collection[index] = { ...collection[index], ...payload, version: collection[index].version + 1, updatedAt: stamp, updatedBy: actor.name };
    } else {
      collection.push({ ...payload, id: change.id, version: 1, updatedAt: stamp, updatedBy: actor.name });
    }
    if (change.type === 'signoff') signoffIdsChanged.add(change.id);
    else touchedData = true;
  }

  // 参数变化后可能产生基线时不存在的新规则冲突：自动补建待处理复核记录 V1，
  // 保证冲突项始终是可并发、可会签覆盖的版本化对象
  if (touchedData) {
    const live = deriveConflicts(state.steps);
    for (const conflict of live) {
      if (!state.conflictReviews.some((review) => review.id === conflict.id)) {
        state.conflictReviews.push(
          meta(
            {
              id: conflict.id,
              stepId: conflict.stepId,
              rule: conflict.rule,
              message: conflict.message,
              decision: 'pending',
              conclusion: '',
              decidedBy: ''
            },
            1,
            stamp,
            `${actor.name}提交后新增冲突`
          )
        );
      }
    }
  }

  // 参数/评论/冲突结论更新后，重算已有会签指纹并立即失效；本批重新签署的指纹按提交后数据计算
  for (const signoff of state.signoffs) {
    const digest = scopeDigest(signoff.role, { steps: state.steps, comments: state.comments, conflicts: state.conflictReviews });
    if (signoffIdsChanged.has(signoff.id)) {
      signoff.covers = digest;
      signoff.valid = true;
      signoff.invalidReason = '';
      signoff.signedAt = stamp;
    } else if (digest !== signoff.covers) {
      signoff.version += 1;
      signoff.updatedAt = stamp;
      signoff.updatedBy = '系统失效';
      signoff.valid = false;
      signoff.invalidReason = '管辖数据已更新，签署失效';
    }
  }

  if (touchedData) state.plan.revision += 1;
  let lockInvalidated = false;
  if (state.plan.locked && touchedData) {
    state.plan.locked = false;
    state.plan.lockedAt = null;
    state.plan.unlockNote = `${stamp.slice(11, 16)} ${actor.name}（${actor.role}）提交了新修改，发布锁自动失效，需重新会签。`;
    lockInvalidated = true;
  }

  const invalidated = evaluateInvalidations(prior, state.steps, state.comments, state.conflictReviews).filter(
    (item) => !signoffIdsChanged.has(`SO-${item.role}`)
  );

  save(state);
  emit(state);
  return { ok: true, state, invalidated, lockInvalidated };
}

export interface LockOutcome {
  ok: boolean;
  blockers: string[];
  state?: ServerState;
}

export function lockPlan(actor: Actor): LockOutcome {
  if (isOffline()) throw new NetworkError();
  const state = getState();
  // 先刷新全部会签有效性，杜绝「已经失效的会签继续放行」
  for (const signoff of state.signoffs) {
    const digest = scopeDigest(signoff.role, { steps: state.steps, comments: state.comments, conflicts: state.conflictReviews });
    if (digest !== signoff.covers) {
      signoff.valid = false;
      signoff.invalidReason = '管辖数据已更新，签署失效';
    } else {
      signoff.valid = true;
      signoff.invalidReason = '';
    }
  }
  const blockers = releaseBlockers(state);
  if (blockers.length) {
    save(state);
    emit(state);
    return { ok: false, blockers, state };
  }
  state.plan.locked = true;
  state.plan.lockedAt = now();
  state.plan.unlockNote = '';
  state.plan.revision += 1;
  save(state);
  emit(state);
  writeGraphQlSnapshot(state);
  void actor;
  return { ok: true, blockers: [], state };
}

function writeGraphQlSnapshot(state: ServerState) {
  graphqlClient.writeQuery({
    query: LIFT_PLAN_QUERY,
    variables: { id: state.plan.id },
    data: {
      liftPlan: {
        __typename: 'LiftPlan',
        id: state.plan.id,
        name: state.plan.name,
        revision: state.plan.revision,
        status: 'LOCKED',
        steps: state.steps.map((step) => ({
          __typename: 'LiftStep',
          id: step.id,
          name: step.title,
          loadRate: step.loadRate,
          clearance: step.clearance
        }))
      }
    }
  });
}

/** 取批次基线：批次号 + 全量对象版本快照 */
export function captureBaseline(state: ServerState): ActiveBatch['baseline'] {
  const baseline: ActiveBatch['baseline'] = {};
  const add = (type: string, rows: unknown[]) => {
    for (const row of rows) {
      const r = row as VersionRow;
      baseline[`${type}:${r.id}`] = {
        version: r.version,
        updatedBy: r.updatedBy,
        updatedAt: r.updatedAt,
        snapshot: stripVersion(r)
      };
    }
  };
  add('step', state.steps);
  add('comment', state.comments);
  add('conflict', state.conflictReviews);
  add('signoff', state.signoffs);
  return baseline;
}

export function closeBatch(batchId: string) {
  const state = getState();
  delete state.batches[batchId];
  save(state);
  emit(state);
}
