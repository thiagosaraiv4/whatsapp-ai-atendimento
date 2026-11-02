/**
 * ai.ts
 * Adaptador entre a aplicação (tenants, config, arquivos) e o agente em `src/ai/`.
 * Carrega e indexa a base de conhecimento de cada tenant (com cache) e delega a conversa ao agente.
 */

import Groq from 'groq-sdk';
import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { TenantWithConfig } from '../database';
import { ChatTurn, KnowledgeIndex, SupportAgent } from '../ai/agent';
import { KnowledgeBase, readKnowledgeBase } from '../ai/knowledge-base';
import { AgentAction } from '../ai/tools';

export type { AgentAction, SchedulingData } from '../ai/tools';

class AIService {
  private agent: SupportAgent;
  // Cache por tenant: slug → base indexada (chunks + BM25)
  private indexCache: Map<string, KnowledgeIndex> = new Map();

  constructor() {
    const client = new Groq({ apiKey: config.GROQ_API_KEY });
    this.agent = new SupportAgent(client, {
      model: config.AI_MODEL,
      maxTokens: config.AI_MAX_TOKENS,
      temperature: config.AI_TEMPERATURE,
      topK: config.AI_RETRIEVAL_TOP_K,
    });
  }

  private loadKnowledgeBase(tenant: TenantWithConfig): KnowledgeBase {
    const candidates = [
      path.join(config.TENANTS_DATA_PATH, tenant.slug, 'knowledge-base.json'),
      config.KNOWLEDGE_BASE_PATH, // legado (single-tenant)
    ];
    for (const file of candidates) {
      if (!fs.existsSync(file)) continue;
      try {
        const kb = readKnowledgeBase(file);
        console.log(`[AI] Knowledge base for tenant ${tenant.slug}: ${file}`);
        return kb;
      } catch (err) {
        console.error(`[AI] Failed to load KB ${file}:`, err);
      }
    }
    return { company: { name: tenant.name, description: 'Serviços profissionais' }, services: [], faq: [] };
  }

  getIndex(tenant: TenantWithConfig): KnowledgeIndex {
    const cached = this.indexCache.get(tenant.slug);
    if (cached) return cached;

    const index = new KnowledgeIndex({
      name: tenant.name,
      kb: this.loadKnowledgeBase(tenant),
      schedulingEnabled: tenant.config.scheduling_enabled !== false,
      cancellationPolicy: tenant.config.cancellation_policy,
    });
    console.log(`[AI] Indexed ${index.chunks.length} chunks for tenant ${tenant.slug}`);
    this.indexCache.set(tenant.slug, index);
    return index;
  }

  /**
   * Gera a próxima ação do agente para a mensagem do cliente.
   * `history` pode já conter a mensagem atual (ela é salva antes da chamada); nesse caso ela é
   * removida do fim do histórico para não ir duplicada ao modelo.
   */
  async respond(history: ChatTurn[], userMessage: string, tenant: TenantWithConfig): Promise<AgentAction> {
    const last = history[history.length - 1];
    const priorHistory = last && last.role === 'user' && last.content === userMessage ? history.slice(0, -1) : history;

    const result = await this.agent.respond(this.getIndex(tenant), priorHistory, userMessage);
    console.log(
      `[AI] tenant=${tenant.slug} action=${result.action.type} ` +
        `retrieved=[${result.retrieved.map((r) => r.chunk.id).join(', ')}] tokens=${result.usage?.total_tokens ?? '?'}`
    );
    return result.action;
  }

  reloadKnowledgeBase(tenantSlug?: string): void {
    if (tenantSlug) {
      this.indexCache.delete(tenantSlug);
    } else {
      this.indexCache.clear();
    }
  }
}

export const aiService = new AIService();
