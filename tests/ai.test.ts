import { test } from 'node:test';
import assert from 'node:assert/strict';
import type Groq from 'groq-sdk';
import { KnowledgeIndex, SupportAgent, buildSystemPrompt } from '../src/ai/agent';
import { KnowledgeBase } from '../src/ai/knowledge-base';
import { tokenize } from '../src/ai/retriever';
import { toAction } from '../src/ai/tools';

const kb: KnowledgeBase = {
  company: { name: 'Barbearia Teste', description: 'Barbearia', hours: 'Seg a Sáb 9h-19h', instagram: '@teste' },
  services: [
    { name: 'Corte', price: 'R$ 45', duration: '45 min' },
    { name: 'Barba', price: 'R$ 35', duration: '30 min' },
  ],
  payment: ['Pix', 'Cartão'],
  faq: [
    { q: 'Vocês atendem criança?', a: 'Sim, a partir de 3 anos.' },
    { q: 'Posso cancelar?', a: 'Sim, com 2 horas de antecedência.' },
  ],
};
const index = new KnowledgeIndex({ name: 'Barbearia Teste', kb, schedulingEnabled: true });

// ─── Retrieval ───────────────────────────────────────────────────────────────

test('tokenize normaliza acentos e reduz variações da mesma palavra', () => {
  assert.deepEqual(tokenize('agendar'), tokenize('agendamento'));
  assert.deepEqual(tokenize('cancelar'), tokenize('cancelamento'));
  assert.deepEqual(tokenize('Crianças'), tokenize('criança'));
});

test('recupera o trecho certo e não manda a base inteira', () => {
  const ids = index.retrieve([], 'meu filho é criança, vocês atendem?').map((r) => r.chunk.id);
  assert.equal(ids[0], 'faq:1');
  assert.ok(ids.length < index.chunks.length);
});

test('usa a mensagem anterior do cliente para resolver follow-ups', () => {
  const history = [
    { role: 'user' as const, content: 'Vocês fazem barba?' },
    { role: 'assistant' as const, content: 'Sim!' },
  ];
  assert.equal(index.retrieve(history, 'e quanto custa?')[0].chunk.id, 'service:barba');
});

test('mensagem sem conteúdo informativo não recupera nada', () => {
  assert.deepEqual(index.retrieve([], 'oi, bom dia'), []);
  assert.match(buildSystemPrompt(index.profile, []), /nenhum trecho relevante/);
});

// ─── Tool calls → ação ───────────────────────────────────────────────────────

const call = (name: string, args: unknown) => ({ function: { name, arguments: JSON.stringify(args) } });

test('sem tool call vira resposta em texto', () => {
  assert.deepEqual(toAction(' Olá! ', undefined), { type: 'reply', text: 'Olá!' });
});

test('agendar_servico valida campos e descarta só os inválidos', () => {
  const action = toAction('', [call('agendar_servico', { service: 'Corte', date: 'amanhã', time: '14:00', name: '' })]);
  assert.deepEqual(action, { type: 'schedule', text: '', data: { service: 'Corte', time: '14:00' } });
});

test('argumentos JSON inválidos não derrubam o fluxo', () => {
  const action = toAction('', [{ function: { name: 'agendar_servico', arguments: '{nome: ' } }]);
  assert.deepEqual(action, { type: 'schedule', text: '', data: {} });
});

test('escalação tem prioridade sobre agendamento', () => {
  const action = toAction('Vou te transferir.', [
    call('agendar_servico', { service: 'Corte' }),
    call('escalar_humano', { motivo: 'Cliente irritado' }),
  ]);
  assert.deepEqual(action, { type: 'escalate', text: 'Vou te transferir.', reason: 'Cliente irritado' });
});

// ─── Agente com cliente Groq falso ───────────────────────────────────────────

function fakeClient(handler: (req: Record<string, unknown>) => unknown) {
  const requests: Record<string, unknown>[] = [];
  const client = {
    chat: {
      completions: {
        create: async (req: Record<string, unknown>) => {
          requests.push(req);
          return handler(req);
        },
      },
    },
  } as unknown as Groq;
  return { client, requests };
}

test('agente envia as ferramentas e só os trechos recuperados', async () => {
  const { client, requests } = fakeClient(() => ({
    choices: [{ message: { content: null, tool_calls: [call('escalar_humano', { motivo: 'Pediu atendente' })] } }],
  }));
  const result = await new SupportAgent(client).respond(index, [], 'quero falar com um atendente');

  assert.equal(result.action.type, 'escalate');
  const req = requests[0] as { tools: { function: { name: string } }[]; messages: { content: string }[] };
  assert.deepEqual(req.tools.map((t) => t.function.name), ['agendar_servico', 'escalar_humano']);
  assert.doesNotMatch(req.messages[0].content, /R\$ 45/); // preço do corte não é relevante aqui
});

test('sem agendamento habilitado, a ferramenta agendar_servico não é oferecida', async () => {
  const noScheduling = new KnowledgeIndex({ name: 'X', kb, schedulingEnabled: false });
  const { client, requests } = fakeClient(() => ({ choices: [{ message: { content: 'ok' } }] }));
  await new SupportAgent(client).respond(noScheduling, [], 'oi');
  const req = requests[0] as { tools: { function: { name: string } }[] };
  assert.deepEqual(req.tools.map((t) => t.function.name), ['escalar_humano']);
});

test('tool_use_failed do Groq cai para resposta em texto em vez de erro', async () => {
  const { client, requests } = fakeClient((req) => {
    if (req.tool_choice === 'auto') {
      throw Object.assign(new Error('400 tool_use_failed'), { status: 400 });
    }
    return { choices: [{ message: { content: 'Posso ajudar com outra coisa?' } }] };
  });
  const result = await new SupportAgent(client).respond(index, [], 'oi');
  assert.deepEqual(result.action, { type: 'reply', text: 'Posso ajudar com outra coisa?' });
  assert.equal(requests.length, 2);
});
