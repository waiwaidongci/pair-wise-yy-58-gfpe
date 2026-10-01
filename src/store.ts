import { defineStore } from 'pinia';
import { graphqlClient, LIFT_PLAN_QUERY } from './graphql';
import { clone, deepEqual, newId } from './collab/diff';
import { applyRecord, computeMerged, mergePlans } from './collab/merge';
import { nextBatchId, onMessage, readServer, writeServer } from './collab/server';
import { recomputeFindings } from './collab/seed';
import { upgradeLegacyIfNeeded } from './collab/upgrade';
import type { Comment, ConflictRecord, LiftStep, PlanState, ReviewBatch, Signoff, StepStatus } from './collab/types';

const BATCH_KEY = 'yy58-lift-plan-batch';

export type { StepStatus };

/** 工作副本相对基线发生变更的步骤集合（参数、评论、冲突结论变化） */
function affectedStepIds(base: PlanState, work: PlanState): Set<string> {
  const affected = new Set<string>();
  for (const step of work.steps) {
    const prev = base.steps.find((item) => item.id === step.id);
    if (!prev || !deepEqual(prev, step)) affected.add(step.id);
  }
  for (const prev of base.steps) {
    if (!work.steps.some((step) => step.id === prev.id)) affected.add(prev.id);
  }
  for (const comment of work.comments) {
    const prev = base.comments.find((item) => item.id === comment.id);
    if (!prev) affected.add(comment.stepId);
    else if (prev.status !== comment.status && comment.status === 'open') affected.add(comment.stepId);
  }
  for (const finding of work.findings) {
    const prev = base.findings.find((item) => item.id === finding.id);
    if (!prev || prev.status !== finding.status) affected.add(finding.stepId);
  }
  return affected;
}

export const useLiftStore = defineStore('lift-plan', {
  state: () => ({
    // 工作副本
    steps: [] as LiftStep[],
    comments: [] as Comment[],
    findings: [] as PlanState['findings'],
    signoffs: [] as Signoff[],
    lock: { locked: false, revision: null, lockedBy: null, lockedAt: null, version: 1 } as PlanState['lock'],
    selectedStepId: 'S-02',
    viewBookmarks: ['主吊全景', '东侧障碍', '安装轴线'],
    activeBookmark: '主吊全景',
    // 复核批次
    batch: null as ReviewBatch | null,
    conflicts: [] as ConflictRecord[],
    conflictDialogOpen: false,
    // 协同状态
    online: typeof navigator !== 'undefined' ? navigator.onLine : true,
    remoteDirty: false,
    showUpgrade: false,
    showRecovery: false,
    toast: ''
  }),
  getters: {
    selectedStep(state): LiftStep {
      return state.steps.find((step) => step.id === state.selectedStepId) ?? state.steps[0];
    },
    openFindings(state) {
      return state.findings.filter((finding) => finding.status === 'open');
    },
    openComments(state) {
      return state.comments.filter((comment) => comment.status === 'open');
    },
    readiness(state): number {
      const passedChecks = state.steps.filter((step) => step.status === 'passed').length;
      const commentPenalty = state.comments.filter((item) => item.status === 'open').length * 12;
      return Math.max(0, Math.round((passedChecks / Math.max(state.steps.length, 1)) * 100 - commentPenalty));
    },
    revision(state): number {
      return state.batch?.baseline.revision ?? state.lock.revision ?? 4;
    },
    hasUnsavedChanges(state): boolean {
      if (!state.batch) return false;
      const base = state.batch.baseline;
      return (
        !deepEqual(state.steps, base.steps) ||
        !deepEqual(state.comments, base.comments) ||
        !deepEqual(state.findings, base.findings) ||
        !deepEqual(state.signoffs, base.signoffs) ||
        !deepEqual(state.lock, base.lock)
      );
    },
    allSigned(state): boolean {
      return state.signoffs.length > 0 && state.signoffs.every((item) => item.state === 'accepted' && item.valid);
    },
    batchLabel(state): string {
      return state.batch ? `批次 #${state.batch.batchId}` : '未取批次';
    }
  },
  actions: {
    init() {
      const result = upgradeLegacyIfNeeded();
      if (result.upgraded) {
        this.showUpgrade = true;
        this.toast = result.reason ?? '';
      }
      const server = readServer();
      this.resetWorking(server);
      this.syncApollo(server);

      try {
        const raw = localStorage.getItem(BATCH_KEY);
        if (raw) {
          const saved = JSON.parse(raw);
          if (saved.batch && (saved.batch.status === 'editing' || saved.batch.status === 'conflict')) {
            this.showRecovery = true;
          }
        }
      } catch {
        /* 批次存档损坏时忽略 */
      }

      onMessage((message) => {
        if (message.type === 'committed' && this.batch && this.batch.baseline.revision < message.revision) {
          this.remoteDirty = true;
        }
      });

      window.addEventListener('online', () => {
        this.online = true;
        if (this.batch) {
          this.batch.offline = false;
          if (this.hasUnsavedChanges) this.saveBatch();
        }
      });
      window.addEventListener('offline', () => {
        this.online = false;
        if (this.batch) {
          this.batch.offline = true;
          this.persistBatch();
        }
      });
    },

    resetWorking(plan: PlanState) {
      this.steps = clone(plan.steps);
      this.comments = clone(plan.comments);
      this.findings = clone(plan.findings);
      this.signoffs = clone(plan.signoffs);
      this.lock = clone(plan.lock);
    },

    workingPlan(): PlanState {
      return {
        revision: this.revision,
        steps: this.steps,
        comments: this.comments,
        findings: this.findings,
        signoffs: this.signoffs,
        lock: this.lock
      };
    },

    /** 修改前先取批次号：以服务端当前状态为基线 */
    acquireBatch() {
      const server = readServer();
      this.batch = {
        batchId: nextBatchId(),
        baseline: clone(server),
        acquiredAt: new Date().toISOString(),
        status: 'editing',
        offline: !this.online
      };
      this.resetWorking(server);
      this.conflicts = [];
      this.conflictDialogOpen = false;
      this.remoteDirty = false;
      this.persistBatch();
    },

    ensureBatch() {
      if (!this.batch) this.acquireBatch();
    },

    /**
     * 保存批次：以基线为基准做三路比对。
     * 无冲突直接提交；有冲突整批退回冲突清单，由用户选择合并方式。
     */
    saveBatch() {
      this.ensureBatch();
      if (!this.online) {
        this.batch!.offline = true;
        this.toast = '当前离线：修改已暂存在本机，联网后自动保存';
        this.persistBatch();
        return;
      }
      const base = this.batch!.baseline;
      const work = this.workingPlan();
      const server = readServer();
      const { plan, conflicts } = mergePlans(base, work, server);
      if (conflicts.length > 0) {
        this.conflicts = conflicts;
        this.conflictDialogOpen = true;
        this.batch!.status = 'conflict';
        this.persistBatch();
        return;
      }
      this.commit(plan, base, work);
    },

    /** 用户在冲突清单中选定合并方式后，整批提交 */
    applyResolutions() {
      if (!this.batch) return;
      const base = this.batch.baseline;
      const work = this.workingPlan();
      const server = readServer();
      const { plan, conflicts } = mergePlans(base, work, server);

      // 打开冲突清单后对方又提交了新版本：把新冲突并入清单
      const known = new Set(this.conflicts.map((item) => `${item.objectType}:${item.objectId}`));
      const fresh = conflicts.filter((item) => !known.has(`${item.objectType}:${item.objectId}`));
      if (fresh.length > 0) {
        this.conflicts = [...this.conflicts, ...fresh];
        this.batch.status = 'conflict';
        this.persistBatch();
        return;
      }

      for (const record of this.conflicts) {
        if (record.resolution !== 'keep-local' && record.resolution !== 'keep-remote' && record.resolution !== 'keep-both' && record.resolution !== 'merge') {
          record.resolution = 'merge';
        }
        // 删除/新增冲突不支持字段合并时，默认按「保留本地」处理
        if (record.resolution === 'merge' && !record.supportsMerge) record.resolution = 'keep-local';
        if (!record.merged && record.supportsMerge) computeMerged(record);
        applyRecord(plan, record);
      }
      this.conflicts = [];
      this.conflictDialogOpen = false;
      this.commit(plan, base, work);
    },

    /** 提交：失效相关会签与发布锁、复核冲突项、写服务端、换新基线 */
    commit(plan: PlanState, base: PlanState, work: PlanState) {
      const affected = affectedStepIds(base, work);
      let invalidated = false;
      for (const signoff of plan.signoffs) {
        // 以基线为准：签署时有效且覆盖的步骤/评论在本批次发生变更，会签即失效
        const baseSignoff = base.signoffs.find((item) => item.id === signoff.id);
        const wasAccepted = baseSignoff?.state === 'accepted' && baseSignoff.valid;
        if (wasAccepted && affected.size > 0 && (signoff.stepIds.length === 0 || signoff.stepIds.some((id) => affected.has(id)))) {
          signoff.valid = false;
          signoff.state = 'pending';
          invalidated = true;
        }
      }
      if (invalidated) {
        plan.lock = { ...plan.lock, locked: false, revision: null, lockedBy: null, lockedAt: null, version: plan.lock.version + 1 };
      }
      for (const signoff of plan.signoffs) {
        if (signoff.state === 'accepted' && signoff.valid) signoff.basedOnRevision = plan.revision;
      }
      plan.findings = recomputeFindings(plan.steps, plan.findings);

      writeServer(plan);
      this.resetWorking(plan);
      this.batch!.baseline = clone(plan);
      this.batch!.status = 'saved';
      this.conflicts = [];
      this.conflictDialogOpen = false;
      this.remoteDirty = false;
      this.syncApollo(plan);
      this.persistBatch();
      const savedBatchId = this.batch!.batchId;
      this.acquireBatch();
      this.toast = `批次 #${savedBatchId} 已保存，方案发布至 V${plan.revision}`;
    },

    /** 工作副本中参数/评论一旦变更，相关会签立即失效（保持失效状态直到重新签署） */
    recomputeWorkingValidity() {
      if (!this.batch) return;
      const affected = affectedStepIds(this.batch.baseline, this.workingPlan());
      if (affected.size === 0) return;
      let changed = false;
      for (const signoff of this.signoffs) {
        if (signoff.state === 'accepted' && signoff.valid && affected.size > 0 && (signoff.stepIds.length === 0 || signoff.stepIds.some((id) => affected.has(id)))) {
          signoff.valid = false;
          signoff.state = 'pending';
          changed = true;
        }
      }
      if (changed) this.persistBatch();
    },

    selectStep(id: string) {
      this.selectedStepId = id;
      this.persistBatch();
    },

    updateStep(patch: Partial<LiftStep>) {
      this.ensureBatch();
      const step = this.selectedStep;
      if (!step) return;
      Object.assign(step, patch);
      this.recomputeWorkingValidity();
      this.persistBatch();
    },

    setStatus(status: StepStatus) {
      this.updateStep({ status });
    },

    addComment(content: string, author = '王工', role = '方案') {
      if (!content.trim()) return;
      this.ensureBatch();
      this.comments.unshift({ id: newId('C'), author, role, content, status: 'open', stepId: this.selectedStepId, version: 1 });
      this.recomputeWorkingValidity();
      this.persistBatch();
    },

    resolveComment(id: string) {
      const comment = this.comments.find((item) => item.id === id);
      if (!comment || comment.status !== 'open') return;
      this.ensureBatch();
      comment.status = 'resolved';
      this.persistBatch();
    },

    toggleFinding(id: string) {
      this.ensureBatch();
      const finding = this.findings.find((item) => item.id === id);
      if (!finding) return;
      finding.status = finding.status === 'open' ? 'resolved' : 'open';
      finding.conclusion = finding.status === 'resolved' ? '现场复核确认，按方案执行。' : '';
      this.recomputeWorkingValidity();
      this.persistBatch();
    },

    signoff(id: string) {
      this.ensureBatch();
      const item = this.signoffs.find((signoff) => signoff.id === id);
      if (!item) return;
      item.state = 'accepted';
      item.valid = true;
      item.signedAt = new Date().toISOString();
      item.basedOnRevision = this.batch!.baseline.revision;
      this.persistBatch();
    },

    lockPlan() {
      if (this.lock.locked) return;
      if (this.openFindings.length > 0 || this.openComments.length > 0 || !this.allSigned) {
        this.toast = '发布门禁未满足：冲突清零、意见全部关闭、四个角色完成会签后才能锁定发布';
        return;
      }
      this.ensureBatch();
      this.lock = { locked: true, revision: this.revision + 1, lockedBy: '王工', lockedAt: new Date().toISOString(), version: this.lock.version + 1 };
      this.persistBatch();
      this.saveBatch();
    },

    setBookmark(name: string) {
      this.activeBookmark = name;
      if (!this.viewBookmarks.includes(name)) this.viewBookmarks.push(name);
      this.persistBatch();
    },

    discardBatch() {
      if (!this.batch) return;
      this.resetWorking(this.batch.baseline);
      this.batch = null;
      this.conflicts = [];
      this.conflictDialogOpen = false;
      localStorage.removeItem(BATCH_KEY);
    },

    /** 断网重开后恢复未完成批次 */
    recoverBatch() {
      try {
        const raw = localStorage.getItem(BATCH_KEY);
        if (raw) {
          const saved = JSON.parse(raw);
          if (saved.batch) {
            const batch = saved.batch as ReviewBatch;
            this.batch = batch;
            this.resetWorking(saved.working);
            this.conflicts = saved.conflicts ?? [];
            this.conflictDialogOpen = batch.status === 'conflict';
            this.remoteDirty = false;
          }
        }
      } catch {
        /* 恢复失败时丢弃存档 */
      }
      this.showRecovery = false;
      this.toast = '已恢复未完成批次，可继续编辑或保存';
    },

    discardRecovery() {
      localStorage.removeItem(BATCH_KEY);
      this.resetWorking(readServer());
      this.batch = null;
      this.conflicts = [];
      this.showRecovery = false;
    },

    dismissUpgrade() {
      this.showUpgrade = false;
    },

    persistBatch() {
      if (typeof localStorage === 'undefined' || !this.batch) return;
      localStorage.setItem(
        BATCH_KEY,
        JSON.stringify({
          batch: this.batch,
          working: this.workingPlan(),
          conflicts: this.conflicts,
          savedAt: new Date().toISOString()
        })
      );
    },

    syncApollo(plan: PlanState) {
      graphqlClient.writeQuery({
        query: LIFT_PLAN_QUERY,
        variables: { id: 'LP-2026-0918' },
        data: {
          liftPlan: {
            __typename: 'LiftPlan',
            id: 'LP-2026-0918',
            name: '东塔转换桁架吊装',
            revision: plan.revision,
            status: plan.lock.locked ? 'LOCKED' : 'REVIEW',
            steps: plan.steps.map((step) => ({ id: step.id, name: step.title, loadRate: step.loadRate, clearance: step.clearance }))
          }
        }
      });
    }
  }
});
