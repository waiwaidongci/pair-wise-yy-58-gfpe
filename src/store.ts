import { defineStore } from 'pinia';
import {
  NetworkError,
  captureBaseline,
  closeBatch as serverCloseBatch,
  commitBatch,
  dismissNotice,
  getOnline,
  getState,
  initServer,
  lockPlan as serverLockPlan,
  readNotice,
  setOffline,
  startBatch,
  subscribe
} from './review/server';
import { deriveConflicts, releaseBlockers, ROLE_SCOPE_LABEL, scopeDigest } from './review/rules';
import { driftedFields, mergeableFields } from './review/merge';
import type {
  Actor,
  ActorRole,
  ActiveBatch,
  BatchChange,
  BatchConflict,
  CommentRec,
  ConflictDecision,
  ConflictResolution,
  InvalidatedSign,
  LiftStep,
  MergeStrategy,
  MigrationNotice,
  ObjectType,
  ServerComment,
  ServerConflictReview,
  ServerSignOff,
  ServerState,
  ServerStep,
  SignRole,
  StepStatus
} from './review/types';

const BATCH_KEY = 'yy58-active-batch-v2';
const PREFS_KEY = 'yy58-ui-prefs-v2';
export const PLAN_ID = 'LP-2026-0918';

interface UiPrefs {
  actor: Actor;
  selectedStepId: string;
  viewBookmarks: string[];
  activeBookmark: string;
}

const ACTOR_PRESETS: Array<{ name: string; role: ActorRole }> = [
  { name: '王工', role: '现场' },
  { name: '刘明', role: '设备' },
  { name: '周工', role: '安全' },
  { name: '赵磊', role: '方案' },
  { name: '陈晓', role: '总包' }
];

const defaultPrefs: UiPrefs = {
  actor: ACTOR_PRESETS[0],
  selectedStepId: 'S-02',
  viewBookmarks: ['主吊全景', '东侧障碍', '安装轴线'],
  activeBookmark: '主吊全景'
};

function loadPrefs(): UiPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) return { ...defaultPrefs, ...(JSON.parse(raw) as UiPrefs) };
  } catch {
    /* ignore */
  }
  return defaultPrefs;
}

function loadStashedBatch(): ActiveBatch | null {
  try {
    const raw = localStorage.getItem(BATCH_KEY);
    return raw ? (JSON.parse(raw) as ActiveBatch) : null;
  } catch {
    return null;
  }
}

type StagedComment = CommentRec & { clientId: string };
type StagedSignoff = { role: SignRole; name: string };

interface Toast {
  id: number;
  tone: 'info' | 'positive' | 'negative' | 'warning';
  message: string;
}

let toastSeq = 0;

export const useLiftStore = defineStore('lift-plan', {
  state: () => {
    const init = initServer();
    const prefs = loadPrefs();
    const stashed = loadStashedBatch();
    return {
      server: init.state as ServerState,
      online: getOnline(),
      actor: prefs.actor as Actor,
      selectedStepId: prefs.selectedStepId,
      viewBookmarks: prefs.viewBookmarks,
      activeBookmark: prefs.activeBookmark,
      batch: stashed as ActiveBatch | null,
      /** 断网恢复/重启后恢复批次的提示，仅展示一次 */
      restoredNotice: stashed ? '已从本机恢复未完成的复核批次，可继续编辑后重新提交。' : '',
      migrationNotice: init.migrated as MigrationNotice | null,
      toasts: [] as Toast[],
      lastCommit: null as null | { invalidated: InvalidatedSign[]; lockInvalidated: boolean; revision: number },
      lockBlockers: [] as string[],
      commentDrafts: {} as Record<string, string>
    };
  },
  getters: {
    revision(state): number {
      return state.server.plan.revision;
    },
    locked(state): boolean {
      return state.server.plan.locked;
    },
    steps(state): Array<LiftStep & { version: number; updatedBy: string; staged: boolean }> {
      return state.server.steps.map((step) => {
        const change = state.batch?.changes.find((item) => item.type === 'step' && item.id === step.id);
        const staged = change ? (change.payload as Partial<LiftStep>) : null;
        return { ...step, ...(staged ?? {}), version: step.version, updatedBy: step.updatedBy, staged: Boolean(staged) };
      });
    },
    selectedStep(): (LiftStep & { version: number; updatedBy: string; staged: boolean }) | undefined {
      return this.steps.find((step) => step.id === this.selectedStepId) ?? this.steps[0];
    },
    conflicts(state): Array<ReturnType<typeof deriveConflicts>[number] & { title: string; review?: ServerConflictReview; staged: boolean }> {
      const stepTitle = (id: string) => state.server.steps.find((step) => step.id === id)?.title ?? '';
      return deriveConflicts(state.server.steps).map((conflict) => {
        const base = state.server.conflictReviews.find((review) => review.id === conflict.id);
        const change = state.batch?.changes.find((item) => item.type === 'conflict' && item.id === conflict.id);
        const staged = change ? (change.payload as Partial<ServerConflictReview>) : null;
        return { ...conflict, title: stepTitle(conflict.stepId), review: base ? { ...base, ...(staged ?? {}) } : undefined, staged: Boolean(staged) };
      });
    },
    comments(state): Array<ServerComment & { clientId?: string; staged: boolean; isNew?: boolean }> {
      const result = state.server.comments.map((comment) => {
        const change = state.batch?.changes.find((item) => item.type === 'comment' && item.id === comment.id);
        const staged = change ? (change.payload as Partial<ServerComment>) : null;
        return { ...comment, ...(staged ?? {}), staged: Boolean(staged) };
      });
      const inserts = (state.batch?.changes ?? [])
        .filter((change) => change.type === 'comment' && change.insert)
        .map((change) => ({ ...(change.payload as ServerComment), clientId: change.id, version: 0, updatedAt: '', updatedBy: '', staged: true, isNew: true }));
      return [...inserts, ...result];
    },
    openComments(): ServerComment[] {
      return this.comments.filter((comment) => comment.status === 'open');
    },
    signoffs(state): Array<ServerSignOff & { validNow: boolean; staged?: boolean }> {
      return state.server.signoffs.map((sign) => ({
        ...sign,
        validNow: scopeDigest(sign.role, { steps: state.server.steps, comments: state.server.comments, conflicts: state.server.conflictReviews }) === sign.covers
      }));
    },
    stagedSignoffRoles(state): Set<string> {
      return new Set(
        (state.batch?.changes ?? [])
          .filter((change) => change.type === 'signoff')
          .map((change) => (change.payload as { role: string }).role)
      );
    },
    pendingConflictReviews(): ServerConflictReview[] {
      return this.conflicts
        .map((item: { review?: ServerConflictReview }) => item.review)
        .filter((review: ServerConflictReview | undefined): review is ServerConflictReview => Boolean(review) && review!.decision === 'pending');
    },
    readiness(state): number {
      const passed = state.server.steps.filter((step) => step.status === 'passed').length;
      const signScore = this.signoffs.filter((sign: ServerSignOff & { validNow: boolean }) => sign.validNow).length * 8;
      const conflictPenalty = this.pendingConflictReviews.length * 10;
      const commentPenalty = state.server.comments.filter((comment) => comment.status === 'open').length * 6;
      return Math.max(0, Math.min(100, Math.round((passed / Math.max(1, state.server.steps.length)) * 68) + signScore - conflictPenalty - commentPenalty));
    },
    releaseBlockers(): string[] {
      return releaseBlockers(this.server);
    },
    inBatch(state): boolean {
      return Boolean(state.batch);
    },
    batchRejected(state): boolean {
      return state.batch?.status === 'rejected';
    },
    queued(state): boolean {
      return Boolean(state.batch?.queued);
    },
    /** 本页取号之后，其他标签页已经又改过、若现在提交会被退回的对象 */
    driftedObjects(state): Array<{ key: string; type: string; id: string; fields: string[]; updatedBy: string }> {
      if (!state.batch) return [];
      const out: Array<{ key: string; type: string; id: string; fields: string[]; updatedBy: string }> = [];
      const scan = (type: string, rows: Array<Record<string, unknown> & { id: string; version: number; updatedBy: string }>) => {
        for (const row of rows) {
          const key = `${type}:${row.id}`;
          const base = state.batch!.baseline[key];
          if (base && row.version !== base.version) {
            out.push({ key, type, id: row.id, fields: driftedFields(base.snapshot, row, type as ObjectType), updatedBy: row.updatedBy });
          }
        }
      };
      scan('step', state.server.steps);
      scan('comment', state.server.comments);
      scan('conflict', state.server.conflictReviews);
      scan('signoff', state.server.signoffs);
      return out;
    },
    batchSummary(): { steps: number; comments: number; conflicts: number; signoffs: number } {
      if (!this.batch) return { steps: 0, comments: 0, conflicts: 0, signoffs: 0 };
      const changes = this.batch.changes as BatchChange[];
      return {
        steps: changes.filter((change) => change.type === 'step').length,
        comments: changes.filter((change) => change.type === 'comment').length,
        conflicts: changes.filter((change) => change.type === 'conflict').length,
        signoffs: changes.filter((change) => change.type === 'signoff').length
      };
    },
    actors(): typeof ACTOR_PRESETS {
      return ACTOR_PRESETS;
    },
    scopeLabel(): (role: SignRole) => string {
      return (role: SignRole) => ROLE_SCOPE_LABEL[role];
    }
  },
  actions: {
    // ---- 基础 / 通知 -----------------------------------------------------
    persistPrefs() {
      const prefs: UiPrefs = {
        actor: this.actor,
        selectedStepId: this.selectedStepId,
        viewBookmarks: this.viewBookmarks,
        activeBookmark: this.activeBookmark
      };
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    },
    persistBatch() {
      if (this.batch) localStorage.setItem(BATCH_KEY, JSON.stringify(this.batch));
      else localStorage.removeItem(BATCH_KEY);
    },
    pushToast(message: string, tone: Toast['tone'] = 'info') {
      const id = (toastSeq += 1);
      this.toasts.push({ id, message, tone });
      setTimeout(() => {
        this.toasts = this.toasts.filter((item) => item.id !== id);
      }, 4200);
    },
    setServerState(state: ServerState) {
      this.server = state;
    },
    initRealtime() {
      subscribe((state) => {
        const wasRejected = this.batch?.status === 'rejected';
        this.server = state;
        if (wasRejected) this.rebuildConflictsFromServer();
      });
    },
    setActor(name: string, role: ActorRole) {
      this.actor = { name, role };
      this.persistPrefs();
    },
    selectStep(id: string) {
      this.selectedStepId = id;
      this.persistPrefs();
    },
    setBookmark(name: string) {
      this.activeBookmark = name;
      if (!this.viewBookmarks.includes(name)) this.viewBookmarks.push(name);
      this.persistPrefs();
    },
    setOnlineMode(online: boolean) {
      setOffline(!online);
      this.online = online;
      if (online && this.batch?.queued) {
        this.pushToast('网络已恢复，请重新提交暂存的复核批次。', 'positive');
      }
    },
    dismissMigration() {
      dismissNotice();
      this.migrationNotice = null;
    },
    dismissRestored() {
      this.restoredNotice = '';
    },

    // ---- 批次生命周期 ----------------------------------------------------
    beginBatch() {
      if (this.batch) return;
      try {
        const { id } = startBatch(this.actor);
        const state = getState();
        this.batch = {
          id,
          openedAt: new Date().toISOString(),
          actor: { ...this.actor },
          baseline: captureBaseline(state),
          changes: [],
          status: 'editing',
          conflicts: [],
          queued: false,
          restored: false
        };
        this.persistBatch();
        this.pushToast(`已取得复核批次号 ${id}，修改将在提交时统一落库。`, 'positive');
      } catch (error) {
        this.pushToast(error instanceof NetworkError ? error.message : '取批次号失败，请检查网络。', 'negative');
      }
    },
    cancelBatch() {
      if (!this.batch) return;
      try {
        serverCloseBatch(this.batch.id);
      } catch {
        /* 离线关闭也允许放弃本地批次 */
      }
      this.batch = null;
      this.persistBatch();
      this.pushToast('已放弃本批次，未提交的修改不会影响方案版本。', 'info');
    },
    /** 断网后页面关闭再打开：批次已随 localStorage 恢复，这里只做状态确认 */
    confirmRestoredBatch() {
      if (!this.batch) return;
      this.batch.restored = false;
      this.persistBatch();
    },

    // ---- 批次内编辑：全部先进暂存，不直接改服务端数据 ----------------------
    stagedChange(type: BatchChange['type'], id: string): BatchChange | undefined {
      return this.batch?.changes.find((change) => change.type === type && change.id === id);
    },
    batchChangesByType(type: BatchChange['type']): BatchChange[] {
      return this.batch?.changes.filter((change) => change.type === type) ?? [];
    },
    stagedStep(id: string): Partial<LiftStep> | null {
      const change = this.stagedChange('step', id);
      return change ? (change.payload as Partial<LiftStep>) : null;
    },
    stagedComment(id: string): Partial<CommentRec> | null {
      const change = this.stagedChange('comment', id);
      return change ? (change.payload as Partial<CommentRec>) : null;
    },
    stagedConflict(id: string): Partial<ServerConflictReview> | null {
      const change = this.stagedChange('conflict', id);
      return change ? (change.payload as Partial<ServerConflictReview>) : null;
    },
    upsertChange(type: BatchChange['type'], id: string, patch: Record<string, unknown>, insert = false) {
      if (!this.batch) {
        this.pushToast('请先取得复核批次号后再修改。', 'warning');
        return false;
      }
      if (this.batch.status === 'rejected') {
        this.pushToast('本批次已被退回，请在冲突清单中选择处理方式后重新提交。', 'warning');
        return false;
      }
      const existing = this.batch.changes.find((change) => change.type === type && change.id === id);
      if (existing) {
        existing.payload = { ...(existing.payload as Record<string, unknown>), ...patch };
      } else {
        const baseEntry = this.batch.baseline[`${type}:${id}`];
        this.batch.changes.push({
          type,
          id,
          baseVersion: baseEntry?.version ?? 0,
          insert,
          payload: insert ? { ...patch } : { ...(baseEntry?.snapshot as Record<string, unknown>), ...patch }
        });
      }
      this.persistBatch();
      return true;
    },
    stageStepPatch(id: string, patch: Partial<LiftStep>) {
      return this.upsertChange('step', id, patch as Record<string, unknown>);
    },
    setStepStatus(id: string, status: StepStatus) {
      return this.stageStepPatch(id, { status });
    },
    addComment(content: string, stepId: string): boolean {
      const text = content.trim();
      if (!text) return false;
      if (!this.batch) {
        this.pushToast('请先取得复核批次号，再提交条件评论。', 'warning');
        return false;
      }
      const id = `C-${Date.now()}`;
      const payload: CommentRec = { id, author: this.actor.name, role: this.actor.role, content: text, status: 'open', stepId };
      return this.upsertChange('comment', id, payload as unknown as Record<string, unknown>, true);
    },
    resolveComment(id: string) {
      return this.upsertChange('comment', id, { status: 'resolved' });
    },
    setConflictDecision(id: string, decision: ConflictDecision, conclusion: string, decidedBy: string) {
      return this.upsertChange('conflict', id, { decision, conclusion, decidedBy });
    },
    stageSignoff(role: SignRole, name: string) {
      const id = `SO-${role}`;
      const base = this.batch?.baseline[`signoff:${id}`];
      if (!this.batch) return false;
      // 会签内容：指纹由服务端在提交时按落库后数据计算，这里先占位
      const payload = { id, role, name, signedAt: new Date().toISOString(), covers: '', valid: true, invalidReason: '' };
      const existing = this.batch.changes.find((change) => change.type === 'signoff' && change.id === id);
      if (existing) existing.payload = payload;
      else this.batch.changes.push({ type: 'signoff', id, baseVersion: base?.version ?? 0, insert: !base, payload });
      this.persistBatch();
      return true;
    },

    // ---- 提交整批：冲突整批退回 ------------------------------------------
    submitBatch() {
      if (!this.batch) return;
      const resolutions: Record<string, ConflictResolution> = {};
      for (const conflict of this.batch.conflicts) {
        if (conflict.resolution) resolutions[conflict.key] = conflict.resolution;
      }
      let outcome;
      try {
        outcome = commitBatch(this.batch.id, this.batch.changes, resolutions, this.actor);
      } catch (error) {
        if (error instanceof NetworkError) {
          this.batch.queued = true;
          this.persistBatch();
          this.pushToast(error.message, 'warning');
        } else {
          this.pushToast(error instanceof Error ? error.message : '提交失败', 'negative');
        }
        return;
      }
      if (outcome.ok && outcome.state) {
        this.server = outcome.state;
        const { invalidated, lockInvalidated } = outcome;
        this.lastCommit = { invalidated: invalidated ?? [], lockInvalidated: Boolean(lockInvalidated), revision: outcome.state.plan.revision };
        const invalidRoles = (invalidated ?? []).map((item) => item.role).join('、');
        if (invalidRoles) this.pushToast(`批次已提交：${invalidRoles} 会签因管辖数据更新立即失效，需重新签署。`, 'warning');
        else if (lockInvalidated) this.pushToast('批次已提交：发布锁已失效，需重新完成会签门禁。', 'warning');
        else this.pushToast(`批次 ${this.batch.id} 已提交，方案升级为 V${outcome.state.plan.revision}。`, 'positive');
        const id = this.batch.id;
        this.batch = null;
        this.persistBatch();
        try {
          serverCloseBatch(id);
        } catch {
          /* ignore */
        }
        return;
      }
      // 整批退回：用本地基线快照组装完整冲突清单
      this.batch.status = 'rejected';
      this.batch.conflicts = (outcome.conflicts ?? []).map((conflict) => this.enrichConflict(conflict));
      this.persistBatch();
      this.pushToast(`整批被退回：${this.batch.conflicts.length} 个对象已被他人修改，请在冲突清单中逐件处理。`, 'negative');
    },
    enrichConflict(conflict: BatchConflict): BatchConflict {
      const baseEntry = this.batch?.baseline[conflict.key];
      const base = (baseEntry?.snapshot ?? null) as unknown;
      return {
        ...conflict,
        base,
        changedFields: mergeableFields(conflict.type).filter((field) => {
          const mine = (conflict.mine as Record<string, unknown> | null)?.[field];
          const theirs = (conflict.theirs as Record<string, unknown> | null)?.[field];
          return JSON.stringify(mine) !== JSON.stringify(theirs);
        }),
        theirsUpdatedBy: conflict.theirsUpdatedBy ?? baseEntry?.updatedBy,
        resolution: conflict.resolution
      };
    },
    rebuildConflictsFromServer() {
      if (!this.batch || this.batch.status !== 'rejected') return;
      for (const conflict of this.batch.conflicts) {
        if (conflict.resolution) continue;
        const live = this.liveObject(conflict.type, conflict.id) as Record<string, unknown> | undefined;
        if (live) conflict.theirs = JSON.parse(JSON.stringify(live));
      }
      this.persistBatch();
    },
    liveObject(type: string, id: string): unknown {
      if (type === 'step') return this.server.steps.find((item) => item.id === id);
      if (type === 'comment') return this.server.comments.find((item) => item.id === id);
      if (type === 'conflict') return this.server.conflictReviews.find((item) => item.id === id);
      if (type === 'signoff') return this.server.signoffs.find((item) => item.id === id);
      return undefined;
    },
    setConflictStrategy(key: string, strategy: MergeStrategy) {
      if (!this.batch) return;
      const conflict = this.batch.conflicts.find((item) => item.key === key);
      if (!conflict) return;
      const fields: Record<string, 'mine' | 'theirs'> = {};
      for (const field of conflict.changedFields) fields[field] = 'mine';
      conflict.resolution = { strategy, fields: strategy === 'fields' ? fields : undefined };
      this.persistBatch();
    },
    setFieldChoice(key: string, field: string, side: 'mine' | 'theirs') {
      if (!this.batch) return;
      const conflict = this.batch.conflicts.find((item) => item.key === key);
      if (!conflict) return;
      if (!conflict.resolution) conflict.resolution = { strategy: 'fields', fields: {} };
      conflict.resolution.strategy = 'fields';
      conflict.resolution.fields = { ...(conflict.resolution.fields ?? {}), [field]: side };
      this.persistBatch();
    },
    resolvedCount(): number {
      return this.batch?.conflicts.filter((item) => item.resolution).length ?? 0;
    },

    // ---- 发布锁 ----------------------------------------------------------
    lockPlan() {
      try {
        const result = serverLockPlan(this.actor);
        if (result.state) this.server = result.state;
        if (result.ok) {
          this.pushToast(`门禁通过，方案 V${result.state?.plan.revision} 已锁定发布。`, 'positive');
        } else {
          this.lockBlockers = result.blockers;
          this.pushToast(`发布门禁未通过：${result.blockers[0] ?? '存在未满足条件'}`, 'negative');
        }
      } catch (error) {
        this.pushToast(error instanceof Error ? error.message : '锁定失败', 'negative');
      }
    },
    clearLockBlockers() {
      this.lockBlockers = [];
    },
    signAndMaybeLock(role: SignRole, name: string) {
      this.stageSignoff(role, name);
      this.pushToast(`${role}角色会签已纳入本批次，提交后立即生效。`, 'info');
    }
  }
});

export type { StagedComment, StagedSignoff };
