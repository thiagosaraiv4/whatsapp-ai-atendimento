/**
 * Avaliação do retriever (offline, sem chamar API).
 *
 * Para cada caso com `expected_chunks`, mede:
 * - Hit@k:    pelo menos um trecho esperado apareceu entre os k recuperados.
 * - Recall@k: fração dos trechos esperados que foram recuperados.
 * - MRR:      1 / posição do primeiro trecho esperado (1.0 = sempre em 1º lugar).
 * E também quanto o RAG reduz o tamanho do prompt em relação a mandar a base inteira.
 *
 * Uso: npm run eval:retrieval [-- --k 4] [-- --min-hit 0.9]
 */

import { buildSystemPrompt } from '../src/ai/agent';
import { buildIndex, getArg, loadDataset, pct } from './lib';

const dataset = loadDataset();
const index = buildIndex(dataset);
const k = Number(getArg('k') || 4);
const minHit = getArg('min-hit');

const cases = dataset.cases.filter((c) => c.expected_chunks?.length);
let hits = 0;
let recallSum = 0;
let rrSum = 0;
let promptChars = 0;
const misses: string[] = [];

for (const c of cases) {
  const results = index.retrieve(c.history || [], c.message, k);
  const ids = results.map((r) => r.chunk.id);
  const expected = c.expected_chunks!;

  const found = expected.filter((e) => ids.includes(e));
  const firstRank = ids.findIndex((id) => expected.includes(id));

  if (found.length) hits++;
  // Para perguntas com muitos trechos válidos (ex.: "quais serviços"), o máximo alcançável é k.
  recallSum += found.length / Math.min(expected.length, k);
  rrSum += firstRank >= 0 ? 1 / (firstRank + 1) : 0;
  promptChars += buildSystemPrompt(index.profile, results).length;

  const mark = found.length ? '✓' : '✗';
  console.log(`${mark} ${c.id.padEnd(22)} → [${ids.join(', ')}]`);
  if (!found.length) misses.push(`${c.id}: esperado ${expected.join(' | ')}, recuperado [${ids.join(', ')}]`);
}

const n = cases.length;
const fullPrompt = buildSystemPrompt(
  index.profile,
  index.chunks.map((chunk) => ({ chunk, score: 1 }))
).length;
const avgPrompt = promptChars / n;

console.log(`\n── Retrieval (BM25, k=${k}) — ${n} casos, ${index.chunks.length} chunks na base ──`);
console.log(`Hit@${k}:     ${pct(hits / n)}`);
console.log(`Recall@${k}:  ${pct(recallSum / n)}`);
console.log(`MRR:        ${(rrSum / n).toFixed(3)}`);
console.log(
  `Prompt:     ${Math.round(avgPrompt)} chars em média com RAG vs ${fullPrompt} com a base inteira ` +
    `(${pct(1 - avgPrompt / fullPrompt)} menor)`
);
if (misses.length) {
  console.log('\nFalhas:');
  for (const m of misses) console.log(`  - ${m}`);
}

if (minHit && hits / n < Number(minHit)) {
  console.error(`\nHit@${k} ${pct(hits / n)} abaixo do mínimo ${pct(Number(minHit))}`);
  process.exit(1);
}
