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
} from '../database';
import { aiService } from './ai';
import { whatsappService } from './whatsapp';
import { config } from '../config';

export type ConversationState =
  | 'GREETING'
  | 'ACTIVE'
  | 'SCHEDULING_COLLECT_NAME'
  | 'SCHEDULING_COLLECT_SERVICE'
  | 'SCHEDULING_COLLECT_DATE'
  | 'SCHEDULING_COLLECT_TIME'
  | 'SCHEDULING_CONFIRM'
  | 'ESCALATED'
  | 'CLOSED';

interface SchedulingData {
  name?: string;
  service?: string;
  date?: string;
  time?: string;
  notes?: string;
}

export class ConversationService {
  /**
   * Main entry point: processes an incoming message from a user.
   */
  async processMessage(phone: string, messageText: string, messageId?: string): Promise<void> {
    const normalizedPhone = whatsappService.normalizePhone(phone);

    // Get or create conversation record
    const conversation = getOrCreateConversation(normalizedPhone);

    // Mark message as read (best-effort)
    if (messageId) {
      await whatsappService.markAsRead(normalizedPhone, messageId).catch(() => {});
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
        '⏳ Sua conversa já foi encaminhada para um de nossos atendentes. Por favor, aguarde — em breve alguém entrará em contato com você.'
      );
      addMessage(conversation.id, 'user', messageText);
      return;
    }

    // Store user message
    addMessage(conversation.id, 'user', messageText);

    // Check if we're in a multi-step scheduling flow
    const currentState = conversation.state as ConversationState;
    if (
      currentState === 'SCHEDULING_COLLECT_NAME' ||
      currentState === 'SCHEDULING_COLLECT_SERVICE' ||
      currentState === 'SCHEDULING_COLLECT_DATE' ||
      currentState === 'SCHEDULING_COLLECT_TIME' ||
      currentState === 'SCHEDULING_CONFIRM'
    ) {
      await this.handleSchedulingStep(conversation, messageText);
      return;
    }

    // Regular AI-driven flow
    await this.handleAIResponse(conversation, messageText);
  }

  /**
   * Handles the standard AI response flow.
   */
  private async handleAIResponse(conversation: Conversation, userMessage: string): Promise<void> {
    const phone = conversation.phone;

    try {
      // Show typing indicator
      await whatsappService.sendTyping(phone, 2500).catch(() => {});

      // Fetch recent conversation history
      const history = getConversationHistory(conversation.id, config.MAX_HISTORY_MESSAGES);

      // Get AI response
      const rawResponse = await aiService.chat(history, userMessage);

      // Detect special intents
      const intent = aiService.detectIntent(rawResponse);

      switch (intent.type) {
        case 'scheduling': {
          // AI wants to start/complete scheduling
          const data = intent.schedulingData || {};

          if (data.name && data.service && data.date && data.time) {
            // AI already collected all data — save appointment directly
            await this.completeScheduling(conversation, data as Required<SchedulingData>);
            // Send the AI's clean response first if any
            if (intent.cleanResponse) {
              await whatsappService.sendTextMessage(phone, intent.cleanResponse);
              addMessage(conversation.id, 'assistant', intent.cleanResponse);
            }
          } else {
            // Partial data — enter manual collection flow
            const existingData: SchedulingData = {
              name: data.name,
              service: data.service,
              date: data.date,
              time: data.time,
              notes: data.notes,
            };
            await this.startSchedulingCollection(conversation, existingData, intent.cleanResponse);
          }
          break;
        }

        case 'escalation': {
          const reason = intent.escalationReason || 'Solicitação de atendimento humano';
          // Send AI message first
          if (intent.cleanResponse) {
            await whatsappService.sendTextMessage(phone, intent.cleanResponse);
            addMessage(conversation.id, 'assistant', intent.cleanResponse);
          }
          await this.handleEscalation(conversation, reason);
          break;
        }

        default: {
          // Normal response
          await whatsappService.sendTextMessage(phone, intent.cleanResponse);
          addMessage(conversation.id, 'assistant', intent.cleanResponse);

          // Update state to ACTIVE after greeting
          if (conversation.state === 'GREETING') {
            updateConversationState(conversation.id, 'ACTIVE');
          }
          break;
        }
      }
    } catch (err) {
      console.error('[Conversation] Error processing AI response:', err);
      const errorMsg =
        '❌ Desculpe, ocorreu um erro interno. Por favor, tente novamente em instantes.';
      await whatsappService.sendTextMessage(phone, errorMsg).catch(() => {});
      addMessage(conversation.id, 'assistant', errorMsg);
    }
  }

  /**
   * Starts the multi-step scheduling data collection flow.
   */
  private async startSchedulingCollection(
    conversation: Conversation,
    existingData: SchedulingData,
    aiIntroMessage?: string
  ): Promise<void> {
    const phone = conversation.phone;

    if (aiIntroMessage) {
      await whatsappService.sendTextMessage(phone, aiIntroMessage);
      addMessage(conversation.id, 'assistant', aiIntroMessage);
    }

    // Determine which step to go to based on what we already have
    if (!existingData.name) {
      updateConversationState(conversation.id, 'SCHEDULING_COLLECT_NAME', existingData);
      const msg = '📋 Para realizar o agendamento, precisarei de algumas informações.\n\nPrimeiro, qual é o seu *nome completo*?';
      await whatsappService.sendTextMessage(phone, msg);
      addMessage(conversation.id, 'assistant', msg);
    } else if (!existingData.service) {
      updateConversationState(conversation.id, 'SCHEDULING_COLLECT_SERVICE', existingData);
      const msg = `Obrigado, *${existingData.name}*! 😊\n\nQual *serviço* você deseja agendar?`;
      await whatsappService.sendTextMessage(phone, msg);
      addMessage(conversation.id, 'assistant', msg);
    } else if (!existingData.date) {
      updateConversationState(conversation.id, 'SCHEDULING_COLLECT_DATE', existingData);
      const msg = `Ótimo! Serviço: *${existingData.service}*.\n\nQual *data* você prefere? (formato: DD/MM/AAAA)`;
      await whatsappService.sendTextMessage(phone, msg);
      addMessage(conversation.id, 'assistant', msg);
    } else if (!existingData.time) {
      updateConversationState(conversation.id, 'SCHEDULING_COLLECT_TIME', existingData);
      const msg = `Perfeito! Data: *${existingData.date}*.\n\nQual *horário* você prefere? (formato: HH:MM)`;
      await whatsappService.sendTextMessage(phone, msg);
      addMessage(conversation.id, 'assistant', msg);
    }
  }

  /**
   * Handles each step of the scheduling flow based on current state.
   */
  private async handleSchedulingStep(
    conversation: Conversation,
    userInput: string
  ): Promise<void> {
    const phone = conversation.phone;
    const currentState = conversation.state as ConversationState;
    const stateData: SchedulingData = conversation.state_data
      ? (JSON.parse(conversation.state_data) as SchedulingData)
      : {};

    switch (currentState) {
      case 'SCHEDULING_COLLECT_NAME': {
        const name = userInput.trim();
        if (name.length < 2) {
          const msg = '❌ Por favor, informe seu nome completo.';
          await whatsappService.sendTextMessage(phone, msg);
          addMessage(conversation.id, 'assistant', msg);
          return;
        }
        stateData.name = name;
        updateConversationName(conversation.id, name);
        updateConversationState(conversation.id, 'SCHEDULING_COLLECT_SERVICE', stateData);
        const msg = `Obrigado, *${name}*! 😊\n\nQual *serviço* você deseja agendar?`;
        await whatsappService.sendTextMessage(phone, msg);
        addMessage(conversation.id, 'assistant', msg);
        break;
      }

      case 'SCHEDULING_COLLECT_SERVICE': {
        const service = userInput.trim();
        if (service.length < 2) {
          const msg = '❌ Por favor, informe o serviço desejado.';
          await whatsappService.sendTextMessage(phone, msg);
          addMessage(conversation.id, 'assistant', msg);
          return;
        }
        stateData.service = service;
        updateConversationState(conversation.id, 'SCHEDULING_COLLECT_DATE', stateData);
        const msg = `Ótimo! Serviço: *${service}* ✅\n\nQual *data* você prefere para o atendimento?\nPor favor, no formato *DD/MM/AAAA* (ex: 25/12/2025)`;
        await whatsappService.sendTextMessage(phone, msg);
        addMessage(conversation.id, 'assistant', msg);
        break;
      }

      case 'SCHEDULING_COLLECT_DATE': {
        const dateInput = userInput.trim();
        const datePattern = /^(\d{2})\/(\d{2})\/(\d{4})$/;
        const match = dateInput.match(datePattern);

        if (!match) {
          const msg = '❌ Data inválida. Por favor, use o formato *DD/MM/AAAA* (exemplo: 25/12/2025).';
          await whatsappService.sendTextMessage(phone, msg);
          addMessage(conversation.id, 'assistant', msg);
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
          await whatsappService.sendTextMessage(phone, msg);
          addMessage(conversation.id, 'assistant', msg);
          return;
        }

        stateData.date = dateInput;
        updateConversationState(conversation.id, 'SCHEDULING_COLLECT_TIME', stateData);
        const msg = `Data: *${dateInput}* ✅\n\nQual *horário* você prefere?\nPor favor, no formato *HH:MM* (ex: 14:30)`;
        await whatsappService.sendTextMessage(phone, msg);
        addMessage(conversation.id, 'assistant', msg);
        break;
      }

      case 'SCHEDULING_COLLECT_TIME': {
        const timeInput = userInput.trim();
        const timePattern = /^(\d{1,2}):(\d{2})$/;
        const match = timeInput.match(timePattern);

        if (!match) {
          const msg = '❌ Horário inválido. Por favor, use o formato *HH:MM* (exemplo: 14:30).';
          await whatsappService.sendTextMessage(phone, msg);
          addMessage(conversation.id, 'assistant', msg);
          return;
        }

        const [, hour, minute] = match;
        if (Number(hour) > 23 || Number(minute) > 59) {
          const msg = '❌ Horário inválido. Use um horário entre 00:00 e 23:59.';
          await whatsappService.sendTextMessage(phone, msg);
          addMessage(conversation.id, 'assistant', msg);
          return;
        }

        stateData.time = timeInput;
        updateConversationState(conversation.id, 'SCHEDULING_CONFIRM', stateData);

        const confirmMsg =
          `📋 *Resumo do Agendamento*\n\n` +
          `👤 Nome: *${stateData.name}*\n` +
          `🔧 Serviço: *${stateData.service}*\n` +
          `📅 Data: *${stateData.date}*\n` +
          `🕐 Horário: *${stateData.time}*\n\n` +
          `Confirma o agendamento? Responda *SIM* para confirmar ou *NÃO* para cancelar.`;

        await whatsappService.sendTextMessage(phone, confirmMsg);
        addMessage(conversation.id, 'assistant', confirmMsg);
        break;
      }

      case 'SCHEDULING_CONFIRM': {
        const answer = userInput.trim().toLowerCase();

        if (answer === 'sim' || answer === 's' || answer === 'confirmar' || answer === 'confirmo') {
          if (
            stateData.name &&
            stateData.service &&
            stateData.date &&
            stateData.time
          ) {
            await this.completeScheduling(conversation, stateData as Required<Pick<SchedulingData, 'name' | 'service' | 'date' | 'time'>> & SchedulingData);
          } else {
            updateConversationState(conversation.id, 'ACTIVE');
            const msg = '❌ Dados de agendamento incompletos. Por favor, inicie novamente digitando que deseja agendar um serviço.';
            await whatsappService.sendTextMessage(phone, msg);
            addMessage(conversation.id, 'assistant', msg);
          }
        } else if (
          answer === 'não' ||
          answer === 'nao' ||
          answer === 'n' ||
          answer === 'cancelar'
        ) {
          updateConversationState(conversation.id, 'ACTIVE');
          const msg = '✅ Agendamento cancelado. Se precisar de mais alguma coisa, é só falar! 😊';
          await whatsappService.sendTextMessage(phone, msg);
          addMessage(conversation.id, 'assistant', msg);
        } else {
          const msg = 'Por favor, responda *SIM* para confirmar o agendamento ou *NÃO* para cancelar.';
          await whatsappService.sendTextMessage(phone, msg);
          addMessage(conversation.id, 'assistant', msg);
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
    data: Required<Pick<SchedulingData, 'name' | 'service' | 'date' | 'time'>> & SchedulingData
  ): Promise<void> {
    const phone = conversation.phone;

    try {
      const appointment = createAppointment({
        conversationId: conversation.id,
        phone,
        name: data.name,
        service: data.service,
        date: data.date,
        time: data.time,
        notes: data.notes,
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
        `Você receberá uma confirmação em breve. Caso precise cancelar ou reagendar, entre em contato com antecedência de 24 horas.\n\n` +
        `Obrigado por escolher a ${config.COMPANY_NAME}! 😊`;

      await whatsappService.sendTextMessage(phone, successMsg);
      addMessage(conversation.id, 'assistant', successMsg);

      // Notify operator
      const operatorMsg =
        `🔔 *Novo Agendamento* (#${appointment.id})\n\n` +
        `👤 Cliente: ${data.name}\n` +
        `📱 WhatsApp: ${phone}\n` +
        `🔧 Serviço: ${data.service}\n` +
        `📅 Data: ${data.date}\n` +
        `🕐 Horário: ${data.time}` +
        (data.notes ? `\n📝 Obs: ${data.notes}` : '');

      await whatsappService.sendTextMessage(config.OPERATOR_PHONE, operatorMsg).catch((err) => {
        console.error('[Conversation] Failed to notify operator about appointment:', err);
      });

      console.log(`[Conversation] Appointment #${appointment.id} created for ${phone}`);
    } catch (err) {
      console.error('[Conversation] Failed to create appointment:', err);
      updateConversationState(conversation.id, 'ACTIVE');
      const errorMsg =
        '❌ Ocorreu um erro ao salvar seu agendamento. Por favor, tente novamente ou entre em contato diretamente conosco.';
      await whatsappService.sendTextMessage(phone, errorMsg);
      addMessage(conversation.id, 'assistant', errorMsg);
    }
  }

  /**
   * Handles escalation to a human operator.
   */
  async handleEscalation(conversation: Conversation, reason: string): Promise<void> {
    const phone = conversation.phone;

    try {
      const escalation = escalateConversation(conversation.id, reason);

      // Notify operator via WhatsApp
      const operatorMsg =
        `🚨 *Atendimento Requer Atenção Humana*\n\n` +
        `📱 Cliente: ${phone}\n` +
        (conversation.name ? `👤 Nome: ${conversation.name}\n` : '') +
        `📝 Motivo: ${reason}\n\n` +
        `Por favor, entre em contato com o cliente o quanto antes.`;

      await whatsappService.sendTextMessage(config.OPERATOR_PHONE, operatorMsg).catch((err) => {
        console.error('[Conversation] Failed to notify operator:', err);
      });

      markEscalationNotified(escalation.id);

      console.log(`[Conversation] Escalation created for ${phone}: ${reason}`);
    } catch (err) {
      console.error('[Conversation] Error during escalation:', err);
    }
  }
}

export const conversationService = new ConversationService();
