// src/model/registry.ts
import type { Cell, NodeId } from '@/model/types.js';

export class NodeRegistry {
  private seq = 0;
  private map = new Map<NodeId, Cell>();
  newId(): NodeId { return `n:${++this.seq}`; }   // 内部用なので可変でOK（外部露出しない）
  add(n: Cell) { this.map.set(n.id, n); return n.id; }
  get(id: NodeId) { const n = this.map.get(id); if (!n) throw new Error(`Node not found: ${id}`); return n; }
  all(): Cell[] { return Array.from(this.map.values()); }
}
