<script setup lang="ts">
import { useLiftStore } from '../store';
import { computeMerged, fieldLabel } from '../collab/merge';
import type { ConflictRecord, ConflictResolution } from '../collab/types';

const store = useLiftStore();

const typeLabels: Record<ConflictRecord['objectType'], string> = {
  step: '三维步骤',
  comment: '评论',
  finding: '冲突项',
  signoff: '会签',
  lock: '发布锁'
};

const statusMaps: Record<string, Record<string, string>> = {
  status: { pending: '待复核', passed: '通过', blocked: '阻断', open: '未解决', resolved: '已解决', accepted: '已接受', reserved: '有保留' },
  state: { pending: '待确认', accepted: '已接受', reserved: '有保留' }
};

function formatValue(field: string, value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (statusMaps[field]?.[String(value)]) return statusMaps[field][String(value)];
  if (Array.isArray(value)) return value.length ? value.join('、') : '全部步骤';
  return String(value);
}

function resolutionOptions(record: ConflictRecord) {
  const options: { value: ConflictResolution; label: string; hint: string; disabled?: boolean }[] = [
    { value: 'merge', label: '按字段合并', hint: '逐字段选择保留哪一方', disabled: !record.supportsMerge },
    { value: 'keep-local', label: '保留一方：本地', hint: '以你的版本为准' },
    { value: 'keep-remote', label: '保留一方：对方', hint: '以对方版本为准' }
  ];
  if (record.supportsBoth) {
    options.push({ value: 'keep-both', label: '保留双方', hint: '两份内容都保留' });
  }
  return options;
}

function chooseResolution(record: ConflictRecord, resolution: ConflictResolution) {
  record.resolution = resolution;
  computeMerged(record);
}

function pickField(record: ConflictRecord, field: string, pick: 'local' | 'remote') {
  const target = record.fieldConflicts.find((item) => item.field === field);
  if (target) target.pick = pick;
  computeMerged(record);
}

function changedText(record: ConflictRecord, fields: string[]): string {
  return fields.map((field) => fieldLabel(field)).join('、');
}
</script>

<template>
  <q-dialog
    :model-value="store.conflictDialogOpen"
    persistent
    transition-show="scale"
    transition-hide="scale"
    class="conflict-dialog"
  >
    <q-card class="conflict-card">
      <q-card-section class="conflict-header">
        <div>
          <div class="eyebrow">BATCH CONFLICT</div>
          <h2>保存冲突 · 整批退回冲突清单</h2>
          <p>基线为取批次号时的版本；以下对象你和其他标签页都改过。请逐条选择处理方式，完成后整批提交。</p>
        </div>
        <q-badge color="negative">{{ store.conflicts.length }} 项冲突</q-badge>
      </q-card-section>

      <q-card-section class="conflict-body">
        <article v-for="record in store.conflicts" :key="`${record.objectType}-${record.objectId}`" class="conflict-record">
          <div class="record-head">
            <q-badge outline color="primary">{{ typeLabels[record.objectType] }}</q-badge>
            <strong>{{ record.label }}</strong>
          </div>

          <div class="resolution-options">
            <label
              v-for="option in resolutionOptions(record)"
              :key="option.value"
              class="resolution-option"
              :class="{ active: record.resolution === option.value, disabled: option.disabled }"
            >
              <input
                type="radio"
                :name="`${record.objectType}-${record.objectId}`"
                :value="option.value"
                :checked="record.resolution === option.value"
                :disabled="option.disabled"
                @change="chooseResolution(record, option.value)"
              />
              <span>{{ option.label }}<small>{{ option.hint }}</small></span>
            </label>
          </div>

          <div v-if="record.resolution === 'merge' && record.supportsMerge" class="merge-table">
            <div v-if="record.localChangedFields.length" class="merge-row single">
              <span class="merge-tag local">仅本地修改</span>
              <span>{{ changedText(record, record.localChangedFields) }}</span>
            </div>
            <div v-if="record.remoteChangedFields.length" class="merge-row single">
              <span class="merge-tag remote">仅对方修改</span>
              <span>{{ changedText(record, record.remoteChangedFields) }}</span>
            </div>
            <div v-for="field in record.fieldConflicts" :key="field.field" class="merge-row field-conflict">
              <span class="field-name">{{ field.label }}</span>
              <div class="field-picks">
                <button
                  class="pick"
                  :class="{ active: field.pick === 'local' }"
                  @click="pickField(record, field.field, 'local')"
                >
                  <em>本地</em>{{ formatValue(field.field, field.local) }}
                </button>
                <button
                  class="pick"
                  :class="{ active: field.pick === 'remote' }"
                  @click="pickField(record, field.field, 'remote')"
                >
                  <em>对方</em>{{ formatValue(field.field, field.remote) }}
                </button>
              </div>
            </div>
          </div>

          <p v-if="record.resolution === 'keep-both'" class="keep-both-hint">
            将同时保留本地与对方的两份{{ typeLabels[record.objectType] }}内容。
          </p>
        </article>
      </q-card-section>

      <q-card-actions align="right" class="conflict-footer">
        <q-btn flat no-caps label="稍后处理" @click="store.conflictDialogOpen = false" />
        <q-btn color="primary" no-caps icon="check" label="应用合并并保存批次" @click="store.applyResolutions" />
      </q-card-actions>
    </q-card>
  </q-dialog>
</template>

<style scoped>
.conflict-card { width: min(760px, 94vw); max-height: 88vh; display: flex; flex-direction: column; }
.conflict-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; border-bottom: 1px solid var(--line); }
.conflict-header h2 { margin: 4px 0 6px; font-size: 18px; }
.conflict-header p { margin: 0; color: #75867f; font-size: 12px; }
.conflict-body { overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 12px; }
.conflict-record { border: 1px solid var(--line); border-radius: 8px; padding: 12px; background: #fafcfb; }
.record-head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.record-head strong { font-size: 14px; }
.resolution-options { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 10px; }
.resolution-option { display: flex; align-items: center; gap: 6px; border: 1px solid var(--line); border-radius: 6px; padding: 6px 10px; cursor: pointer; background: #fff; font-size: 12px; }
.resolution-option.active { border-color: var(--accent); background: #e6f3ef; }
.resolution-option.disabled { opacity: .45; cursor: not-allowed; }
.resolution-option span { display: flex; flex-direction: column; }
.resolution-option small { color: #75867f; font-size: 10px; }
.merge-table { display: flex; flex-direction: column; gap: 6px; }
.merge-row { display: flex; align-items: center; gap: 8px; font-size: 12px; }
.merge-row.single { color: #566b63; }
.merge-tag { padding: 2px 6px; border-radius: 3px; font-size: 10px; color: #fff; }
.merge-tag.local { background: #2b6cb0; }
.merge-tag.remote { background: #995b14; }
.field-name { width: 70px; color: #5f736b; font-weight: 700; flex-shrink: 0; }
.field-picks { display: flex; gap: 6px; flex: 1; }
.pick { flex: 1; text-align: left; border: 1px solid var(--line); background: #fff; border-radius: 5px; padding: 6px 8px; cursor: pointer; font-size: 12px; color: var(--ink); }
.pick em { display: block; font-style: normal; font-size: 10px; color: #75867f; margin-bottom: 2px; }
.pick.active { border-color: var(--accent); background: #e6f3ef; }
.keep-both-hint { margin: 8px 0 0; font-size: 11px; color: #2b6cb0; }
.conflict-footer { border-top: 1px solid var(--line); }
</style>
