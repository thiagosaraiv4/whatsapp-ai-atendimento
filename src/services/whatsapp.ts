import axios, { AxiosInstance } from 'axios';
import { config } from '../config';

interface SendTextResponse {
  key: {
    remoteJid: string;
    fromMe: boolean;
    id: string;
  };
  message: {
    conversation: string;
  };
  messageTimestamp: number;
  status: string;
}

interface ListOption {
  title: string;
  description?: string;
  rowId: string;
}

interface InstanceStatus {
  instance: {
    instanceName: string;
    status: string;
    state?: string;
  };
}

class WhatsAppService {
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      baseURL: config.EVOLUTION_API_URL,
      headers: {
        'Content-Type': 'application/json',
        apikey: config.EVOLUTION_API_KEY,
      },
      timeout: 15000,
    });

    this.client.interceptors.response.use(
      (response) => response,
      (error) => {
        const message =
          error.response?.data?.message || error.message || 'Unknown error';
        const status = error.response?.status || 0;
        console.error(`[WhatsApp] API Error ${status}: ${message}`);
        throw new Error(`WhatsApp API Error: ${message}`);
      }
    );
  }

  /**
   * Normalize phone number: remove non-digits, ensure country code
   * Returns format like "5511999999999" (without @s.whatsapp.net)
   */
  normalizePhone(phone: string): string {
    let cleaned = phone.replace(/\D/g, '');

    // Remove @s.whatsapp.net or @g.us suffix if present
    if (phone.includes('@')) {
      cleaned = phone.split('@')[0].replace(/\D/g, '');
    }

    // Remove :XX suffix (group participants format)
    const colonIdx = cleaned.indexOf(':');
    if (colonIdx > -1) {
      cleaned = cleaned.substring(0, colonIdx);
    }

    // Add Brazil country code if missing (assumes BR numbers)
    if (cleaned.length === 10 || cleaned.length === 11) {
      cleaned = '55' + cleaned;
    }

    return cleaned;
  }

  /**
   * Format phone for Evolution API: "5511999999999@s.whatsapp.net"
   */
  formatPhoneForApi(phone: string): string {
    const normalized = this.normalizePhone(phone);
    return `${normalized}@s.whatsapp.net`;
  }

  private resolveInstance(instance?: string | null): string {
    return instance || config.EVOLUTION_INSTANCE;
  }

  async sendTextMessage(phone: string, text: string, instance?: string | null): Promise<SendTextResponse> {
    const normalizedPhone = this.normalizePhone(phone);
    const inst = this.resolveInstance(instance);

    const response = await this.client.post<SendTextResponse>(
      `/message/sendText/${inst}`,
      { number: normalizedPhone, text }
    );

    console.log(`[WhatsApp] Message sent to ${normalizedPhone} via instance "${inst}"`);
    return response.data;
  }

  async sendListMessage(
    phone: string,
    title: string,
    description: string,
    buttonText: string,
    options: ListOption[],
    instance?: string | null
  ): Promise<unknown> {
    const normalizedPhone = this.normalizePhone(phone);
    const inst = this.resolveInstance(instance);

    const response = await this.client.post(
      `/message/sendList/${inst}`,
      {
        number: normalizedPhone,
        title,
        description,
        buttonText,
        footerText: config.COMPANY_NAME,
        sections: [
          {
            title: 'Opções',
            rows: options.map((opt) => ({
              title: opt.title,
              description: opt.description || '',
              rowId: opt.rowId,
            })),
          },
        ],
      }
    );

    console.log(`[WhatsApp] List message sent to ${normalizedPhone} via instance "${inst}"`);
    return response.data;
  }

  async markAsRead(phone: string, messageId: string, instance?: string | null): Promise<void> {
    const normalizedPhone = this.normalizePhone(phone);
    const inst = this.resolveInstance(instance);
    try {
      await this.client.post(`/message/markMessageAsRead/${inst}`, {
        readMessages: [
          {
            remoteJid: `${normalizedPhone}@s.whatsapp.net`,
            fromMe: false,
            id: messageId,
          },
        ],
      });
    } catch (err) {
      console.warn(`[WhatsApp] Could not mark message as read: ${(err as Error).message}`);
    }
  }

  async getInstanceStatus(instance?: string | null): Promise<InstanceStatus> {
    const inst = this.resolveInstance(instance);
    const response = await this.client.get<InstanceStatus>(
      `/instance/connectionState/${inst}`
    );
    return response.data;
  }

  async sendTyping(phone: string, durationMs = 2000, instance?: string | null): Promise<void> {
    const normalizedPhone = this.normalizePhone(phone);
    const inst = this.resolveInstance(instance);
    try {
      await this.client.post(`/message/sendPresence/${inst}`, {
        number: normalizedPhone,
        options: { presence: 'composing', delay: durationMs },
      });
    } catch {
      // Typing indicator is best-effort
    }
  }
}

export const whatsappService = new WhatsAppService();
