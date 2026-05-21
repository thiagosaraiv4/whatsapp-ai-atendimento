import { conversationService } from '../services/conversation';
import { whatsappService } from '../services/whatsapp';
import { getTenantByPhone, getTenantByInstance, listTenants, TenantWithConfig } from '../database';

export interface IncomingMessage {
  phone: string;
  text: string;
  messageId?: string;
  fromMe: boolean;
  isGroup: boolean;
  pushName?: string;
  instance?: string;
}

/**
 * Resolves the tenant for an incoming message.
 *
 * Routing priority:
 * 1. Match by Evolution API instance name (evolution_instance column).
 *    Each tenant should have their own Evolution API instance — set via:
 *    UPDATE tenants SET evolution_instance='nome-da-instancia' WHERE slug='barbearia-castilho';
 * 2. Match by whatsapp_phone (legacy / alternative).
 * 3. Fallback to first active tenant for development when not configured yet.
 */
function resolveTenant(phone: string, instance?: string): TenantWithConfig | null {
  // 1. Match by Evolution API instance name (primary production routing)
  if (instance) {
    const byInstance = getTenantByInstance(instance);
    if (byInstance) return byInstance;
  }

  // 2. Match by whatsapp_phone
  const byPhone = getTenantByPhone(phone);
  if (byPhone) return byPhone;

  // 3. Fallback: first active tenant (dev/single-instance mode)
  const allTenants = listTenants();
  if (allTenants.length > 0) {
    console.log(
      `[Pipeline] No tenant matched instance="${instance}" or phone=${phone} — ` +
      `falling back to "${allTenants[0].slug}". ` +
      `Set evolution_instance on tenant rows for multi-tenant routing.`
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
  const tenant = resolveTenant(phone, message.instance);
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
