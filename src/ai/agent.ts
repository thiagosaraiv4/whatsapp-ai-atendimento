/**
 * agent.ts
 * O agente de atendimento: RAG (recupera trechos relevantes) + LLM com tool calling.
 *
 * Fluxo de uma mensagem:
 *   1. Monta a consulta (mensagem atual + mensagem anterior do cliente, para perguntas de follow-up).
 *   2. Recupera os top-k trechos da base com BM25.
 *   3. Monta o system prompt só com esses trechos (não com a base inteira).
 *   4. Chama o LLM oferecendo as ferramentas `agendar_servico` e `escalar_humano`.
 *   5. Converte a resposta em uma `AgentAction` validada, que a aplicação executa.
 *
 * Não depende de `config` (recebe o cliente Groq por injeção), para ser reutilizado no eval.
 */

import type Groq from 'groq-sdk';
import { Chunk, KnowledgeBase, chunkKnowledgeBase } from './knowledge-base';
import { BM25Retriever, RetrievedChunk, Retriever } from './retriever';
import { AgentAction, getTools, toAction } from './tools';

export const DEFAULT_AGENT_OPTIONS = {
  model: 'openai/gpt-oss-120b',
  maxTokens: 1024,
  temperature: 0.3,
  topK: 4,
};

export type AgentOptions = typeof DEFAULT_AGENT_OPTIONS;

export type ChatTurn = { role: 'user' | 'assistant'; content: string };

export interface AgentProfile {
  /** Nome exibido do negócio. */
  name: string;
  kb: KnowledgeBase;
  schedulingEnabled: boolean;
  cancellationPolicy?: string;
}

export interface AgentResult {
  action: AgentAction;
  retrieved: RetrievedChunk[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

/** Base indexada de um tenant: chunks + retriever. Construída uma vez e cacheada. */
export class KnowledgeIndex {
  readonly chunks: Chunk[];
  readonly retriever: Retriever;

  constructor(readonly profile: AgentProfile) {
    this.chunks = chunkKnowledgeBase(profile.kb, profile.cancellationPolicy);
    this.retriever = new BM25Retriever(this.chunks);
  }

  /**
   * Consulta = mensagem atual + última mensagem do cliente no histórico.
   * Resolve follow-ups como "e quanto custa?" logo depois de "vocês fazem barba?".
   */
  retrieve(history: ChatTurn[], userMessage: string, topK?: number): RetrievedChunk[] {
    const previousUser = [...history].reverse().find((m) => m.role === 'user' && m.content !== userMessage);
    const query = previousUser ? `${userMessage} ${previousUser.content}` : userMessage;
    return this.retriever.search(query, { topK });
  }
}

export function buildSystemPrompt(profile: AgentProfile, retrieved: RetrievedChunk[]): string {
  const { kb } = profile;
  const context = retrieved.length
    ? retrieved.map((r) => `[${r.chunk.id}]\n${r.chunk.text}`).join('\n\n')
    : '(nenhum trecho relevante encontrado para esta mensagem)';
  const services = (kb.services || []).map((s) => s.name).join(', ');

  return `Você é o assistente virtual de atendimento da ${kb.company.name || profile.name}, via WhatsApp.

## SOBRE A EMPRESA
${kb.company.description}
${services ? `Serviços oferecidos: ${services}.` : ''}

## TRECHOS RELEVANTES DA BASE DE CONHECIMENTO
Os trechos abaixo foram recuperados automaticamente para a mensagem atual. Eles são a ÚNICA fonte
de fatos (preços, horários, endereço, políticas). Se a resposta não estiver neles, diga que não tem
essa informação e ofereça falar com um atendente — nunca invente.

${context}

## FERRAMENTAS
- \`agendar_servico\`: chame quando o cliente quiser marcar um horário. Preencha apenas o que ele já
  informou; o sistema pergunta o resto. Não chame só porque ele perguntou preço ou horário de funcionamento.
- \`escalar_humano\`: chame quando o cliente pedir uma pessoa, estiver frustrado/reclamando, ou tiver um
  problema que os trechos acima não resolvem. Junto com a chamada, avise que vai transferir.
- Para dúvidas comuns, apenas responda em texto, sem chamar ferramentas.

## ESTILO
- Português do Brasil, cordial e objetivo. No máximo 3 parágrafos curtos.
- Use emojis com moderação (no máximo 1-2 por mensagem).
- Na primeira mensagem da conversa, apresente-se brevemente como assistente virtual.`;
}

export class SupportAgent {
  constructor(
    private readonly client: Groq,
    private readonly options: AgentOptions = DEFAULT_AGENT_OPTIONS
  ) {}

  async respond(index: KnowledgeIndex, history: ChatTurn[], userMessage: string): Promise<AgentResult> {
    const retrieved = index.retrieve(history, userMessage, this.options.topK);
    const messages: Groq.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: buildSystemPrompt(index.profile, retrieved) },
      ...history.map((m) => ({ role: m.role, content: m.content })),
      { role: 'user', content: userMessage },
    ];
    const tools = getTools({ schedulingEnabled: index.profile.schedulingEnabled });

    const request = {
      model: this.options.model,
      messages,
      max_tokens: this.options.maxTokens,
      temperature: this.options.temperature,
      tools,
    };

    let completion: Groq.Chat.ChatCompletion;
    try {
      completion = await this.client.chat.completions.create({ ...request, tool_choice: 'auto' });
    } catch (err) {
      // Groq retorna 400 `tool_use_failed` quando o modelo gera uma chamada malformada.
      // Em vez de deixar o cliente sem resposta, tenta de novo forçando resposta em texto.
      if (!isToolUseFailed(err)) throw err;
      console.warn('[Agent] tool_use_failed — retrying without tools');
      completion = await this.client.chat.completions.create({ ...request, tool_choice: 'none' });
    }

    const message = completion.choices[0]?.message;
    return {
      action: toAction(message?.content, message?.tool_calls),
      retrieved,
      usage: completion.usage,
    };
  }
}

function isToolUseFailed(err: unknown): boolean {
  const e = err as { status?: number; error?: { error?: { code?: string } }; message?: string };
  return e?.status === 400 && (e.error?.error?.code === 'tool_use_failed' || /tool_use_failed/.test(e.message || ''));
}
