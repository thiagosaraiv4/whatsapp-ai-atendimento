/**
 * ai-full module
 * Handles the full AI conversation + scheduling flow for tenants of type 'ai_full'.
 * This is a tenant-aware extraction of the original conversation logic.
 */

import {
  getOrCreateConversation,
  addMessage,
  getConversationHistory,
  updateConversationState,
  updateConversationName,
  updateConversationStatus,
  escalateConversation,
  markEscalationNotified,
  createAppointment,
  Conversation,
  TenantWithConfig,
} from '../database';
import { aiService, SchedulingData } from '../services/ai';
import { whatsappService } from '../services/whatsapp';
import { config } from '../config';

export type AiFullState =
  | 'GREETING'
  | 'ACTIVE'
  | 'SCHEDULING_COLLECT_NAME'
  | 'SCHEDULING_COLLECT_SERVICE'
  | 'SCHEDULING_COLLECT_DATE'
  | 'SCHEDULING_COLLECT_TIME'
  | 'SCHEDULING_CONFIRM'
  | 'ESCALATED'
  | 'CLOSED';

const SCHEDULING_STATES: AiFullState[] = [
  'SCHEDULING_COLLECT_NAME',
  'SCHEDULING_COLLECT_SERVICE',
  'SCHEDULING_COLLECT_DATE',
  'SCHEDULING_COLLECT_TIME',
  'SCHEDULING_CONFIRM',
];

export class AiFullModule {
  /**
   * Main entry point: processes an incoming message for an ai_full tenant.
   */
  async processMessage(
    phone: string,
    messageText: string,
    tenant: TenantWithConfig,
    messageId?: string
  ): Promise<void> {
    const normalizedPhone = whatsappService.normalizePhone(phone);

    // Get or create conversation record
    const conversation = getOrCreateConversation(normalizedPhone, tenant.id);

    const inst = tenant.evolution_instance;

    // Mark message as read (best-effort)
    if (messageId) {
      await whatsappService.markAsRead(normalizedPhone, messageId, inst).catch(() => {});
    }

    // If conversation is closed, reopen it
    if (conversation.status === 'closed') {
      updateConversationStatus(conversation.id, 'active');
      updateConversationState(conversation.id, 'ACTIVE');
    }

    // If conversation is escalated, inform user and skip AI
    if (conversation.status === 'escalated') {
      await whatsappService.sendTextMessage(
        normalizedPhone,
        '⏳ Sua conversa já foi encaminhada para um de nossos atendentes. Por favor, aguarde — em breve alguém entrará em contato com você.',
        inst
      );
      addMessage(conversation.id, 'user', messageText, tenant.id);
      return;
    }

    // Store user message
    addMessage(conversation.id, 'user', messageText, tenant.id);

    // Check if we're in a multi-step scheduling flow
    const currentState = conversation.state as AiFullState;
    if (SCHEDULING_STATES.includes(currentState)) {
      await this.handleSchedulingStep(conversation, messageText, tenant);
      return;
    }

    // Regular AI-driven flow
    await this.handleAIResponse(conversation, messageText, tenant);
  }

  /**
   * Handles the standard AI response flow.
   */
  private async handleAIResponse(
    conversation: Conversation,
    userMessage: string,
    tenant: TenantWithConfig
  ): Promise<void> {
    const phone = conversation.phone;

    const inst = tenant.evolution_instance;

    try {
      // Show typing indicator
      await whatsappService.sendTyping(phone, 2500, inst).catch(() => {});

      // Fetch recent conversation history
      const history = getConversationHistory(conversation.id, config.MAX_HISTORY_MESSAGES);

      // RAG + tool calling: o agente devolve uma ação estruturada (reply | schedule | escalate)
      const action = await aiService.respond(history, userMessage, tenant);

      switch (action.type) {
        case 'schedule': {
          // Coleta o que faltar; com tudo preenchido vai direto para a confirmação SIM/NÃO
          // (o LLM pode ter entendido algo errado, então não gravamos sem o cliente confirmar).
          await this.startSchedulingCollection(conversation, action.data, action.text, tenant);
          break;
        }

        case 'escalate': {
          const text = action.text || '🙋 Vou transferir você para um de nossos atendentes. Em breve alguém entra em contato por aqui.';
          await whatsappService.sendTextMessage(phone, text, inst);
          addMessage(conversation.id, 'assistant', text, tenant.id);
          await this.handleEscalation(conversation, action.reason, tenant);
          break;
        }

        default: {
          const text = action.text || 'Desculpe, não consegui entender. Pode reformular sua mensagem? 🙂';
          await whatsappService.sendTextMessage(phone, text, inst);
          addMessage(conversation.id, 'assistant', text, tenant.id);

          if (conversation.state === 'GREETING') {
            updateConversationState(conversation.id, 'ACTIVE');
          }
          break;
        }
      }
    } catch (err) {
      console.error('[AiFullModule] Error processing AI response:', err);
      const errorMsg =
        '❌ Desculpe, ocorreu um erro interno. Por favor, tente novamente em instantes.';
      await whatsappService.sendTextMessage(phone, errorMsg, inst).catch(() => {});
      addMessage(conversation.id, 'assistant', errorMsg, tenant.id);
    }
  }

  /**
   * Starts the multi-step scheduling data collection flow.
   */
  private async startSchedulingCollection(
    conversation: Conversation,
    existingData: SchedulingData,
    aiIntroMessage?: string,
    tenant?: TenantWithConfig
  ): Promise<void> {
    const phone = conversation.phone;
    const tenantId = tenant?.id;
    const inst = tenant?.evolution_instance;

    if (aiIntroMessage) {
      await whatsappService.sendTextMessage(phone, aiIntroMessage, inst);
      addMessage(conversation.id, 'assistant', aiIntroMessage, tenantId);
    }

    if (!existingData.name) {
      updateConversationState(conversation.id, 'SCHEDULING_COLLECT_NAME', existingData);
      const msg = '📋 Para realizar o agendamento, precisarei de algumas informações.\n\nPrimeiro, qual é o seu *nome completo*?';
      await whatsappService.sendTextMessage(phone, msg, inst);
      addMessage(conversation.id, 'assistant', msg, tenantId);
    } else if (!existingData.service) {
      updateConversationState(conversation.id, 'SCHEDULING_COLLECT_SERVICE', existingData);
      const msg = `Obrigado, *${existingData.name}*! 😊\n\nQual *serviço* você deseja agendar?`;
      await whatsappService.sendTextMessage(phone, msg, inst);
      addMessage(conversation.id, 'assistant', msg, tenantId);
    } else if (!existingData.date) {
      updateConversationState(conversation.id, 'SCHEDULING_COLLECT_DATE', existingData);
      const msg = `Ótimo! Serviço: *${existingData.service}*.\n\nQual *data* você prefere? (formato: DD/MM/AAAA)`;
      await whatsappService.sendTextMessage(phone, msg, inst);
      addMessage(conversation.id, 'assistant', msg, tenantId);
    } else if (!existingData.time) {
      updateConversationState(conversation.id, 'SCHEDULING_COLLECT_TIME', existingData);
      const msg = `Perfeito! Data: *${existingData.date}*.\n\nQual *horário* você prefere? (formato: HH:MM)`;
      await whatsappService.sendTextMessage(phone, msg, inst);
      addMessage(conversation.id, 'assistant', msg, tenantId);
    } else {
      updateConversationState(conversation.id, 'SCHEDULING_CONFIRM', existingData);
      const msg = this.buildConfirmMessage(existingData);
      await whatsappService.sendTextMessage(phone, msg, inst);
      addMessage(conversation.id, 'assistant', msg, tenantId);
    }
  }

  private buildConfirmMessage(data: SchedulingData): string {
    return (
      `📋 *Resumo do Agendamento*\n\n` +
      `👤 Nome: *${data.name}*\n` +
      `🔧 Serviço: *${data.service}*\n` +
      `📅 Data: *${data.date}*\n` +
      `🕐 Horário: *${data.time}*\n\n` +
      `Confirma o agendamento? Responda *SIM* para confirmar ou *NÃO* para cancelar.`
    );
  }

  /**
   * Handles each step of the scheduling flow based on current state.
   */
  private async handleSchedulingStep(
    conversation: Conversation,
    userInput: string,
    tenant: TenantWithConfig
  ): Promise<void> {
    const phone = conversation.phone;
    const inst = tenant.evolution_instance;
    const currentState = conversation.state as AiFullState;
    const stateData: SchedulingData = conversation.state_data
      ? (JSON.parse(conversation.state_data) as SchedulingData)
      : {};

    switch (currentState) {
      case 'SCHEDULING_COLLECT_NAME': {
        const name = userInput.trim();
        if (name.length < 2) {
          const msg = '❌ Por favor, informe seu nome completo.';
          await whatsappService.sendTextMessage(phone, msg, inst);
          addMessage(conversation.id, 'assistant', msg, tenant.id);
          return;
        }
        stateData.name = name;
        updateConversationName(conversation.id, name);
        updateConversationState(conversation.id, 'SCHEDULING_COLLECT_SERVICE', stateData);
        const msg = `Obrigado, *${name}*! 😊\n\nQual *serviço* você deseja agendar?`;
        await whatsappService.sendTextMessage(phone, msg, inst);
        addMessage(conversation.id, 'assistant', msg, tenant.id);
        break;
      }

      case 'SCHEDULING_COLLECT_SERVICE': {
        const service = userInput.trim();
        if (service.length < 2) {
          const msg = '❌ Por favor, informe o serviço desejado.';
          await whatsappService.sendTextMessage(phone, msg, inst);
          addMessage(conversation.id, 'assistant', msg, tenant.id);
          return;
        }
        stateData.service = service;
        updateConversationState(conversation.id, 'SCHEDULING_COLLECT_DATE', stateData);
        const msg = `Ótimo! Serviço: *${service}* ✅\n\nQual *data* você prefere para o atendimento?\nPor favor, no formato *DD/MM/AAAA* (ex: 25/12/2025)`;
        await whatsappService.sendTextMessage(phone, msg, inst);
        addMessage(conversation.id, 'assistant', msg, tenant.id);
        break;
      }

      case 'SCHEDULING_COLLECT_DATE': {
        const dateInput = userInput.trim();
        const datePattern = /^(\d{2})\/(\d{2})\/(\d{4})$/;
        const match = dateInput.match(datePattern);

        if (!match) {
          const msg = '❌ Data inválida. Por favor, use o formato *DD/MM/AAAA* (exemplo: 25/12/2025).';
          await whatsappService.sendTextMessage(phone, msg, inst);
          addMessage(conversation.id, 'assistant', msg, tenant.id);
          return;
        }

        const [, day, month, year] = match;
        const dateObj = new Date(Number(year), Number(month) - 1, Number(day));
        if (
          dateObj.getFullYear() !== Number(year) ||
          dateObj.getMonth() !== Number(month) - 1 ||
          dateObj.getDate() !== Number(day)
        ) {
          const msg = '❌ Data inválida. Verifique o dia e mês informados.';
          await whatsappService.sendTextMessage(phone, msg, inst);
          addMessage(conversation.id, 'assistant', msg, tenant.id);
          return;
        }

        stateData.date = dateInput;
        updateConversationState(conversation.id, 'SCHEDULING_COLLECT_TIME', stateData);
        const msg = `Data: *${dateInput}* ✅\n\nQual *horário* você prefere?\nPor favor, no formato *HH:MM* (ex: 14:30)`;
        await whatsappService.sendTextMessage(phone, msg, inst);
        addMessage(conversation.id, 'assistant', msg, tenant.id);
        break;
      }

      case 'SCHEDULING_COLLECT_TIME': {
        const timeInput = userInput.trim();
        const timePattern = /^(\d{1,2}):(\d{2})$/;
        const match = timeInput.match(timePattern);

        if (!match) {
          const msg = '❌ Horário inválido. Por favor, use o formato *HH:MM* (exemplo: 14:30).';
          await whatsappService.sendTextMessage(phone, msg, inst);
          addMessage(conversation.id, 'assistant', msg, tenant.id);
          return;
        }

        const [, hour, minute] = match;
        if (Number(hour) > 23 || Number(minute) > 59) {
          const msg = '❌ Horário inválido. Use um horário entre 00:00 e 23:59.';
          await whatsappService.sendTextMessage(phone, msg, inst);
          addMessage(conversation.id, 'assistant', msg, tenant.id);
          return;
        }

        stateData.time = timeInput;
        updateConversationState(conversation.id, 'SCHEDULING_CONFIRM', stateData);

        const confirmMsg = this.buildConfirmMessage(stateData);

        await whatsappService.sendTextMessage(phone, confirmMsg, inst);
        addMessage(conversation.id, 'assistant', confirmMsg, tenant.id);
        break;
      }

      case 'SCHEDULING_CONFIRM': {
        const answer = userInput.trim().toLowerCase();

        if (answer === 'sim' || answer === 's' || answer === 'confirmar' || answer === 'confirmo') {
          if (stateData.name && stateData.service && stateData.date && stateData.time) {
            await this.completeScheduling(
              conversation,
              stateData as Required<Pick<SchedulingData, 'name' | 'service' | 'date' | 'time'>> & SchedulingData,
              tenant
            );
          } else {
            updateConversationState(conversation.id, 'ACTIVE');
            const msg = '❌ Dados de agendamento incompletos. Por favor, inicie novamente digitando que deseja agendar um serviço.';
            await whatsappService.sendTextMessage(phone, msg, inst);
            addMessage(conversation.id, 'assistant', msg, tenant.id);
          }
        } else if (
          answer === 'não' ||
          answer === 'nao' ||
          answer === 'n' ||
          answer === 'cancelar'
        ) {
          updateConversationState(conversation.id, 'ACTIVE');
          const msg = '✅ Agendamento cancelado. Se precisar de mais alguma coisa, é só falar! 😊';
          await whatsappService.sendTextMessage(phone, msg, inst);
          addMessage(conversation.id, 'assistant', msg, tenant.id);
        } else {
          const msg = 'Por favor, responda *SIM* para confirmar o agendamento ou *NÃO* para cancelar.';
          await whatsappService.sendTextMessage(phone, msg, inst);
          addMessage(conversation.id, 'assistant', msg, tenant.id);
        }
        break;
      }
    }
  }

  /**
   * Saves the appointment to the database and notifies the user and operator.
   */
  private async completeScheduling(
    conversation: Conversation,
    data: Required<Pick<SchedulingData, 'name' | 'service' | 'date' | 'time'>> & SchedulingData,
    tenant: TenantWithConfig
  ): Promise<void> {
    const phone = conversation.phone;
    const inst = tenant.evolution_instance;

    try {
      // Build scheduled_at as ISO string for reminder queries
      let scheduledAt: string | undefined;
      try {
        const [day, month, year] = data.date.split('/');
        const [hour, minute] = data.time.split(':');
        scheduledAt = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute)).toISOString();
      } catch {
        // leave undefined if parse fails
      }

      const appointment = createAppointment({
        conversationId: conversation.id,
        tenantId: tenant.id,
        phone,
        name: data.name,
        service: data.service,
        date: data.date,
        time: data.time,
        notes: data.notes,
        status: 'pending',
        scheduledAt,
      });

      // Update name if not yet set
      if (!conversation.name) {
        updateConversationName(conversation.id, data.name);
      }

      // Reset state to ACTIVE
      updateConversationState(conversation.id, 'ACTIVE');

      const successMsg =
        `✅ *Agendamento confirmado com sucesso!*\n\n` +
        `📋 *Detalhes:*\n` +
        `👤 Nome: ${data.name}\n` +
        `🔧 Serviço: ${data.service}\n` +
        `📅 Data: ${data.date}\n` +
        `🕐 Horário: ${data.time}\n\n` +
        `Você receberá uma confirmação em breve. Caso precise cancelar ou reagendar, entre em contato com antecedência.\n\n` +
        `Obrigado por escolher a *${tenant.name}*! 😊`;

      await whatsappService.sendTextMessage(phone, successMsg, inst);
      addMessage(conversation.id, 'assistant', successMsg, tenant.id);

      // Notify operator
      const operatorMsg =
        `🔔 *Novo Agendamento* (#${appointment.id})\n` +
        `🏢 Tenant: ${tenant.name}\n\n` +
        `👤 Cliente: ${data.name}\n` +
        `📱 WhatsApp: ${phone}\n` +
        `🔧 Serviço: ${data.service}\n` +
        `📅 Data: ${data.date}\n` +
        `🕐 Horário: ${data.time}` +
        (data.notes ? `\n📝 Obs: ${data.notes}` : '');

      await whatsappService.sendTextMessage(tenant.operator_phone, operatorMsg, inst).catch((err) => {
        console.error('[AiFullModule] Failed to notify operator about appointment:', err);
      });

      console.log(`[AiFullModule] Appointment #${appointment.id} created for ${phone} (tenant: ${tenant.slug})`);
    } catch (err) {
      console.error('[AiFullModule] Failed to create appointment:', err);
      updateConversationState(conversation.id, 'ACTIVE');
      const errorMsg =
        '❌ Ocorreu um erro ao salvar seu agendamento. Por favor, tente novamente ou entre em contato diretamente conosco.';
      await whatsappService.sendTextMessage(phone, errorMsg, inst);
      addMessage(conversation.id, 'assistant', errorMsg, tenant.id);
    }
  }

  /**
   * Handles escalation to a human operator.
   */
  async handleEscalation(conversation: Conversation, reason: string, tenant: TenantWithConfig): Promise<void> {
    const phone = conversation.phone;
    const inst = tenant.evolution_instance;

    try {
      const escalation = escalateConversation(conversation.id, reason, tenant.id);

      const operatorMsg =
        `🚨 *Atendimento Requer Atenção Humana*\n` +
        `🏢 Tenant: ${tenant.name}\n\n` +
        `📱 Cliente: ${phone}\n` +
        (conversation.name ? `👤 Nome: ${conversation.name}\n` : '') +
        `📝 Motivo: ${reason}\n\n` +
        `Por favor, entre em contato com o cliente o quanto antes.`;

      await whatsappService.sendTextMessage(tenant.operator_phone, operatorMsg, inst).catch((err) => {
        console.error('[AiFullModule] Failed to notify operator:', err);
      });

      markEscalationNotified(escalation.id);

      console.log(`[AiFullModule] Escalation created for ${phone} (tenant: ${tenant.slug}): ${reason}`);
    } catch (err) {
      console.error('[AiFullModule] Error during escalation:', err);
    }
  }
}

export const aiFullModule = new AiFullModule();
