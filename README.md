# WhatsApp AI – Automação de Atendimento

Sistema completo de atendimento ao cliente via WhatsApp com IA (Groq/Llama 3.1), dashboard web, agendamento de serviços e escalonamento para humanos.

## Stack

| Camada | Tecnologia |
|---|---|
| Servidor HTTP | Fastify (Node.js + TypeScript) |
| IA | Groq SDK — Llama 3.1 70B (gratuito) |
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
npm run dev   # modo watch com tsx
```

## Estrutura

```
├── src/
│   ├── config.ts                 # Configuração via env vars
│   ├── database.ts               # SQLite + queries
│   ├── services/
│   │   ├── ai.ts                 # Groq AI + detecção de intents
│   │   ├── whatsapp.ts           # Cliente Evolution API
│   │   └── conversation.ts       # Máquina de estados da conversa
│   ├── handlers/
│   │   ├── webhook.ts            # Rota do webhook Evolution API
│   │   └── pipeline.ts           # Pipeline de processamento
│   └── dashboard/
│       ├── routes.ts             # API REST do dashboard
│       └── static/               # Dashboard (HTML/JS/CSS)
├── data/
│   └── knowledge-base.json       # Base de conhecimento configurável
└── index.ts                      # Entry point
```

## Licença

MIT
