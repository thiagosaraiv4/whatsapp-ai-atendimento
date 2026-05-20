/**
 * conversation.ts
 * Tenant-aware conversation dispatcher.
 * Routes messages to the correct module based on tenant type.
 */

import { TenantWithConfig } from '../database';
import { aiFullModule } from '../modules/ai-full';
import { collectForwardModule } from '../modules/collect-forward';
import { whatsappService } from './whatsapp';

export class ConversationService {
  /**
   * Main entry point: processes an incoming message for a given tenant.
   */
  async processMessage(
    phone: string,
    messageText: string,
    tenant: TenantWithConfig,
    messageId?: string
  ): Promise<void> {
    const normalizedPhone = whatsappService.normalizePhone(phone);

    console.log(
      `[Conversation] Processing message for tenant "${tenant.slug}" (type: ${tenant.type}) from ${normalizedPhone}`
    );

    switch (tenant.type) {
      case 'ai_full':
        await aiFullModule.processMessage(normalizedPhone, messageText, tenant, messageId);
        break;

      case 'collect_forward':
        await collectForwardModule.processMessage(normalizedPhone, messageText, tenant, messageId);
        break;

      default:
        console.warn(`[Conversation] Unknown tenant type: ${(tenant as TenantWithConfig).type}`);
        break;
    }
  }
}

export const conversationService = new ConversationService();
