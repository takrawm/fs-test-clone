// src/model/ids.ts
import { stableHash } from '@/utils/hash.js';

export function cellId(fs: string, periodKey: string, accountId: string): string {
	const basis = `${fs}|${periodKey}|${accountId}`;
	return `cell:${stableHash(basis)}`;        // 日本語名を避け、英数16進固定
}

export function periodKey(year: number | string): string {
	return `FY:${year}`;
}
