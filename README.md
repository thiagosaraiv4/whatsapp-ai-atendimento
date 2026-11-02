# WhatsApp AI – Automação de Atendimento

Sistema completo de atendimento ao cliente via WhatsApp com IA (Groq/Llama 3.3), dashboard web, agendamento de serviços e escalonamento para humanos.

O agente usa **RAG** (busca só os trechos relevantes da base), **tool calling** (`agendar_servico`, `escalar_humano`) e tem um **conjunto de avaliação** que mede a porcentagem de acerto. Detalhes em [Arquitetura de IA](#arquitetura-de-ia).

## Stack

| Camada | Tecnologia |
|---|---|
| Servidor HTTP | Fastify (Node.js + TypeScript) |
| IA | Groq SDK — Llama 3.3 70B (gratuito), com RAG (BM25) e tool calling |
| WhatsApp | Evolution API |
| Banco de dados | SQLite (better-sqlite3) |
| Dashboard | HTML/JS/CSS puro (sem build) |

## Funcionalidades

- **Atendimento com IA**: Responde perguntas usando a base de conhecimento configurável (`data/knowledge-base.json`)
- **Escalonamento Humano**: Detecta frustração/reclamações e transfere para operador via WhatsApp
- **Agendamento de Serviços**: Fluxo guiado para coletar dados e salvar agendamentos no SQLite
- **Dashboard**: Painel web com conversas, histórico de mensagens, agendamentos e métricas

## Pré-requisitos

- Node.js 18+
- Evolution API rodando e acessível
- Conta Groq (gratuita): https://console.groq.com

## Instalação

```bash
# 1. Clone o repositório
git clone <repo-url>
cd whatsapp-ai-atendimento

# 2. Instale as dependências
npm install

# 3. Configure as variáveis de ambiente
cp .env.example .env
# Edite o .env com suas credenciais

# 4. Compile
npm run build

# 5. Inicie
npm start
```

## Configuração

Edite o arquivo `.env`:

```env
EVOLUTION_API_URL=http://localhost:8080
EVOLUTION_API_KEY=sua-chave-aqui
EVOLUTION_INSTANCE=nome-da-instancia

GROQ_API_KEY=sua-chave-groq

COMPANY_NAME=Minha Empresa
OPERATOR_PHONE=5511999999999   # número do operador (com DDI)

PORT=3000
DATABASE_PATH=./data/atendimento.db
```

## Base de Conhecimento

Edite `data/knowledge-base.json` para personalizar:
- Informações da empresa (nome, endereço, horários)
- Serviços oferecidos com preços
- FAQs

## Arquitetura de IA

```
mensagem ──► retriever (BM25) ──► top-k trechos ──► LLM + ferramentas ──► ação validada ──► aplicação executa
                ▲                                       │                   (zod)
       base de conhecimento                 agendar_servico / escalar_humano
       quebrada em chunks                   ou resposta em texto
```

O código fica em `src/ai/` e não depende de `config`, para o mesmo agente rodar na aplicação e nos evals.

### 1. RAG (`src/ai/knowledge-base.ts`, `src/ai/retriever.ts`)

Antes, a base de conhecimento inteira ia no system prompt. Isso não escala: o prompt cresce com a base,
o custo por mensagem sobe e o modelo se perde com informação irrelevante.

Agora:
- **Chunking**: cada FAQ, cada serviço e cada informação institucional (horário, endereço, pagamento,
  cancelamento, contato) vira um trecho. Para FAQs curtas, isso é melhor que cortar por tamanho fixo,
  porque cada pergunta já é uma unidade completa.
- **Busca**: BM25 com normalização de acentos, stopwords e um stemmer leve de português
  (`agendar` e `agendamento` viram o mesmo termo). Cada trecho tem um `searchText` com sinônimos que o
  cliente usa mas que não aparecem no texto ("onde fica", "quanto custa").
- **Follow-ups**: a consulta junta a mensagem atual com a mensagem anterior do cliente, para resolver
  "e quanto custa?" logo depois de "vocês fazem barba?".
- **Corte por relevância**: só entram no prompt até `k=4` trechos, e só os que têm score próximo do melhor.
  Sem trecho relevante, o prompt diz isso explicitamente e o modelo é instruído a não inventar.

**Por que BM25 e não embeddings?** O Groq não tem endpoint de embeddings; BM25 roda local, sem custo,
sem latência de rede e é determinístico. Para bases pequenas de FAQ, busca lexical com sinônimos cobre
a maior parte dos casos. A interface `Retriever` permite trocar por embeddings ou busca híbrida
(BM25 + vetorial, combinadas com Reciprocal Rank Fusion) sem mexer no agente.

### 2. Tool calling (`src/ai/tools.ts`, `src/ai/agent.ts`)

Antes, o modelo escrevia marcadores de texto (`ESCALAR_HUMANO:motivo`, `AGENDAR_SERVICO:{json}`) e a aplicação
fazia regex na resposta. Isso quebrava quando o modelo errava o formato, gerava JSON inválido ou o marcador
vazava para o cliente.

Agora o modelo recebe duas ferramentas com JSON Schema:

| Ferramenta | Quando | Argumentos |
|---|---|---|
| `agendar_servico` | Cliente quer marcar horário | `name`, `service`, `date` (DD/MM/AAAA), `time` (HH:MM), `notes` — todos opcionais; o sistema coleta o que faltar |
| `escalar_humano` | Pediu uma pessoa, está frustrado, ou o problema não está na base | `motivo` |

- Os argumentos são validados com **zod** campo a campo: um campo inválido (ex.: `date: "amanhã"`) é descartado
  sozinho e o fluxo de coleta pergunta de novo.
- A resposta vira uma `AgentAction` tipada (`reply | schedule | escalate`). Se vierem duas chamadas,
  escalação tem prioridade.
- Mesmo com todos os dados, o agendamento passa pela confirmação **SIM/NÃO** antes de ser gravado.
- `agendar_servico` só é oferecida se o tenant tiver `scheduling_enabled`.
- Se o Groq devolver `tool_use_failed` (chamada malformada pelo modelo), o agente tenta de novo com
  `tool_choice: "none"` para o cliente não ficar sem resposta.

As ferramentas são "terminais": a aplicação executa a ação e responde com mensagens próprias, então não há
uma segunda chamada ao LLM com o resultado da ferramenta.

### 3. Avaliação (`evals/`)

`evals/dataset.json` tem **44 mensagens** da Barbearia Castilho com a intenção esperada
(24 `reply`, 10 `schedule`, 10 `escalate`), incluindo follow-ups com histórico, perguntas fora da base e casos
ambíguos. As mensagens de dúvida também trazem os trechos que deveriam ser recuperados.

**Eval de retrieval** — offline, sem chave de API:

```bash
npm run eval:retrieval
```

Mede Hit@k, Recall@k, MRR e o tamanho do prompt com RAG vs. com a base inteira. Resultado atual:

| Métrica | Valor |
|---|---|
| Hit@4 | 100% (21/21) |
| Recall@4 | 97,6% |
| MRR | 0,976 |
| Tamanho do prompt | 42,5% menor que com a base inteira |

A base da barbearia tem só 15 trechos, então esses números são um teste de sanidade; o ganho do RAG
aparece de verdade quando a base cresce.

**Eval de intenção** — ponta a ponta, chama o modelo:

```bash
GROQ_API_KEY=... npm run eval
npm run eval -- --model llama-3.1-8b-instant --limit 10 --min-accuracy 0.85
```

Roda cada mensagem pelo mesmo agente de produção (mesmo modelo, temperatura e top-k, definidos em
`DEFAULT_AGENT_OPTIONS`) e reporta acurácia, precisão/recall/F1 por classe, matriz de confusão,
latência p50/p95, tokens e a lista de erros. O resultado completo é salvo em `evals/results/` para comparar
versões de prompt e de modelo. `--min-accuracy` faz o comando falhar abaixo do limite, para usar em CI.

Precisão/recall por classe importam mais que a acurácia: deixar de escalar um cliente irritado
(falso negativo de `escalate`) é bem pior do que oferecer agendamento para quem só perguntou o preço.

**Testes unitários** (retriever, validação das tool calls e o agente com um cliente Groq falso):

```bash
npm test
```

### Próximos passos

- Busca híbrida (BM25 + embeddings) quando a base passar de algumas dezenas de trechos.
- LLM-as-judge para avaliar a qualidade do texto das respostas (fidelidade à base), não só a intenção.
- Rodar `npm run eval:retrieval` e `npm test` no CI a cada PR.

## Configuração do Webhook (Evolution API)

No painel da Evolution API, configure o webhook da instância:

```
URL: http://seu-servidor:3000/webhook/messages-upsert
Eventos: messages.upsert
```

## Dashboard

Acesse em `http://localhost:3000` após iniciar o servidor.

| Seção | Descrição |
|---|---|
| Conversas | Lista todas as conversas com status e histórico de mensagens |
| Agendamentos | Gerencia agendamentos (confirmar, cancelar) |
| Métricas | Totais de conversas, mensagens e agendamentos |

## Docker

```bash
# Configure o .env e execute
docker compose up -d
```

## Desenvolvimento

```bash
npm run dev              # modo watch com tsx
npm test                 # testes unitários do agente
npm run eval:retrieval   # avaliação do RAG (offline)
npm run eval             # avaliação de intenção (precisa de GROQ_API_KEY)
```

## Estrutura

```
├── src/
│   ├── config.ts                 # Configuração via env vars
│   ├── database.ts               # SQLite + queries
│   ├── ai/
│   │   ├── knowledge-base.ts     # Tipos da base + chunking
│   │   ├── retriever.ts          # BM25 (RAG)
│   │   ├── tools.ts              # Ferramentas + validação das tool calls
│   │   └── agent.ts              # Agente: retrieval + prompt + LLM
│   ├── modules/
│   │   ├── ai-full.ts            # Fluxo com IA + agendamento
│   │   └── collect-forward.ts    # Fluxo de coleta e encaminhamento
│   ├── services/
│   │   ├── ai.ts                 # Adaptador tenant → agente (cache do índice)
│   │   ├── whatsapp.ts           # Cliente Evolution API
│   │   └── conversation.ts       # Máquina de estados da conversa
│   ├── handlers/
│   │   ├── webhook.ts            # Rota do webhook Evolution API
│   │   └── pipeline.ts           # Pipeline de processamento
│   └── dashboard/
│       ├── routes.ts             # API REST do dashboard
│       └── static/               # Dashboard (HTML/JS/CSS)
├── data/
│   ├── knowledge-base.json       # Base legada (fallback)
│   └── tenants/<slug>/knowledge-base.json
├── evals/
│   ├── dataset.json              # 44 mensagens com intenção esperada
│   ├── run-retrieval.ts          # Eval do RAG (offline)
│   └── run-intent.ts             # Eval ponta a ponta (acurácia, F1, matriz de confusão)
├── tests/                        # Testes unitários (node:test)
└── index.ts                      # Entry point
```

## Licença

MIT
