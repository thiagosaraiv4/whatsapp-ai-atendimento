import { conversationService } from '../services/conversation';
import { whatsappService } from '../services/whatsapp';

export interface IncomingMessage {
  phone: string;
  text: string;
  messageId?: string;
  fromMe: boolean;
  isGroup: boolean;
  pushName?: string;
}

/**
 * Central message processing pipeline.
 * Validates the message and delegates to the conversation service.
 */
export async function processPipeline(message: IncomingMessage): Promise<void> {
  // Skip messages sent by us
  if (message.fromMe) {
    console.log('[Pipeline] Skipping own message');
    return;
  }

  // Skip group messages
  if (message.isGroup) {
    console.log('[Pipeline] Skipping group message');
    return;
  }

  // Skip empty messages
  const text = message.text?.trim();
  if (!text) {
    console.log('[Pipeline] Skipping empty message');
    return;
  }

  // Normalize phone
  const phone = whatsappService.normalizePhone(message.phone);

  console.log(`[Pipeline] Processing message from ${phone}: "${text.substring(0, 80)}${text.length > 80 ? '...' : ''}"`);

  try {
    await conversationService.processMessage(phone, text, message.messageId);
  } catch (err) {
    console.error('[Pipeline] Unhandled error in conversation processing:', err);
  }
}
