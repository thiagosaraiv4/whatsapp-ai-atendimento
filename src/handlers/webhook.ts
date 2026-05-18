import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { processPipeline, IncomingMessage } from './pipeline';

/**
 * Evolution API webhook event structure (messages-upsert)
 */
interface EvolutionWebhookBody {
  event: string;
  instance: string;
  data?: {
    key?: {
      remoteJid?: string;
      fromMe?: boolean;
      id?: string;
    };
    pushName?: string;
    message?: {
      conversation?: string;
      extendedTextMessage?: {
        text?: string;
      };
      imageMessage?: {
        caption?: string;
      };
      videoMessage?: {
        caption?: string;
      };
      documentMessage?: {
        caption?: string;
      };
      audioMessage?: Record<string, unknown>;
      stickerMessage?: Record<string, unknown>;
      listResponseMessage?: {
        singleSelectReply?: {
          selectedRowId?: string;
        };
      };
      buttonsResponseMessage?: {
        selectedButtonId?: string;
        selectedDisplayText?: string;
      };
      templateButtonReplyMessage?: {
        selectedId?: string;
        selectedDisplayText?: string;
      };
    };
    messageType?: string;
    messageTimestamp?: number;
  };
}

/**
 * Extracts the text content from a webhook message, handling multiple message types.
 */
function extractMessageText(data: NonNullable<EvolutionWebhookBody['data']>): string | null {
  const msg = data.message;
  if (!msg) return null;

  // Plain text
  if (msg.conversation) return msg.conversation;

  // Extended text (links, etc.)
  if (msg.extendedTextMessage?.text) return msg.extendedTextMessage.text;

  // Image/video/document captions
  if (msg.imageMessage?.caption) return msg.imageMessage.caption;
  if (msg.videoMessage?.caption) return msg.videoMessage.caption;
  if (msg.documentMessage?.caption) return msg.documentMessage.caption;

  // List response
  if (msg.listResponseMessage?.singleSelectReply?.selectedRowId) {
    return msg.listResponseMessage.singleSelectReply.selectedRowId;
  }

  // Button response
  if (msg.buttonsResponseMessage?.selectedDisplayText) {
    return msg.buttonsResponseMessage.selectedDisplayText;
  }
  if (msg.buttonsResponseMessage?.selectedButtonId) {
    return msg.buttonsResponseMessage.selectedButtonId;
  }

  // Template button reply
  if (msg.templateButtonReplyMessage?.selectedDisplayText) {
    return msg.templateButtonReplyMessage.selectedDisplayText;
  }

  // Audio and sticker — acknowledge but cannot process
  if (msg.audioMessage) return '[Áudio recebido — por favor, envie uma mensagem de texto]';
  if (msg.stickerMessage) return null; // silently ignore stickers

  return null;
}

export async function webhookRoutes(
  fastify: FastifyInstance,
  _options: FastifyPluginOptions
): Promise<void> {
  /**
   * Evolution API sends webhook events to this endpoint.
   * Configure in Evolution API: Webhook URL = http://your-server/webhook/messages-upsert
   */
  fastify.post<{ Body: EvolutionWebhookBody }>(
    '/messages-upsert',
    {
      schema: {
        body: {
          type: 'object',
          properties: {
            event: { type: 'string' },
            instance: { type: 'string' },
            data: { type: 'object' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
            },
          },
        },
      },
      config: { rawBody: true },
    },
    async (request, reply) => {
      const body = request.body;

      // Log event type for debugging
      console.log(`[Webhook] Received event: ${body.event} from instance: ${body.instance}`);

      // Only process message events
      if (body.event !== 'messages.upsert' || !body.data) {
        return reply.code(200).send({ success: true });
      }

      const data = body.data;
      const key = data.key;

      if (!key?.remoteJid) {
        console.warn('[Webhook] Missing remoteJid in webhook data');
        return reply.code(200).send({ success: true });
      }

      const remoteJid = key.remoteJid;
      const fromMe = key.fromMe === true;

      // Determine if group message (group JIDs end with @g.us)
      const isGroup = remoteJid.endsWith('@g.us');

      // Extract plain phone from JID
      const phone = remoteJid.split('@')[0];

      // Extract message text
      const text = extractMessageText(data);

      if (!text) {
        console.log(`[Webhook] No processable text in message from ${phone}, type: ${data.messageType}`);
        return reply.code(200).send({ success: true });
      }

      const incoming: IncomingMessage = {
        phone,
        text,
        messageId: key.id,
        fromMe,
        isGroup,
        pushName: data.pushName,
      };

      // Process asynchronously — respond to Evolution API immediately (200 OK)
      setImmediate(() => {
        processPipeline(incoming).catch((err) => {
          console.error('[Webhook] Pipeline error:', err);
        });
      });

      return reply.code(200).send({ success: true });
    }
  );

  /**
   * Health check endpoint
   */
  fastify.get('/status', async (_request, reply) => {
    return reply.code(200).send({
      status: 'ok',
      timestamp: new Date().toISOString(),
      service: 'whatsapp-ai-atendimento',
    });
  });

  /**
   * Generic catch-all for other Evolution API event types
   */
  fastify.post<{ Body: EvolutionWebhookBody }>(
    '/',
    async (request, reply) => {
      const body = request.body as unknown as EvolutionWebhookBody;
      console.log(`[Webhook] Received generic event: ${body?.event || 'unknown'}`);
      return reply.code(200).send({ success: true });
    }
  );
}
