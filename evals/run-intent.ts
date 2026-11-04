/**
 * Avaliação ponta a ponta do agente (RAG + LLM + tool calling).
 *
 * Roda cada mensagem do dataset pelo MESMO agente usado em produção e compara a ação
 * escolhida (reply | schedule | escalate) com a intenção esperada. Reporta:
 * - acurácia geral
 * - precisão / recall / F1 por classe (errar uma escalação é mais grave que errar um "reply")
 * - matriz de confusão
 * - latência p50/p95 e tokens
 * - lista de erros, para inspecionar caso a caso
 * O resultado completo é salvo em evals/results/<timestamp>.json, para comparar versões
 * de prompt/modelo ao longo do tempo.
 *
 * Uso:
 *   GROQ_API_KEY=... npm run eval
 *   npm run eval -- --model openai/gpt-oss-20b --limit 10 --min-accuracy 0.85
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import Groq from 'groq-sdk';
import { DEFAULT_AGENT_OPTIONS, SupportAgent } from '../src/ai/agent';
import { IntentLabel } from '../src/ai/tools';
import { EvalCase, buildIndex, getArg, loadDataset, pct, percentile } from './lib';

const LABELS: IntentLabel[] = ['reply', 'schedule', 'escalate'];

async function withRetry<T>(fn: () => Promise<T>, attempts = 5): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (i >= attempts - 1 || (status !== 429 && (status ?? 0) < 500)) throw err;
      const wait = 2000 * 2 ** i;
      console.warn(`  (HTTP ${status}, tentando de novo em ${wait / 1000}s)`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

async function main() {
  if (!process.env.GROQ_API_KEY) {
    console.error('Defina GROQ_API_KEY (no .env ou no ambiente) para rodar o eval de intenção.');
    process.exit(1);
  }

  const dataset = loadDataset();
  const index = buildIndex(dataset);
  const limit = Number(getArg('limit') || dataset.cases.length);
  const minAccuracy = getArg('min-accuracy');
  const options = { ...DEFAULT_AGENT_OPTIONS, model: getArg('model') || DEFAULT_AGENT_OPTIONS.model };
  const agent = new SupportAgent(new Groq({ apiKey: process.env.GROQ_API_KEY }), options);

  const cases = dataset.cases.slice(0, limit);
  const confusion: Record<IntentLabel, Record<IntentLabel, number>> = Object.fromEntries(
    LABELS.map((l) => [l, Object.fromEntries(LABELS.map((p) => [p, 0]))])
  ) as Record<IntentLabel, Record<IntentLabel, number>>;
  const latencies: number[] = [];
  let totalTokens = 0;
  const rows: Array<EvalCase & { predicted: IntentLabel | 'error'; ok: boolean; latency_ms: number; detail: string }> = [];

  console.log(`Modelo: ${options.model} | temperatura: ${options.temperature} | ${cases.length} casos\n`);

  for (const c of cases) {
    const start = Date.now();
    let predicted: IntentLabel | 'error';
    let detail = '';
    try {
      const result = await withRetry(() => agent.respond(index, c.history || [], c.message));
      predicted = result.action.type;
      totalTokens += result.usage?.total_tokens || 0;
      detail =
        result.action.type === 'escalate'
          ? `motivo: ${result.action.reason}`
          : result.action.type === 'schedule'
            ? `dados: ${JSON.stringify(result.action.data)}`
            : result.action.text.replace(/\s+/g, ' ').slice(0, 90);
    } catch (err) {
      predicted = 'error';
      detail = (err as Error).message;
    }
    const ms = Date.now() - start;
    latencies.push(ms);

    const ok = predicted === c.expected_intent;
    if (predicted !== 'error') confusion[c.expected_intent][predicted]++;
    console.log(
      `${ok ? '✓' : '✗'} ${c.id.padEnd(22)} esperado=${c.expected_intent.padEnd(8)} obtido=${predicted.padEnd(8)} ${ms}ms  ${detail}`
    );
    rows.push({ ...c, predicted, ok, latency_ms: ms, detail });
  }

  const correct = rows.filter((r) => r.ok).length;
  const accuracy = correct / rows.length;

  console.log(`\n── Resultado ──`);
  console.log(`Acurácia: ${pct(accuracy)} (${correct}/${rows.length})\n`);

  const perClass = LABELS.map((label) => {
    const tp = confusion[label][label];
    const fp = LABELS.reduce((s, l) => s + (l !== label ? confusion[l][label] : 0), 0);
    const fn = rows.filter((r) => r.expected_intent === label && r.predicted !== label).length;
    const precision = tp + fp ? tp / (tp + fp) : 0;
    const recall = tp + fn ? tp / (tp + fn) : 0;
    const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
    return { label, precision, recall, f1, support: tp + fn };
  });

  console.log('Classe     Precisão  Recall    F1        N');
  for (const m of perClass) {
    console.log(`${m.label.padEnd(10)} ${pct(m.precision).padEnd(9)} ${pct(m.recall).padEnd(9)} ${pct(m.f1).padEnd(9)} ${m.support}`);
  }

  console.log('\nMatriz de confusão (linha = esperado, coluna = obtido)');
  console.log(`${''.padEnd(10)} ${LABELS.map((l) => l.padEnd(9)).join(' ')}`);
  for (const l of LABELS) {
    console.log(`${l.padEnd(10)} ${LABELS.map((p) => String(confusion[l][p]).padEnd(9)).join(' ')}`);
  }

  console.log(
    `\nLatência p50=${percentile(latencies, 50)}ms p95=${percentile(latencies, 95)}ms | ` +
      `tokens: ${totalTokens} total, ${Math.round(totalTokens / rows.length)} por mensagem`
  );

  const errors = rows.filter((r) => !r.ok);
  if (errors.length) {
    console.log('\nErros:');
    for (const e of errors) console.log(`  - [${e.id}] "${e.message}" → esperado ${e.expected_intent}, obtido ${e.predicted} (${e.detail})`);
  }

  const outDir = path.join(__dirname, 'results');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(
    outFile,
    JSON.stringify({ options, accuracy, perClass, confusion, latencies, totalTokens, rows }, null, 2)
  );
  console.log(`\nResultado salvo em ${path.relative(process.cwd(), outFile)}`);

  if (minAccuracy && accuracy < Number(minAccuracy)) {
    console.error(`Acurácia ${pct(accuracy)} abaixo do mínimo ${pct(Number(minAccuracy))}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
