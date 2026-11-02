/**
 * Utilitários compartilhados pelos scripts de avaliação.
 */

import fs from 'fs';
import path from 'path';
import { ChatTurn, KnowledgeIndex } from '../src/ai/agent';
import { readKnowledgeBase } from '../src/ai/knowledge-base';
import { IntentLabel } from '../src/ai/tools';

export interface EvalCase {
  id: string;
  message: string;
  history?: ChatTurn[];
  expected_intent: IntentLabel;
  /** Trechos que deveriam ser recuperados (para o eval de retrieval). */
  expected_chunks?: string[];
}

export interface EvalDataset {
  description: string;
  tenant: {
    slug: string;
    name: string;
    knowledge_base: string;
    scheduling_enabled: boolean;
    cancellation_policy?: string;
  };
  cases: EvalCase[];
}

export const ROOT = path.resolve(__dirname, '..');

export function loadDataset(file = path.join(__dirname, 'dataset.json')): EvalDataset {
  return JSON.parse(fs.readFileSync(file, 'utf-8')) as EvalDataset;
}

export function buildIndex(dataset: EvalDataset): KnowledgeIndex {
  const t = dataset.tenant;
  return new KnowledgeIndex({
    name: t.name,
    kb: readKnowledgeBase(path.resolve(ROOT, t.knowledge_base)),
    schedulingEnabled: t.scheduling_enabled,
    cancellationPolicy: t.cancellation_policy,
  });
}

export function getArg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

export const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

export function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}
