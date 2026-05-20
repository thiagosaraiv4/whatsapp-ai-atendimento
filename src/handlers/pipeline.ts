import { conversationService } from '../services/conversation';
import { whatsappService } from '../services/whatsapp';
import { getTenantByPhone, listTenants, TenantWithConfig } from '../database';

export interface IncomingMessage {
  phone: string;
  text: string;
  messageId?: string;
  fromMe: boolean;
  isGroup: boolean;
  pushName?: string;
}

/**
 * Resolves the tenant for an incoming message.
 *
 * Routing priority:
 * 1. Match by whatsapp_phone configured on the tenant (for production use
 *    when each tenant has a dedicated WhatsApp number).
 * 2. Fallback to the first active tenant (tenant id=1, barbearia-castilho)
 *    for testing/development when tenant phone numbers aren't configured yet.
 *
 * TODO: Replace the fallback with proper phone-based routing once each tenant
 * has their own Evolution API instance / WhatsApp number configured in the DB.
 */
function resolveTenant(phone: string): TenantWithConfig | null {
  // 1. Try to find tenant by the incoming phone number
  const byPhone = getTenantByPhone(phone);
  if (byPhone) return byPhone;

  // 2. Fallback: use first active tenant
  const allTenants = listTenants();
  if (allTenants.length > 0) {
    console.log(
      `[Pipeline] No tenant matched phone ${phone} — falling back to tenant "${allTenants[0].slug}". ` +
      `Configure whatsapp_phone on tenants for production routing.`
    );
    return allTenants[0];
  }

  return null;
}

/**
 * Central message processing pipeline.
 * Validates the message, resolves the tenant, and delegates to the conversation service.
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

  // Normalize phone (extract from JID format: 5511999999999@s.whatsapp.net → 5511999999999)
  const phone = whatsappService.normalizePhone(message.phone);

  console.log(
    `[Pipeline] Processing message from ${phone}: "${text.substring(0, 80)}${text.length > 80 ? '...' : ''}"`
  );

  // Resolve tenant
  const tenant = resolveTenant(phone);
  if (!tenant) {
    console.error('[Pipeline] No active tenant found — cannot process message');
    return;
  }

  try {
    await conversationService.processMessage(phone, text, tenant, message.messageId);
  } catch (err) {
    console.error('[Pipeline] Unhandled error in conversation processing:', err);
  }
}
