/**
 * retriever.ts
 * Recuperação lexical com BM25 sobre os chunks da base de conhecimento (o "R" do RAG).
 *
 * Por que BM25 e não embeddings?
 * - O Groq não oferece endpoint de embeddings; BM25 roda local, sem custo, sem latência de rede
 *   e é determinístico (dá para medir no eval sem chamar API nenhuma).
 * - Para FAQs curtas de pequenos negócios, busca lexical + sinônimos resolve a maior parte dos casos.
 * - A interface `Retriever` permite trocar por embeddings (ou busca híbrida BM25 + vetorial)
 *   sem mexer no agente.
 */

import { Chunk } from './knowledge-base';

export interface RetrievedChunk {
  chunk: Chunk;
  score: number;
}

export interface Retriever {
  search(query: string, opts?: { topK?: number }): RetrievedChunk[];
}

// Palavras muito frequentes que não ajudam a diferenciar trechos.
const STOPWORDS = new Set(
  (
    'a o e de da do das dos em no na nos nas um uma uns umas para pra pro por com sem que se ' +
    'eu voce voces vc vcs ele ela eles elas meu minha seu sua nosso nossa me te lhe isso esse essa este esta ' +
    'ai aqui la ja tem ter ha sao ser estar esta estou foi vai vou ou mas como qual quais quando ' +
    'oi ola bom boa dia tarde noite obrigado obrigada por favor gostaria queria quero saber ' +
    'mais muito pouco tambem so ao aos as os p r'
  ).split(/\s+/)
);

// Stemmer leve para português: remove plural e sufixos comuns, para que
// "agendar"/"agendamento" e "cancelar"/"cancelamento" virem o mesmo termo.
const SUFFIXES = ['amento', 'imento', 'mente', 'coes', 'cao', 'ado', 'ido', 'ndo', 'ar', 'er', 'ir', 'o', 'a', 'e'];

function stem(token: string): string {
  let t = token;
  if (t.length > 4 && t.endsWith('s')) t = t.slice(0, -1);
  for (const suf of SUFFIXES) {
    if (t.endsWith(suf) && t.length - suf.length >= 3) {
      return t.slice(0, -suf.length);
    }
  }
  return t;
}

export function tokenize(text: string): string[] {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
    .map(stem);
}

export class BM25Retriever implements Retriever {
  private readonly docs: { chunk: Chunk; tf: Map<string, number>; length: number }[];
  private readonly idf = new Map<string, number>();
  private readonly avgLength: number;

  constructor(
    chunks: Chunk[],
    private readonly params = { k1: 1.2, b: 0.75, topK: 4, minRelativeScore: 0.35 }
  ) {
    this.docs = chunks.map((chunk) => {
      const tokens = tokenize(chunk.searchText);
      const tf = new Map<string, number>();
      for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
      return { chunk, tf, length: tokens.length };
    });

    this.avgLength = this.docs.reduce((sum, d) => sum + d.length, 0) / Math.max(this.docs.length, 1);

    const df = new Map<string, number>();
    for (const d of this.docs) for (const term of d.tf.keys()) df.set(term, (df.get(term) || 0) + 1);
    const n = this.docs.length;
    for (const [term, freq] of df) {
      this.idf.set(term, Math.log(1 + (n - freq + 0.5) / (freq + 0.5)));
    }
  }

  search(query: string, opts: { topK?: number } = {}): RetrievedChunk[] {
    const topK = opts.topK ?? this.params.topK;
    const terms = [...new Set(tokenize(query))];
    if (terms.length === 0) return [];

    const { k1, b } = this.params;
    const scored = this.docs
      .map((d) => {
        let score = 0;
        for (const term of terms) {
          const f = d.tf.get(term);
          if (!f) continue;
          const idf = this.idf.get(term) || 0;
          score += (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.length) / this.avgLength));
        }
        return { chunk: d.chunk, score };
      })
      .filter((r) => r.score > 0)
      .sort((x, y) => y.score - x.score);

    if (scored.length === 0) return [];

    // Corte relativo: descarta trechos com score muito abaixo do melhor resultado,
    // para não poluir o prompt com contexto irrelevante.
    const threshold = scored[0].score * this.params.minRelativeScore;
    return scored.filter((r) => r.score >= threshold).slice(0, topK);
  }
}
