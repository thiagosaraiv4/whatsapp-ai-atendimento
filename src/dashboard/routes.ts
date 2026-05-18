import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import {
  listConversations,
  getConversationMessages,
  getConversationById,
  listAppointments,
  updateAppointmentStatus,
  updateConversationStatus,
  updateConversationState,
  getMetrics,
  escalateConversation,
  markEscalationNotified,
} from '../database';
import { whatsappService } from '../services/whatsapp';
import { config } from '../config';

export async function dashboardRoutes(
  fastify: FastifyInstance,
  _options: FastifyPluginOptions
): Promise<void> {
  /**
   * GET /api/conversations
   * Returns all conversations with last message and status.
   */
  fastify.get('/conversations', async (_request, reply) => {
    try {
      const conversations = listConversations();
      return reply.code(200).send({ success: true, data: conversations });
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({ success: false, error: 'Failed to list conversations' });
    }
  });

  /**
   * GET /api/conversations/:id/messages
   * Returns full message history for a conversation.
   */
  fastify.get<{ Params: { id: string } }>(
    '/conversations/:id/messages',
    async (request, reply) => {
      try {
        const id = parseInt(request.params.id, 10);
        if (isNaN(id)) {
          return reply.code(400).send({ success: false, error: 'Invalid conversation ID' });
        }

        const conversation = getConversationById(id);
        if (!conversation) {
          return reply.code(404).send({ success: false, error: 'Conversation not found' });
        }

        const messages = getConversationMessages(id);
        return reply.code(200).send({ success: true, data: { conversation, messages } });
      } catch (err) {
        fastify.log.error(err);
        return reply.code(500).send({ success: false, error: 'Failed to get messages' });
      }
    }
  );

  /**
   * GET /api/appointments
   * Returns all appointments, optionally filtered by status.
   */
  fastify.get<{ Querystring: { status?: string } }>(
    '/appointments',
    async (request, reply) => {
      try {
        const { status } = request.query;
        const appointments = listAppointments(status);
        return reply.code(200).send({ success: true, data: appointments });
      } catch (err) {
        fastify.log.error(err);
        return reply.code(500).send({ success: false, error: 'Failed to list appointments' });
      }
    }
  );

  /**
   * PUT /api/appointments/:id
   * Updates appointment status.
   */
  fastify.put<{
    Params: { id: string };
    Body: { status: 'pending' | 'confirmed' | 'cancelled' };
  }>('/appointments/:id', async (request, reply) => {
    try {
      const id = parseInt(request.params.id, 10);
      if (isNaN(id)) {
        return reply.code(400).send({ success: false, error: 'Invalid appointment ID' });
      }

      const { status } = request.body;
      if (!['pending', 'confirmed', 'cancelled'].includes(status)) {
        return reply
          .code(400)
          .send({ success: false, error: 'Invalid status. Use: pending, confirmed, cancelled' });
      }

      const updated = updateAppointmentStatus(id, status);
      if (!updated) {
        return reply.code(404).send({ success: false, error: 'Appointment not found' });
      }

      // Notify client if confirmed/cancelled
      try {
        if (status === 'confirmed') {
          await whatsappService.sendTextMessage(
            updated.phone,
            `✅ *Seu agendamento foi confirmado!*\n\n` +
              `📋 Serviço: ${updated.service}\n` +
              `📅 Data: ${updated.date}\n` +
              `🕐 Horário: ${updated.time}\n\n` +
              `Aguardamos você! 😊`
          );
        } else if (status === 'cancelled') {
          await whatsappService.sendTextMessage(
            updated.phone,
            `❌ *Seu agendamento foi cancelado.*\n\n` +
              `📋 Serviço: ${updated.service} — ${updated.date} às ${updated.time}\n\n` +
              `Se desejar reagendar, entre em contato conosco pelo WhatsApp.`
          );
        }
      } catch (notifyErr) {
        fastify.log.warn(`Failed to notify client about appointment status change: ${notifyErr}`);
      }

      return reply.code(200).send({ success: true, data: updated });
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({ success: false, error: 'Failed to update appointment' });
    }
  });

  /**
   * GET /api/metrics
   * Returns dashboard metrics.
   */
  fastify.get('/metrics', async (_request, reply) => {
    try {
      const metrics = getMetrics();
      return reply.code(200).send({ success: true, data: metrics });
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({ success: false, error: 'Failed to get metrics' });
    }
  });

  /**
   * POST /api/conversations/:id/close
   * Closes/resets a conversation.
   */
  fastify.post<{ Params: { id: string } }>(
    '/conversations/:id/close',
    async (request, reply) => {
      try {
        const id = parseInt(request.params.id, 10);
        if (isNaN(id)) {
          return reply.code(400).send({ success: false, error: 'Invalid conversation ID' });
        }

        const conversation = getConversationById(id);
        if (!conversation) {
          return reply.code(404).send({ success: false, error: 'Conversation not found' });
        }

        updateConversationStatus(id, 'closed');
        updateConversationState(id, 'CLOSED');

        return reply.code(200).send({ success: true, message: 'Conversation closed' });
      } catch (err) {
        fastify.log.error(err);
        return reply.code(500).send({ success: false, error: 'Failed to close conversation' });
      }
    }
  );

  /**
   * POST /api/conversations/:id/escalate
   * Manually escalates a conversation.
   */
  fastify.post<{
    Params: { id: string };
    Body: { reason?: string };
  }>('/conversations/:id/escalate', async (request, reply) => {
    try {
      const id = parseInt(request.params.id, 10);
      if (isNaN(id)) {
        return reply.code(400).send({ success: false, error: 'Invalid conversation ID' });
      }

      const conversation = getConversationById(id);
      if (!conversation) {
        return reply.code(404).send({ success: false, error: 'Conversation not found' });
      }

      if (conversation.status === 'escalated') {
        return reply
          .code(400)
          .send({ success: false, error: 'Conversation already escalated' });
      }

      const reason = request.body?.reason || 'Escalonamento manual pelo operador';
      const escalation = escalateConversation(id, reason);

      // Notify operator
      const operatorMsg =
        `🚨 *Atendimento Escalonado Manualmente*\n\n` +
        `📱 Cliente: ${conversation.phone}\n` +
        (conversation.name ? `👤 Nome: ${conversation.name}\n` : '') +
        `📝 Motivo: ${reason}`;

      try {
        await whatsappService.sendTextMessage(config.OPERATOR_PHONE, operatorMsg);
        markEscalationNotified(escalation.id);
      } catch (notifyErr) {
        fastify.log.warn(`Failed to notify operator: ${notifyErr}`);
      }

      // Inform client
      try {
        await whatsappService.sendTextMessage(
          conversation.phone,
          '👋 Sua conversa foi encaminhada para um de nossos atendentes humanos. Em breve alguém entrará em contato com você. Obrigado pela paciência!'
        );
      } catch (notifyErr) {
        fastify.log.warn(`Failed to notify client of escalation: ${notifyErr}`);
      }

      return reply.code(200).send({ success: true, data: escalation });
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({ success: false, error: 'Failed to escalate conversation' });
    }
  });

  /**
   * POST /api/conversations/:id/reopen
   * Re-opens a closed or escalated conversation.
   */
  fastify.post<{ Params: { id: string } }>(
    '/conversations/:id/reopen',
    async (request, reply) => {
      try {
        const id = parseInt(request.params.id, 10);
        if (isNaN(id)) {
          return reply.code(400).send({ success: false, error: 'Invalid conversation ID' });
        }

        const conversation = getConversationById(id);
        if (!conversation) {
          return reply.code(404).send({ success: false, error: 'Conversation not found' });
        }

        updateConversationStatus(id, 'active');
        updateConversationState(id, 'ACTIVE');

        return reply.code(200).send({ success: true, message: 'Conversation reopened' });
      } catch (err) {
        fastify.log.error(err);
        return reply.code(500).send({ success: false, error: 'Failed to reopen conversation' });
      }
    }
  );

  /**
   * GET /api/health
   * Health check for the API.
   */
  fastify.get('/health', async (_request, reply) => {
    return reply.code(200).send({
      success: true,
      status: 'healthy',
      timestamp: new Date().toISOString(),
      version: '1.0.0',
    });
  });
}
