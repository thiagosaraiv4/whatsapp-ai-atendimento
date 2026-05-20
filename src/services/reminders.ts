/**
 * Reminders Service
 * Runs every 30 minutes via setInterval, querying for appointments due for a 24h reminder.
 * Only processes ai_full tenants that have reminders.enabled = true.
 */

import { getAppointmentsDueForReminder, markReminderSent, getTenantById } from '../database';
import { whatsappService } from './whatsapp';

const REMINDER_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

async function sendReminders(): Promise<void> {
  console.log('[Reminders] Checking for appointments due for reminder...');

  try {
    const appointments = getAppointmentsDueForReminder();

    if (appointments.length === 0) {
      console.log('[Reminders] No reminders to send.');
      return;
    }

    for (const appt of appointments) {
      try {
        // Respect tenant reminder config
        const tenant = getTenantById(appt.tenant_id);
        if (tenant) {
          const remindersConfig = tenant.config.reminders;
          if (!remindersConfig || !remindersConfig.enabled) {
            console.log(`[Reminders] Reminders disabled for tenant ${tenant.slug} — skipping appointment #${appt.id}`);
            markReminderSent(appt.id);
            continue;
          }
        }

        const tenantName = tenant?.name || 'Barbearia Castilho';

        const reminderMsg =
          `Olá ${appt.name}! 👋 Lembrando que você tem um agendamento na *${tenantName}* ` +
          `amanhã às *${appt.time}*.\n\n` +
          `📋 Serviço: ${appt.service}\n` +
          `📅 Data: ${appt.date}\n\n` +
          `Caso precise cancelar ou remarcar, entre em contato conosco com antecedência. 😊`;

        await whatsappService.sendTextMessage(appt.phone, reminderMsg);
        markReminderSent(appt.id);

        console.log(`[Reminders] Reminder sent for appointment #${appt.id} to ${appt.phone}`);
      } catch (err) {
        console.error(`[Reminders] Failed to send reminder for appointment #${appt.id}:`, err);
      }
    }
  } catch (err) {
    console.error('[Reminders] Error querying appointments for reminders:', err);
  }
}

/**
 * Start the reminder scheduler.
 * Runs immediately on startup, then every 30 minutes.
 */
export function startReminderScheduler(): void {
  console.log('[Reminders] Reminder scheduler started (interval: 30 min)');

  // Run once immediately (after a short delay to let DB settle)
  setTimeout(() => {
    sendReminders().catch((err) => {
      console.error('[Reminders] Initial reminder check failed:', err);
    });
  }, 5000);

  // Then run every 30 minutes
  setInterval(() => {
    sendReminders().catch((err) => {
      console.error('[Reminders] Scheduled reminder check failed:', err);
    });
  }, REMINDER_INTERVAL_MS);
}
