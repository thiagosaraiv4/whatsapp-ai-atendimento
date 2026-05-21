/**
 * collect-forward module
 * Handles the data collection + forward flow for tenants of type 'collect_forward'.
 * No AI is used — pure state machine that collects fields and forwards to the professional.
 */

import {
  getOrCreateConversation,
  addMessage,
  updateConversationState,
  updateConversationName,
  updateConversationStatus,
  createAppointment,
  Conversation,
  TenantWithConfig,
} from '../database';
import { whatsappService } from '../services/whatsapp';
import { config } from '../config';

// ─── State Machine ────────────────────────────────────────────────────────────

export type CollectForwardState =
  | 'GREETING'
  | 'COLLECT_NAME'
  | 'COLLECT_DEMAND'
  | 'COLLECT_PREFERRED_DAYS'
  | 'COLLECT_PREFERRED_TIMES'
  | 'CONFIRM'
  | 'FORWARDED';

interface CollectData {
  name?: string;
  demand?: string;
  preferred_days?: string;
  preferred_times?: string;
}

const COLLECT_STATES: CollectForwardState[] = [
  'COLLECT_NAME',
  'COLLECT_DEMAND',
  'COLLECT_PREFERRED_DAYS',
  'COLLECT_PREFERRED_TIMES',
  'CONFIRM',
];

export class CollectForwardModule {
  /**
   * Main entry point: processes an incoming message for a collect_forward tenant.
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

    // Mark message as read (best-effort)
    if (messageId) {
      await whatsappService.markAsRead(normalizedPhone, messageId).catch(() => {});
    }

    const inst = tenant.evolution_instance;

    // If already forwarded, let user restart by reopening
    if (conversation.status === 'closed' || conversation.state === 'FORWARDED') {
      updateConversationStatus(conversation.id, 'active');
      updateConversationState(conversation.id, 'COLLECT_NAME');
      const welcomeMsg = tenant.config.welcome_message || 'Olá! Como posso te ajudar?';
      await whatsappService.sendTextMessage(normalizedPhone, welcomeMsg, inst);
      addMessage(conversation.id, 'assistant', welcomeMsg, tenant.id);
      return;
    }

    // Store user message
    addMessage(conversation.id, 'user', messageText, tenant.id);

    const currentState = conversation.state as CollectForwardState;

    if (currentState === 'GREETING') {
      await this.handleGreeting(conversation, tenant);
      return;
    }

    if (COLLECT_STATES.includes(currentState)) {
      await this.handleCollectionStep(conversation, messageText, tenant);
      return;
    }

    await this.handleGreeting(conversation, tenant);
  }

  /**
   * Sends the welcome message and moves to COLLECT_NAME state.
   */
  private async handleGreeting(conversation: Conversation, tenant: TenantWithConfig): Promise<void> {
    const phone = conversation.phone;
    const inst = tenant.evolution_instance;
    const welcomeMsg = tenant.config.welcome_message ||
      'Olá! Para agendar, vou precisar de algumas informações.\n\nMe diga seu *nome completo*:';

    await whatsappService.sendTextMessage(phone, welcomeMsg, inst);
    addMessage(conversation.id, 'assistant', welcomeMsg, tenant.id);
    updateConversationState(conversation.id, 'COLLECT_NAME');
  }

  /**
   * Handles each step of the data collection flow.
   */
  private async handleCollectionStep(
    conversation: Conversation,
    userInput: string,
    tenant: TenantWithConfig
  ): Promise<void> {
    const phone = conversation.phone;
    const inst = tenant.evolution_instance;
    const currentState = conversation.state as CollectForwardState;
    const stateData: CollectData = conversation.state_data
      ? (JSON.parse(conversation.state_data) as CollectData)
      : {};

    switch (currentState) {
      case 'COLLECT_NAME': {
        const name = userInput.trim();
        if (name.length < 2) {
          const msg = 'Por favor, informe seu *nome completo* para continuarmos.';
          await whatsappService.sendTextMessage(phone, msg, inst);
          addMessage(conversation.id, 'assistant', msg, tenant.id);
          return;
        }
        stateData.name = name;
        updateConversationName(conversation.id, name);
        updateConversationState(conversation.id, 'COLLECT_DEMAND', stateData);
        const msg =
          `Obrigado, *${name}*! 🌿\n\n` +
          `Em poucas palavras, como posso descrever o motivo do seu interesse em uma consulta?\n` +
          `_(ex: ansiedade, autoconhecimento, relacionamentos...)_`;
        await whatsappService.sendTextMessage(phone, msg, inst);
        addMessage(conversation.id, 'assistant', msg, tenant.id);
        break;
      }

      case 'COLLECT_DEMAND': {
        const demand = userInput.trim();
        if (demand.length < 2) {
          const msg = 'Por favor, descreva brevemente o motivo do seu interesse.';
          await whatsappService.sendTextMessage(phone, msg, inst);
          addMessage(conversation.id, 'assistant', msg, tenant.id);
          return;
        }
        stateData.demand = demand;
        updateConversationState(conversation.id, 'COLLECT_PREFERRED_DAYS', stateData);
        const msg =
          `Entendido! 😊\n\n` +
          `Quais *dias da semana* são melhores para você?\n` +
          `_(ex: segunda, quarta, sexta)_`;
        await whatsappService.sendTextMessage(phone, msg, inst);
        addMessage(conversation.id, 'assistant', msg, tenant.id);
        break;
      }

      case 'COLLECT_PREFERRED_DAYS': {
        const days = userInput.trim();
        if (days.length < 2) {
          const msg = 'Por favor, informe os dias da semana de sua preferência.';
          await whatsappService.sendTextMessage(phone, msg, inst);
          addMessage(conversation.id, 'assistant', msg, tenant.id);
          return;
        }
        stateData.preferred_days = days;
        updateConversationState(conversation.id, 'COLLECT_PREFERRED_TIMES', stateData);
        const msg =
          `Perfeito! ✅\n\n` +
          `Qual *período* prefere?\n` +
          `• Manhã (8h–12h)\n` +
          `• Tarde (13h–18h)\n` +
          `• Noite (19h–21h)`;
        await whatsappService.sendTextMessage(phone, msg, inst);
        addMessage(conversation.id, 'assistant', msg, tenant.id);
        break;
      }

      case 'COLLECT_PREFERRED_TIMES': {
        const times = userInput.trim();
        if (times.length < 2) {
          const msg = 'Por favor, informe o período de preferência (manhã, tarde ou noite).';
          await whatsappService.sendTextMessage(phone, msg, inst);
          addMessage(conversation.id, 'assistant', msg, tenant.id);
          return;
        }
        stateData.preferred_times = times;
        updateConversationState(conversation.id, 'CONFIRM', stateData);
        const confirmMsg =
          `📋 *Resumo das suas informações:*\n\n` +
          `👤 Nome: *${stateData.name}*\n` +
          `📝 Demanda: *${stateData.demand}*\n` +
          `📅 Dias preferidos: *${stateData.preferred_days}*\n` +
          `⏰ Período: *${stateData.preferred_times}*\n\n` +
          `Posso enviar essas informações para a psicóloga?\n` +
          `Responda *SIM* para confirmar ou *NÃO* para cancelar.`;
        await whatsappService.sendTextMessage(phone, confirmMsg, inst);
        addMessage(conversation.id, 'assistant', confirmMsg, tenant.id);
        break;
      }

      case 'CONFIRM': {
        const answer = userInput.trim().toLowerCase();
        if (answer === 'sim' || answer === 's' || answer === 'confirmar' || answer === 'confirmo' || answer === 'yes') {
          if (stateData.name && stateData.demand && stateData.preferred_days && stateData.preferred_times) {
            await this.forwardToOperator(conversation, {
              name: stateData.name,
              demand: stateData.demand,
              preferred_days: stateData.preferred_days,
              preferred_times: stateData.preferred_times,
            }, tenant);
          } else {
            updateConversationState(conversation.id, 'COLLECT_NAME');
            const msg = '❌ Dados incompletos. Vamos recomeçar. Me diga seu *nome completo*:';
            await whatsappService.sendTextMessage(phone, msg, inst);
            addMessage(conversation.id, 'assistant', msg, tenant.id);
          }
        } else if (answer === 'não' || answer === 'nao' || answer === 'n' || answer === 'cancelar' || answer === 'no') {
          updateConversationState(conversation.id, 'COLLECT_NAME');
          const msg = 'Tudo bem! Se precisar de algo, é só chamar. 🌿';
          await whatsappService.sendTextMessage(phone, msg, inst);
          addMessage(conversation.id, 'assistant', msg, tenant.id);
        } else {
          const msg = 'Por favor, responda *SIM* para enviar suas informações ou *NÃO* para cancelar.';
          await whatsappService.sendTextMessage(phone, msg, inst);
          addMessage(conversation.id, 'assistant', msg, tenant.id);
        }
        break;
      }
    }
  }

  /**
   * Saves the appointment as pending_professional, notifies operator, sends forward_message to user.
   */
  private async forwardToOperator(
    conversation: Conversation,
    data: Required<CollectData>,
    tenant: TenantWithConfig
  ): Promise<void> {
    const phone = conversation.phone;
    const inst = tenant.evolution_instance;

    try {
      await createAppointment({
        conversationId: conversation.id,
        tenantId: tenant.id,
        phone,
        name: data.name,
        service: `Consulta psicológica — Demanda: ${data.demand}`,
        date: data.preferred_days,
        time: data.preferred_times,
        notes: `Demanda: ${data.demand} | Dias: ${data.preferred_days} | Período: ${data.preferred_times}`,
        status: 'pending_professional',
      });

      // Move conversation to FORWARDED state
      updateConversationState(conversation.id, 'FORWARDED');
      updateConversationStatus(conversation.id, 'closed');

      // Send forward_message to user
      const forwardMsg = tenant.config.forward_message ||
        '✅ Suas informações foram enviadas. Em breve entraremos em contato para confirmar sua consulta.';
      await whatsappService.sendTextMessage(phone, forwardMsg, inst);
      addMessage(conversation.id, 'assistant', forwardMsg, tenant.id);

      const operatorMsg =
        `🔔 *Nova solicitação de consulta*\n` +
        `👤 Nome: ${data.name}\n` +
        `📝 Demanda: ${data.demand}\n` +
        `📅 Dias preferidos: ${data.preferred_days}\n` +
        `⏰ Período: ${data.preferred_times}\n` +
        `📱 WhatsApp: ${phone}\n\n` +
        `Acesse o dashboard: ${config.APP_URL}`;

      await whatsappService.sendTextMessage(tenant.operator_phone, operatorMsg, inst).catch((err) => {
        console.error('[CollectForwardModule] Failed to notify operator:', err);
      });

      console.log(`[CollectForwardModule] Forwarded inquiry for ${phone} to operator (tenant: ${tenant.slug})`);
    } catch (err) {
      console.error('[CollectForwardModule] Failed to forward inquiry:', err);
      updateConversationState(conversation.id, 'COLLECT_NAME');
      const errorMsg = '❌ Ocorreu um erro ao enviar suas informações. Por favor, tente novamente.';
      await whatsappService.sendTextMessage(phone, errorMsg, inst);
      addMessage(conversation.id, 'assistant', errorMsg, tenant.id);
    }
  }
}

export const collectForwardModule = new CollectForwardModule();
