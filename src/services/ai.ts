import Groq from 'groq-sdk';
import fs from 'fs';
import { config } from '../config';

interface KnowledgeBaseEntry {
  question: string;
  answer: string;
  tags?: string[];
}

interface KnowledgeBase {
  company: {
    name: string;
    description: string;
    address: string;
    phone: string;
    email: string;
    website?: string;
    hours: {
      weekdays: string;
      saturday: string;
      sunday: string;
    };
    payment_methods: string[];
    cancellation_policy: string;
  };
  services: Array<{
    name: string;
    description: string;
    price: string;
    duration: string;
  }>;
  faqs: KnowledgeBaseEntry[];
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
  private knowledgeBase: KnowledgeBase | null = null;

  constructor() {
    this.groq = new Groq({
      apiKey: config.GROQ_API_KEY,
    });
  }

  private loadKnowledgeBase(): KnowledgeBase {
    if (this.knowledgeBase) return this.knowledgeBase;

    try {
      const raw = fs.readFileSync(config.KNOWLEDGE_BASE_PATH, 'utf-8');
      this.knowledgeBase = JSON.parse(raw) as KnowledgeBase;
      console.log('[AI] Knowledge base loaded successfully');
      return this.knowledgeBase;
    } catch (err) {
      console.error('[AI] Failed to load knowledge base:', err);
      // Return minimal fallback
      this.knowledgeBase = {
        company: {
          name: config.COMPANY_NAME,
          description: 'Empresa de serviços profissionais',
          address: 'Consulte pelo WhatsApp',
          phone: config.OPERATOR_PHONE,
          email: 'contato@empresa.com',
          hours: {
            weekdays: 'Segunda a Sexta: 8h às 18h',
            saturday: 'Sábado: 8h às 12h',
            sunday: 'Domingo: Fechado',
          },
          payment_methods: ['PIX', 'Cartão de Crédito', 'Cartão de Débito', 'Dinheiro'],
          cancellation_policy:
            'Cancelamentos devem ser feitos com pelo menos 24 horas de antecedência.',
        },
        services: [],
        faqs: [],
      };
      return this.knowledgeBase;
    }
  }

  private buildSystemPrompt(): string {
    const kb = this.loadKnowledgeBase();

    const servicesText = kb.services
      .map(
        (s) =>
          `  • ${s.name}: ${s.description} | Preço: ${s.price} | Duração: ${s.duration}`
      )
      .join('\n');

    const faqsText = kb.faqs
      .map((f) => `  P: ${f.question}\n  R: ${f.answer}`)
      .join('\n\n');

    const paymentMethods = kb.company.payment_methods.join(', ');

    return `Você é o assistente virtual de atendimento da ${kb.company.name}.

## SOBRE A EMPRESA
${kb.company.description}

**Endereço:** ${kb.company.address}
**Telefone:** ${kb.company.phone}
**E-mail:** ${kb.company.email}${kb.company.website ? `\n**Site:** ${kb.company.website}` : ''}

## HORÁRIOS DE FUNCIONAMENTO
- ${kb.company.hours.weekdays}
- ${kb.company.hours.saturday}
- ${kb.company.hours.sunday}

## SERVIÇOS OFERECIDOS
${servicesText || '  (Consulte os serviços disponíveis com nossa equipe)'}

## FORMAS DE PAGAMENTO
${paymentMethods}

## POLÍTICA DE CANCELAMENTO
${kb.company.cancellation_policy}

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
    userMessage: string
  ): Promise<string> {
    const systemPrompt = this.buildSystemPrompt();

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

  reloadKnowledgeBase(): void {
    this.knowledgeBase = null;
    this.loadKnowledgeBase();
  }
}

export const aiService = new AIService();
