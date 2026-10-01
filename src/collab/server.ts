import { clone } from './diff';
import { seedPlan } from './seed';
import type { PlanState } from './types';

export const SERVER_KEY = 'yy58-lift-plan-server';
const SEQ_KEY = 'yy58-lift-plan-batch-seq';
const CHANNEL_NAME = 'yy58-lift-collab';

/**
 * 模拟服务端：所有标签页共享的权威基线。
 * 真实环境替换为 GraphQL 远端查询即可。
 */
export function readServer(): PlanState {
  try {
    const raw = localStorage.getItem(SERVER_KEY);
    if (raw) return JSON.parse(raw) as PlanState;
  } catch {
    /* 数据损坏时重新播种 */
  }
  const seeded = seedPlan();
  writeServer(seeded);
  return seeded;
}

export function writeServer(state: PlanState): void {
  localStorage.setItem(SERVER_KEY, JSON.stringify(state));
  broadcast({ type: 'committed', revision: state.revision });
}

export function nextBatchId(): number {
  const current = Number(localStorage.getItem(SEQ_KEY) ?? '0');
  const next = current + 1;
  localStorage.setItem(SEQ_KEY, String(next));
  return next;
}

type CollabMessage = { type: 'committed'; revision: number };

let channel: BroadcastChannel | null = null;

function getChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  if (!channel) channel = new BroadcastChannel(CHANNEL_NAME);
  return channel;
}

export function broadcast(message: CollabMessage): void {
  try {
    getChannel()?.postMessage(message);
  } catch {
    /* 广播不可用时忽略 */
  }
}

export function onMessage(handler: (message: CollabMessage) => void): () => void {
  const ch = getChannel();
  if (!ch) return () => undefined;
  ch.onmessage = (event: MessageEvent) => handler(event.data as CollabMessage);
  return () => {
    ch.onmessage = null;
  };
}

export function resetServerForTest(): void {
  localStorage.removeItem(SERVER_KEY);
  localStorage.removeItem(SEQ_KEY);
}

export { clone };
