import { clone } from './diff';
import { defaultSignoffs, recomputeFindings, seedPlan } from './seed';
import { SERVER_KEY, writeServer } from './server';
import type { PlanState } from './types';

export const LEGACY_DRAFT_KEY = 'yy58-lift-plan-draft';
export const LEGACY_BACKUP_KEY = 'yy58-lift-plan-legacy-backup';

type LegacyDraft = {
  steps?: Record<string, any>[];
  comments?: Record<string, any>[];
  selectedStepId?: string;
  revision?: number;
  locked?: boolean;
  viewBookmarks?: string[];
  activeBookmark?: string;
};

/**
 * 旧稿升级：没有版本号的草稿先完成升级再纳入带基线的复核批次，
 * 原数据备份到 LEGACY_BACKUP_KEY，不做任何覆盖。
 */
export function upgradeLegacyIfNeeded(): { upgraded: boolean; reason?: string } {
  const serverRaw = localStorage.getItem(SERVER_KEY);
  if (serverRaw) return { upgraded: false };

  const draftRaw = localStorage.getItem(LEGACY_DRAFT_KEY);
  if (!draftRaw) {
    writeServer(seedPlan());
    return { upgraded: false };
  }

  const draft = JSON.parse(draftRaw) as LegacyDraft;
  // 升级前完整备份旧稿
  localStorage.setItem(LEGACY_BACKUP_KEY, draftRaw);

  const steps: PlanState['steps'] = (draft.steps ?? []).map((step) => ({ ...step, version: 1 })) as PlanState['steps'];
  const comments: PlanState['comments'] = (draft.comments ?? []).map((comment) => ({ ...comment, version: 1 })) as PlanState['comments'];
  const findings = recomputeFindings(steps, []);
  const signoffs = defaultSignoffs();
  if (draft.locked) {
    const accepted = signoffs.find((item) => item.state === 'accepted');
    if (accepted) {
      accepted.basedOnRevision = draft.revision ?? 4;
      accepted.signedAt = new Date().toISOString();
    }
  }

  const plan: PlanState = {
    revision: draft.revision ?? 4,
    steps,
    comments,
    findings,
    signoffs,
    lock: {
      locked: !!draft.locked,
      revision: draft.locked ? draft.revision ?? 4 : null,
      lockedBy: draft.locked ? '王工' : null,
      lockedAt: draft.locked ? new Date().toISOString() : null,
      version: 1
    }
  };
  writeServer(clone(plan));
  localStorage.removeItem(LEGACY_DRAFT_KEY);
  return { upgraded: true, reason: '检测到旧稿缺少版本号，已升级为带基线的复核批次，原数据已备份' };
}
