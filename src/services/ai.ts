import Groq from 'groq-sdk';
import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { TenantWithConfig } from '../database';

interface KnowledgeBaseService {
  name: string;
  price: string;
  duration: string;
  description?: string;
}

interface KnowledgeFaq {
  q?: string;
  question?: string;
  a?: string;
  answer?: string;
  tags?: string[];
}

interface KnowledgeBase {
  company: {
    name: string;
    description: string;
    address?: string;
    phone?: string;
    email?: string;
    website?: string;
    instagram?: string;
    hours?: string | { weekdays?: string; saturday?: string; sunday?: string };
    payment_methods?: string[];
    cancellation_policy?: string;
  };
  services?: KnowledgeBaseService[];
  payment?: string[];
  faq?: KnowledgeFaq[];
  faqs?: KnowledgeFaq[];
}

export interface DetectedIntent {
  type: 'normal' | 'escalation' | 'scheduling';
  cleanResponse: string;
  schedulingData?: {
    name?: string;
    service?: string;
    date?: string;
    time?: string;
    notes?: string;
  };
  escalationReason?: string;
}

class AIService {
  private groq: Groq;
  // Cache per-tenant: slug → KnowledgeBase
  private kbCache: Map<string, KnowledgeBase> = new Map();

  constructor() {
    this.groq = new Groq({
      apiKey: config.GROQ_API_KEY,
    });
  }

  private loadKnowledgeBaseForTenant(tenant: TenantWithConfig): KnowledgeBase {
    const cached = this.kbCache.get(tenant.slug);
    if (cached) return cached;

    // Try tenant-specific KB first
    const tenantKbPath = path.join(config.TENANTS_DATA_PATH, tenant.slug, 'knowledge-base.json');
    if (fs.existsSync(tenantKbPath)) {
      try {
        const raw = fs.readFileSync(tenantKbPath, 'utf-8');
        const kb = JSON.parse(raw) as KnowledgeBase;
        this.kbCache.set(tenant.slug, kb);
        console.log(`[AI] Knowledge base loaded for tenant: ${tenant.slug}`);
        return kb;
      } catch (err) {
        console.error(`[AI] Failed to load KB for tenant ${tenant.slug}:`, err);
      }
    }

    // Fallback: legacy KB
    if (fs.existsSync(config.KNOWLEDGE_BASE_PATH)) {
      try {
        const raw = fs.readFileSync(config.KNOWLEDGE_BASE_PATH, 'utf-8');
        const kb = JSON.parse(raw) as KnowledgeBase;
        this.kbCache.set(tenant.slug, kb);
        console.log(`[AI] Using legacy knowledge base for tenant: ${tenant.slug}`);
        return kb;
      } catch (err) {
        console.error('[AI] Failed to load legacy knowledge base:', err);
      }
    }

    // Minimal fallback
    const fallback: KnowledgeBase = {
      company: {
        name: tenant.name,
        description: 'Serviços profissionais',
      },
      services: [],
      faq: [],
    };
    this.kbCache.set(tenant.slug, fallback);
    return fallback;
  }

  private buildSystemPrompt(tenant: TenantWithConfig): string {
    const kb = this.loadKnowledgeBaseForTenant(tenant);
    const tc = tenant.config;

    // Normalize services
    const services = kb.services || [];
    const servicesText = services
      .map((s) => `  • ${s.name}: ${s.description || ''} | Preço: ${s.price} | Duração: ${s.duration}`)
      .join('\n');

    // Normalize faqs
    const faqs: KnowledgeFaq[] = kb.faq || kb.faqs || [];
    const faqsText = faqs
      .map((f) => `  P: ${f.q || f.question || ''}\n  R: ${f.a || f.answer || ''}`)
      .join('\n\n');

    // Payment methods
    const paymentMethods = (kb.payment || kb.company.payment_methods || []).join(', ');

    // Hours
    let hoursText = '';
    if (typeof kb.company.hours === 'string') {
      hoursText = kb.company.hours;
    } else if (kb.company.hours) {
      const h = kb.company.hours;
      const parts: string[] = [];
      if (h.weekdays) parts.push(h.weekdays);
      if (h.saturday) parts.push(h.saturday);
      if (h.sunday) parts.push(h.sunday);
      hoursText = parts.map((p) => `- ${p}`).join('\n');
    }

    const cancellationPolicy = tc.cancellation_policy || kb.company.cancellation_policy || '';

    return `Você é o assistente virtual de atendimento da ${kb.company.name}.

## SOBRE A EMPRESA
${kb.company.description}
${kb.company.address ? `\n**Endereço:** ${kb.company.address}` : ''}${kb.company.phone ? `\n**Telefone:** ${kb.company.phone}` : ''}${kb.company.email ? `\n**E-mail:** ${kb.company.email}` : ''}${kb.company.website ? `\n**Site:** ${kb.company.website}` : ''}${kb.company.instagram ? `\n**Instagram:** ${kb.company.instagram}` : ''}

## HORÁRIOS DE FUNCIONAMENTO
${hoursText || 'Consulte nossos horários pelo WhatsApp.'}

## SERVIÇOS OFERECIDOS
${servicesText || '  (Consulte os serviços disponíveis com nossa equipe)'}

## FORMAS DE PAGAMENTO
${paymentMethods || 'Consulte formas de pagamento.'}

## POLÍTICA DE CANCELAMENTO
${cancellationPolicy || 'Cancelamentos devem ser feitos com antecedência.'}

## PERGUNTAS FREQUENTES
${faqsText || '  (Nenhuma FAQ configurada)'}

---

## INSTRUÇÕES DE COMPORTAMENTO

1. **Idioma**: Sempre responda em Português do Brasil. Seja cordial, profissional e objetivo.

2. **Saudação inicial**: Na primeira mensagem, apresente-se brevemente como assistente virtual e pergunte como pode ajudar.

3. **Conhecimento**: Use apenas as informações acima para responder. Se não souber algo, diga honestamente e ofereça ajuda alternativa.

4. **Agendamentos**: Quando o cliente quiser agendar um serviço, guie-o pelo processo de coleta de informações. Após ter TODOS os dados (nome completo, serviço desejado, data preferida, horário preferido), inclua exatamente este bloco no final da resposta:
   AGENDAR_SERVICO:{"name":"<nome>","service":"<servico>","date":"<data DD/MM/AAAA>","time":"<horario HH:MM>","notes":"<observacoes ou vazio>"}

5. **Escalação para humano**: Se o cliente:
   - Estiver frustrado ou com reclamação grave
   - Pedir explicitamente para falar com atendente humano
   - Tiver problema complexo que você não consegue resolver
   - Insistir em algo que não está nos seus dados

   Então diga que vai transferir para um atendente e inclua exatamente no final da resposta:
   ESCALAR_HUMANO:<motivo resumido em uma linha>

6. **Tom**: Empático, paciente e prestativo. Use emojis com moderação (1-2 por mensagem).

7. **Limitações de mensagem**: Respostas curtas e diretas. Máximo de 3-4 parágrafos.

8. **Não invente**: Nunca invente preços, horários ou informações não presentes acima. Se não sabe, diga que vai verificar e ofereça o contato direto.`;
  }

  async chat(
    history: Array<{ role: 'user' | 'assistant'; content: string }>,
    userMessage: string,
    tenant: TenantWithConfig
  ): Promise<string> {
    const systemPrompt = this.buildSystemPrompt(tenant);

    const messages: Groq.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
      ...history.map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })),
      { role: 'user', content: userMessage },
    ];

    const completion = await this.groq.chat.completions.create({
      model: config.AI_MODEL,
      messages,
      max_tokens: config.AI_MAX_TOKENS,
      temperature: config.AI_TEMPERATURE,
    });

    const response = completion.choices[0]?.message?.content || '';
    return response.trim();
  }

  detectIntent(response: string): DetectedIntent {
    // Check for scheduling trigger
    const schedulingMatch = response.match(/AGENDAR_SERVICO:(\{.+\})/s);
    if (schedulingMatch) {
      try {
        const schedulingData = JSON.parse(schedulingMatch[1]) as DetectedIntent['schedulingData'];
        const cleanResponse = response
          .replace(/AGENDAR_SERVICO:\{.+\}/s, '')
          .trim();
        return {
          type: 'scheduling',
          cleanResponse,
          schedulingData,
        };
      } catch {
        console.warn('[AI] Failed to parse scheduling data from response');
      }
    }

    // Check for escalation trigger
    const escalationMatch = response.match(/ESCALAR_HUMANO:(.+?)(\n|$)/);
    if (escalationMatch) {
      const reason = escalationMatch[1].trim();
      const cleanResponse = response
        .replace(/ESCALAR_HUMANO:.+?(\n|$)/, '')
        .trim();
      return {
        type: 'escalation',
        cleanResponse,
        escalationReason: reason,
      };
    }

    return {
      type: 'normal',
      cleanResponse: response,
    };
  }

  reloadKnowledgeBase(tenantSlug?: string): void {
    if (tenantSlug) {
      this.kbCache.delete(tenantSlug);
    } else {
      this.kbCache.clear();
    }
  }
}

export const aiService = new AIService();
