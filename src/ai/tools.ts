/**
 * tools.ts
 * Ferramentas (function calling) que o LLM pode chamar, e a conversão das chamadas
 * em uma ação estruturada para a aplicação executar.
 *
 * Antes: o modelo escrevia marcadores de texto (`AGENDAR_SERVICO:{...}`, `ESCALAR_HUMANO:...`)
 * e a aplicação fazia regex na resposta. Isso quebra quando o modelo erra o formato,
 * vaza o marcador para o cliente ou gera JSON inválido.
 *
 * Agora: o modelo recebe um JSON Schema de cada ferramenta e devolve `tool_calls`
 * estruturados, que são validados com zod antes de virar ação.
 */

import { z } from 'zod';
import type Groq from 'groq-sdk';

export const TOOL_AGENDAR = 'agendar_servico';
export const TOOL_ESCALAR = 'escalar_humano';

export type ToolDefinition = Groq.Chat.ChatCompletionTool;

export const agendarTool: ToolDefinition = {
  type: 'function',
  function: {
    name: TOOL_AGENDAR,
    description:
      'Inicia ou conclui um agendamento quando o cliente quer marcar um horário. ' +
      'Chame assim que o cliente demonstrar intenção de agendar, preenchendo apenas os campos que ele já informou; ' +
      'o sistema coleta o que faltar. Não invente dados.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Nome completo do cliente' },
        service: { type: 'string', description: 'Serviço desejado, como aparece na lista de serviços' },
        date: { type: 'string', description: 'Data no formato DD/MM/AAAA' },
        time: { type: 'string', description: 'Horário no formato HH:MM (24h)' },
        notes: { type: 'string', description: 'Observações adicionais do cliente' },
      },
      required: [],
    },
  },
};

export const escalarTool: ToolDefinition = {
  type: 'function',
  function: {
    name: TOOL_ESCALAR,
    description:
      'Transfere a conversa para um atendente humano. Use quando o cliente pedir explicitamente uma pessoa, ' +
      'estiver frustrado ou fizer uma reclamação, ou tiver um problema que as informações disponíveis não resolvem ' +
      '(ex.: cobrança indevida, problema com um atendimento anterior, pedido fora do padrão).',
    parameters: {
      type: 'object',
      properties: {
        motivo: { type: 'string', description: 'Motivo da transferência, resumido em uma linha' },
      },
      required: ['motivo'],
    },
  },
};

export function getTools(opts: { schedulingEnabled: boolean }): ToolDefinition[] {
  return opts.schedulingEnabled ? [agendarTool, escalarTool] : [escalarTool];
}

// ─── Parsing / validação das chamadas ────────────────────────────────────────

// Modelos às vezes mandam string vazia ou "null" em campos opcionais: normaliza para undefined.
const optionalText = z
  .string()
  .nullish()
  .transform((v) => (v && v.trim() && v.trim().toLowerCase() !== 'null' ? v.trim() : undefined));

const agendarArgsSchema = z.object({
  name: optionalText,
  service: optionalText,
  date: optionalText.refine((v) => !v || /^\d{2}\/\d{2}\/\d{4}$/.test(v), 'date deve ser DD/MM/AAAA'),
  time: optionalText.refine((v) => !v || /^\d{1,2}:\d{2}$/.test(v), 'time deve ser HH:MM'),
  notes: optionalText,
});

const escalarArgsSchema = z.object({ motivo: optionalText });

const SCHEDULING_KEYS = ['name', 'service', 'date', 'time', 'notes'] as const;

export type SchedulingData = Partial<Record<(typeof SCHEDULING_KEYS)[number], string>>;

/** Ação decidida pelo agente para a aplicação executar. */
export type AgentAction =
  | { type: 'reply'; text: string }
  | { type: 'schedule'; text: string; data: SchedulingData }
  | { type: 'escalate'; text: string; reason: string };

export type IntentLabel = AgentAction['type'];

interface RawToolCall {
  function: { name: string; arguments: string };
}

function parseArgs(raw: string): unknown {
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

/**
 * Converte a resposta do modelo (texto + tool_calls) em uma única ação.
 * Se houver mais de uma chamada, escalação tem prioridade sobre agendamento
 * (cliente irritado não deve ser empurrado para um fluxo de agendamento).
 */
export function toAction(content: string | null | undefined, toolCalls: RawToolCall[] | undefined): AgentAction {
  const text = (content || '').trim();
  const calls = toolCalls || [];

  const escalate = calls.find((c) => c.function.name === TOOL_ESCALAR);
  if (escalate) {
    const parsed = escalarArgsSchema.safeParse(parseArgs(escalate.function.arguments));
    const reason = (parsed.success && parsed.data.motivo) || 'Solicitação de atendimento humano';
    return { type: 'escalate', text, reason };
  }

  const schedule = calls.find((c) => c.function.name === TOOL_AGENDAR);
  if (schedule) {
    const raw = (parseArgs(schedule.function.arguments) || {}) as Record<string, unknown>;
    // Valida campo a campo: um campo em formato inválido é descartado sozinho
    // e o fluxo de coleta pergunta de novo (validando a resposta do cliente).
    const data: SchedulingData = {};
    for (const key of SCHEDULING_KEYS) {
      const result = agendarArgsSchema.shape[key].safeParse(raw[key]);
      if (result.success && result.data) data[key] = result.data;
    }
    return { type: 'schedule', text, data };
  }

  return { type: 'reply', text };
}
