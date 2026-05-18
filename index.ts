import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import staticPlugin from '@fastify/static';
import path from 'path';
import { setupDatabase } from './src/database';
import { webhookRoutes } from './src/handlers/webhook';
import { dashboardRoutes } from './src/dashboard/routes';
import { config } from './src/config';

const app = Fastify({
  logger: {
    level: config.NODE_ENV === 'production' ? 'info' : 'debug',
    transport:
      config.NODE_ENV !== 'production'
        ? { target: 'pino-pretty', options: { colorize: true } }
        : undefined,
  },
});

async function main(): Promise<void> {
  // 1. Initialize database
  setupDatabase();

  // 2. Register CORS
  await app.register(cors, {
    origin: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  // 3. Serve static dashboard files
  await app.register(staticPlugin, {
    root: path.join(__dirname, 'src/dashboard/static'),
    prefix: '/',
    decorateReply: false,
  });

  // 4. Register webhook routes (Evolution API)
  await app.register(webhookRoutes, { prefix: '/webhook' });

  // 5. Register dashboard REST API
  await app.register(dashboardRoutes, { prefix: '/api' });

  // 6. Root route — serve dashboard
  app.get('/', async (_req, reply) => {
    return reply.sendFile('index.html');
  });

  // 7. 404 handler
  app.setNotFoundHandler(async (req, reply) => {
    if (req.url.startsWith('/api') || req.url.startsWith('/webhook')) {
      return reply.code(404).send({ success: false, error: 'Route not found' });
    }
    // For all other routes, serve the SPA
    return reply.sendFile('index.html');
  });

  // 8. Global error handler
  app.setErrorHandler(async (err, _req, reply) => {
    app.log.error(err);
    return reply.code(err.statusCode || 500).send({
      success: false,
      error: err.message || 'Internal server error',
    });
  });

  // 9. Start server
  try {
    await app.listen({ port: config.PORT, host: '0.0.0.0' });
    console.log(`\n✅ Servidor rodando em http://0.0.0.0:${config.PORT}`);
    console.log(`   Dashboard: http://localhost:${config.PORT}`);
    console.log(`   Webhook:   http://localhost:${config.PORT}/webhook/messages-upsert`);
    console.log(`   API:       http://localhost:${config.PORT}/api/health\n`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n[Server] Received SIGINT, shutting down gracefully...');
  await app.close();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n[Server] Received SIGTERM, shutting down gracefully...');
  await app.close();
  process.exit(0);
});

main().catch((err) => {
  console.error('[Server] Fatal error:', err);
  process.exit(1);
});
