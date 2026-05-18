import dotenv from 'dotenv';
import { z } from 'zod';
import path from 'path';

dotenv.config();

const configSchema = z.object({
  EVOLUTION_API_URL: z.string().url().default('http://localhost:8080'),
  EVOLUTION_API_KEY: z.string().min(1, 'EVOLUTION_API_KEY is required'),
  EVOLUTION_INSTANCE: z.string().min(1, 'EVOLUTION_INSTANCE is required').default('minha-empresa'),
  GROQ_API_KEY: z.string().min(1, 'GROQ_API_KEY is required'),
  COMPANY_NAME: z.string().default('Minha Empresa'),
  OPERATOR_PHONE: z.string().min(10, 'OPERATOR_PHONE is required').default('5511999999999'),
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
  DATABASE_PATH: z.string().default('./data/atendimento.db'),
});

const parsed = configSchema.safeParse(process.env);

if (!parsed.success) {
  const errors = parsed.error.errors.map((e) => `  ${e.path.join('.')}: ${e.message}`).join('\n');
  console.error(`\n[Config] Environment variable validation failed:\n${errors}\n`);
  process.exit(1);
}

export const config = {
  ...parsed.data,
  DATABASE_PATH: path.resolve(parsed.data.DATABASE_PATH),
  KNOWLEDGE_BASE_PATH: path.resolve('./data/knowledge-base.json'),
  STATIC_PATH: path.resolve('./src/dashboard/static'),
  MAX_HISTORY_MESSAGES: 10,
  AI_MODEL: 'llama-3.1-70b-versatile',
  AI_MAX_TOKENS: 1024,
  AI_TEMPERATURE: 0.7,
};

export type Config = typeof config;
