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
  listTenants,
  getTenantById,
} from '../database';
import { whatsappService } from '../services/whatsapp';
import { config } from '../config';

export async function dashboardRoutes(
  fastify: FastifyInstance,
  _options: FastifyPluginOptions
): Promise<void> {
  /**
   * GET /api/tenants
   * Returns all active tenants.
   */
  fastify.get('/tenants', async (_request, reply) => {
    try {
      const tenants = listTenants();
      // Return without internal config details for security
      const safe = tenants.map((t) => ({
        id: t.id,
        slug: t.slug,
        name: t.name,
        type: t.type,
        active: t.active,
      }));
      return reply.code(200).send({ success: true, data: safe });
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({ success: false, error: 'Failed to list tenants' });
    }
  });

  /**
   * GET /api/conversations
   * Returns all conversations, optionally filtered by tenant_id.
   */
  fastify.get<{ Querystring: { tenant_id?: string } }>(
    '/conversations',
    async (request, reply) => {
      try {
        const tenantId = request.query.tenant_id ? parseInt(request.query.tenant_id, 10) : undefined;
        const conversations = listConversations(tenantId);
        return reply.code(200).send({ success: true, data: conversations });
      } catch (err) {
        fastify.log.error(err);
        return reply.code(500).send({ success: false, error: 'Failed to list conversations' });
      }
    }
  );

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
   * Returns all appointments, optionally filtered by status and/or tenant_id.
   */
  fastify.get<{ Querystring: { status?: string; tenant_id?: string } }>(
    '/appointments',
    async (request, reply) => {
      try {
        const { status } = request.query;
        const tenantId = request.query.tenant_id ? parseInt(request.query.tenant_id, 10) : undefined;
        const appointments = listAppointments(status, tenantId);
        return reply.code(200).send({ success: true, data: appointments });
      } catch (err) {
        fastify.log.error(err);
        return reply.code(500).send({ success: false, error: 'Failed to list appointments' });
      }
    }
  );

  /**
   * PUT /api/appointments/:id
   * Updates appointment status. For collect_forward tenants, sends WhatsApp confirmation/decline.
   */
  fastify.put<{
    Params: { id: string };
    Body: { status: 'pending' | 'confirmed' | 'cancelled' | 'pending_professional' };
  }>('/appointments/:id', async (request, reply) => {
    try {
      const id = parseInt(request.params.id, 10);
      if (isNaN(id)) {
        return reply.code(400).send({ success: false, error: 'Invalid appointment ID' });
      }

      const { status } = request.body;
      if (!['pending', 'confirmed', 'cancelled', 'pending_professional'].includes(status)) {
        return reply
          .code(400)
          .send({ success: false, error: 'Invalid status. Use: pending, confirmed, cancelled, pending_professional' });
      }

      const updated = updateAppointmentStatus(id, status);
      if (!updated) {
        return reply.code(404).send({ success: false, error: 'Appointment not found' });
      }

      // Get tenant info to customize notifications
      const tenant = getTenantById(updated.tenant_id);
      const isMentalHealth = tenant?.type === 'collect_forward';

      // Notify client based on status change
      try {
        if (status === 'confirmed') {
          if (isMentalHealth) {
            // collect_forward confirmation message
            await whatsappService.sendTextMessage(
              updated.phone,
              `✅ Sua consulta foi confirmada! A *${tenant?.name || 'Psicóloga'}* entrará em contato em breve no seu WhatsApp. 🌿`
            );
          } else {
            await whatsappService.sendTextMessage(
              updated.phone,
              `✅ *Seu agendamento foi confirmado!*\n\n` +
                `📋 Serviço: ${updated.service}\n` +
                `📅 Data: ${updated.date}\n` +
                `🕐 Horário: ${updated.time}\n\n` +
                `Aguardamos você! 😊`
            );
          }
        } else if (status === 'cancelled') {
          if (isMentalHealth) {
            await whatsappService.sendTextMessage(
              updated.phone,
              `Olá, ${updated.name}! 🌿\n\n` +
                `Infelizmente não será possível confirmar sua consulta no momento. ` +
                `Mas não se preocupe — você pode entrar em contato novamente quando quiser. ` +
                `Estamos aqui para ajudar! 💙`
            );
          } else {
            await whatsappService.sendTextMessage(
              updated.phone,
              `❌ *Seu agendamento foi cancelado.*\n\n` +
                `📋 Serviço: ${updated.service} — ${updated.date} às ${updated.time}\n\n` +
                `Se desejar reagendar, entre em contato conosco pelo WhatsApp.`
            );
          }
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
   * Returns dashboard metrics, optionally filtered by tenant_id.
   */
  fastify.get<{ Querystring: { tenant_id?: string } }>(
    '/metrics',
    async (request, reply) => {
      try {
        const tenantId = request.query.tenant_id ? parseInt(request.query.tenant_id, 10) : undefined;
        const metrics = getMetrics(tenantId);
        return reply.code(200).send({ success: true, data: metrics });
      } catch (err) {
        fastify.log.error(err);
        return reply.code(500).send({ success: false, error: 'Failed to get metrics' });
      }
    }
  );

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
      const escalation = escalateConversation(id, reason, conversation.tenant_id);

      // Get operator phone — prefer tenant operator, fallback to global
      let operatorPhone = config.OPERATOR_PHONE;
      const tenant = getTenantById(conversation.tenant_id);
      if (tenant?.operator_phone) {
        operatorPhone = tenant.operator_phone;
      }

      // Notify operator
      const operatorMsg =
        `🚨 *Atendimento Escalonado Manualmente*\n` +
        (tenant ? `🏢 Tenant: ${tenant.name}\n` : '') +
        `\n📱 Cliente: ${conversation.phone}\n` +
        (conversation.name ? `👤 Nome: ${conversation.name}\n` : '') +
        `📝 Motivo: ${reason}`;

      try {
        await whatsappService.sendTextMessage(operatorPhone, operatorMsg);
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
      version: '2.0.0',
    });
  });
}
