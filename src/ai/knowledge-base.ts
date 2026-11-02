/**
 * knowledge-base.ts
 * Tipos da base de conhecimento + carregamento + chunking.
 *
 * Este módulo é "puro": não importa `config` nem fala com a rede, para poder ser
 * usado tanto pela aplicação quanto pelo script de avaliação (evals/).
 */

import fs from 'fs';

export interface KnowledgeBaseService {
  name: string;
  price: string;
  duration: string;
  description?: string;
}

export interface KnowledgeFaq {
  q?: string;
  question?: string;
  a?: string;
  answer?: string;
  tags?: string[];
}

export interface KnowledgeBase {
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

/**
 * Um trecho recuperável da base.
 * - `text`: o que vai para o prompt do LLM.
 * - `searchText`: o que é indexado pelo retriever. Inclui `text` + palavras-chave/sinônimos
 *   que o cliente usaria ("onde fica", "quanto custa") mas que não aparecem no texto.
 */
export interface Chunk {
  id: string;
  kind: 'faq' | 'service' | 'info';
  text: string;
  searchText: string;
}

export function readKnowledgeBase(filePath: string): KnowledgeBase {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as KnowledgeBase;
}

export function slugify(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function formatHours(hours: KnowledgeBase['company']['hours']): string {
  if (!hours) return '';
  if (typeof hours === 'string') return hours;
  return [hours.weekdays, hours.saturday, hours.sunday].filter(Boolean).join(' | ');
}

/**
 * Quebra a base em trechos pequenos e independentes.
 * Granularidade: 1 FAQ = 1 chunk, 1 serviço = 1 chunk, 1 informação institucional = 1 chunk.
 * Para FAQs curtas isso é melhor do que chunking por tamanho fixo, porque cada pergunta
 * já é uma unidade semântica completa.
 */
export function chunkKnowledgeBase(kb: KnowledgeBase, cancellationOverride?: string): Chunk[] {
  const chunks: Chunk[] = [];
  const c = kb.company;

  const info = (id: string, text: string, keywords: string) => {
    chunks.push({ id: `info:${id}`, kind: 'info', text, searchText: `${text} ${keywords}` });
  };

  const hours = formatHours(c.hours);
  if (hours) {
    info('horario', `Horário de funcionamento: ${hours}`, 'horario hora abre fecha aberto funciona funcionamento dia dias domingo sabado feriado que horas');
  }
  if (c.address) {
    info('endereco', `Endereço: ${c.address}`, 'endereco onde fica localizacao local como chegar rua localizado');
  }
  const contacts = [
    c.phone && `Telefone: ${c.phone}`,
    c.email && `E-mail: ${c.email}`,
    c.website && `Site: ${c.website}`,
    c.instagram && `Instagram: ${c.instagram}`,
  ].filter(Boolean);
  if (contacts.length) {
    info('contato', `Contato: ${contacts.join(' | ')}`, 'contato telefone email instagram insta site rede social redes ligar perfil');
  }
  const payment = kb.payment || c.payment_methods || [];
  if (payment.length) {
    info('pagamento', `Formas de pagamento: ${payment.join(', ')}`, 'pagamento pagar paga aceita aceitam forma pix cartao credito debito dinheiro parcelar parcela');
  }
  const cancellation = cancellationOverride || c.cancellation_policy;
  if (cancellation) {
    info('cancelamento', `Política de cancelamento: ${cancellation}`, 'cancelar cancelamento desmarcar remarcar reagendar antecedencia');
  }

  for (const s of kb.services || []) {
    const text = `Serviço: ${s.name}${s.description ? ` — ${s.description}` : ''} | Preço: ${s.price} | Duração: ${s.duration}`;
    chunks.push({
      id: `service:${slugify(s.name)}`,
      kind: 'service',
      text,
      searchText: `${text} servico preco valor quanto custa custo tempo demora duracao`,
    });
  }

  (kb.faq || kb.faqs || []).forEach((f, i) => {
    const q = f.q || f.question || '';
    const a = f.a || f.answer || '';
    const text = `P: ${q}\nR: ${a}`;
    chunks.push({ id: `faq:${i + 1}`, kind: 'faq', text, searchText: `${q} ${q} ${a} ${(f.tags || []).join(' ')}` });
  });

  return chunks;
}
