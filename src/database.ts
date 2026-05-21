import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { config } from './config';

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) {
    const dbDir = path.dirname(config.DATABASE_PATH);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }
    db = new Database(config.DATABASE_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
  }
  return db;
}

export function setupDatabase(): void {
  const database = getDb();

  // ── New multi-tenant tables ─────────────────────────────────────────────────
  database.exec(`
    CREATE TABLE IF NOT EXISTS tenants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      whatsapp_phone TEXT,
      evolution_instance TEXT,
      operator_phone TEXT NOT NULL,
      active INTEGER DEFAULT 1,
      config TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS professionals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id),
      name TEXT NOT NULL,
      whatsapp_phone TEXT,
      specialty TEXT,
      active INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS services (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id),
      name TEXT NOT NULL,
      duration_minutes INTEGER DEFAULT 30,
      price REAL,
      active INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS time_slots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id),
      professional_id INTEGER REFERENCES professionals(id),
      day_of_week INTEGER NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL
    );
  `);

  // ── Original tables ─────────────────────────────────────────────────────────
  database.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL,
      tenant_id INTEGER DEFAULT 1,
      name TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'escalated', 'closed')),
      state TEXT NOT NULL DEFAULT 'GREETING',
      state_data TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL,
      tenant_id INTEGER DEFAULT 1,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
      content TEXT NOT NULL,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS appointments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL,
      tenant_id INTEGER DEFAULT 1,
      phone TEXT NOT NULL,
      name TEXT NOT NULL,
      service TEXT NOT NULL,
      date TEXT NOT NULL,
      time TEXT NOT NULL,
      notes TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'confirmed', 'cancelled', 'pending_professional')),
      reminder_sent INTEGER DEFAULT 0,
      scheduled_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS escalations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL,
      tenant_id INTEGER DEFAULT 1,
      reason TEXT NOT NULL,
      operator_notified INTEGER NOT NULL DEFAULT 0,
      resolved_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_conversations_phone ON conversations(phone);
    CREATE INDEX IF NOT EXISTS idx_conversations_tenant ON conversations(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_appointments_phone ON appointments(phone);
    CREATE INDEX IF NOT EXISTS idx_appointments_status ON appointments(status);
    CREATE INDEX IF NOT EXISTS idx_appointments_tenant ON appointments(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_escalations_conversation ON escalations(conversation_id);
  `);

  // Migrate existing tables: add tenant_id column if missing (SQLite compatible)
  const alterStatements = [
    { table: 'tenants', column: 'evolution_instance', def: 'TEXT' },
    { table: 'conversations', column: 'tenant_id', def: 'INTEGER DEFAULT 1' },
    { table: 'messages', column: 'tenant_id', def: 'INTEGER DEFAULT 1' },
    { table: 'appointments', column: 'tenant_id', def: 'INTEGER DEFAULT 1' },
    { table: 'appointments', column: 'reminder_sent', def: 'INTEGER DEFAULT 0' },
    { table: 'appointments', column: 'scheduled_at', def: 'TEXT' },
    { table: 'escalations', column: 'tenant_id', def: 'INTEGER DEFAULT 1' },
  ];

  for (const stmt of alterStatements) {
    try {
      database.exec(`ALTER TABLE ${stmt.table} ADD COLUMN ${stmt.column} ${stmt.def}`);
    } catch {
      // Column already exists — ignore
    }
  }

  // Also migrate conversations to allow non-unique phone (multi-tenant: same phone on different tenants)
  // SQLite doesn't support DROP UNIQUE easily; we create a new index pattern instead.

  console.log('[Database] Tables created/verified successfully');
}

// ─── Tenant Types & Functions ──────────────────────────────────────────────

export interface TenantConfig {
  welcome_message?: string;
  ai_enabled?: boolean;
  scheduling_enabled?: boolean;
  reminders?: { enabled: boolean; hours_before: number };
  cancellation_policy?: string;
  collect_fields?: string[];
  professional_confirmation_required?: boolean;
  privacy_mode?: boolean;
  forward_message?: string;
}

export interface Tenant {
  id: number;
  slug: string;
  name: string;
  type: 'ai_full' | 'collect_forward';
  whatsapp_phone: string | null;
  evolution_instance: string | null;
  operator_phone: string;
  active: number;
  config: string; // JSON string
}

export interface TenantWithConfig extends Omit<Tenant, 'config'> {
  config: TenantConfig;
}

export function parseTenant(raw: Tenant): TenantWithConfig {
  return {
    ...raw,
    config: JSON.parse(raw.config) as TenantConfig,
  };
}

export function listTenants(): TenantWithConfig[] {
  const database = getDb();
  const rows = database.prepare('SELECT * FROM tenants WHERE active = 1 ORDER BY id ASC').all() as Tenant[];
  return rows.map(parseTenant);
}

export function getTenantById(id: number): TenantWithConfig | undefined {
  const database = getDb();
  const row = database.prepare('SELECT * FROM tenants WHERE id = ?').get(id) as Tenant | undefined;
  return row ? parseTenant(row) : undefined;
}

export function getTenantBySlug(slug: string): TenantWithConfig | undefined {
  const database = getDb();
  const row = database.prepare('SELECT * FROM tenants WHERE slug = ? AND active = 1').get(slug) as Tenant | undefined;
  return row ? parseTenant(row) : undefined;
}

export function getTenantByPhone(phone: string): TenantWithConfig | undefined {
  const database = getDb();
  const row = database.prepare('SELECT * FROM tenants WHERE whatsapp_phone = ? AND active = 1').get(phone) as Tenant | undefined;
  return row ? parseTenant(row) : undefined;
}

export function getTenantByInstance(instance: string): TenantWithConfig | undefined {
  const database = getDb();
  const row = database.prepare('SELECT * FROM tenants WHERE evolution_instance = ? AND active = 1').get(instance) as Tenant | undefined;
  return row ? parseTenant(row) : undefined;
}

// ─── Seed Functions ─────────────────────────────────────────────────────────

export function seedTenants(): void {
  const database = getDb();

  // Barbearia Castilho (ai_full)
  const existing1 = database.prepare("SELECT id FROM tenants WHERE slug = 'barbearia-castilho'").get() as { id: number } | undefined;

  let barberiaId: number;
  if (!existing1) {
    const castilhoConfig: TenantConfig = {
      welcome_message: 'Olá! 👋 Bem-vindo à *Barbearia Castilho*! Sou o assistente virtual e estou aqui para te ajudar. Posso responder suas dúvidas, informar nossos serviços e realizar agendamentos. Como posso te ajudar?',
      ai_enabled: true,
      scheduling_enabled: true,
      reminders: { enabled: true, hours_before: 24 },
      cancellation_policy: 'Cancelamentos devem ser feitos com pelo menos 2 horas de antecedência.',
    };

    const res = database
      .prepare(
        `INSERT INTO tenants (slug, name, type, operator_phone, config)
         VALUES ('barbearia-castilho', 'Barbearia Castilho', 'ai_full', ?, ?)`
      )
      .run(config.OPERATOR_PHONE, JSON.stringify(castilhoConfig));
    barberiaId = res.lastInsertRowid as number;
    console.log('[Seed] Tenant "Barbearia Castilho" created with id:', barberiaId);

    // Professional
    const profRes = database
      .prepare(
        `INSERT INTO professionals (tenant_id, name, specialty, active)
         VALUES (?, 'Castilho', 'Barbeiro', 1)`
      )
      .run(barberiaId);
    const professionalId = profRes.lastInsertRowid as number;

    // Services
    const services = [
      { name: 'Corte', duration_minutes: 45, price: 45.0 },
      { name: 'Barba', duration_minutes: 30, price: 35.0 },
      { name: 'Corte + Barba', duration_minutes: 75, price: 70.0 },
      { name: 'Hidratação', duration_minutes: 30, price: 40.0 },
      { name: 'Sobrancelha', duration_minutes: 15, price: 20.0 },
    ];
    for (const svc of services) {
      database
        .prepare(
          `INSERT INTO services (tenant_id, name, duration_minutes, price, active)
           VALUES (?, ?, ?, ?, 1)`
        )
        .run(barberiaId, svc.name, svc.duration_minutes, svc.price);
    }

    // Time slots: Mon-Sat (1-6), 09:00-19:00
    for (let dow = 1; dow <= 6; dow++) {
      database
        .prepare(
          `INSERT INTO time_slots (tenant_id, professional_id, day_of_week, start_time, end_time)
           VALUES (?, ?, ?, '09:00', '19:00')`
        )
        .run(barberiaId, professionalId, dow);
    }
  } else {
    barberiaId = existing1.id;
  }

  // Psicóloga Prylucki (collect_forward)
  const existing2 = database.prepare("SELECT id FROM tenants WHERE slug = 'psicologa-prylucki'").get() as { id: number } | undefined;

  if (!existing2) {
    const pryluckiConfig: TenantConfig = {
      welcome_message: 'Olá! 🌿 Seja bem-vindo(a)! Sou o assistente da *Psicóloga Prylucki*.\n\nPara agendar uma consulta ou tirar dúvidas, vou precisar de algumas informações. Sua privacidade é nossa prioridade.\n\nVamos começar? Me diga seu *nome completo*.',
      ai_enabled: false,
      collect_fields: ['name', 'contact_preference', 'demand_summary', 'preferred_days', 'preferred_times'],
      professional_confirmation_required: true,
      privacy_mode: true,
      forward_message: '✅ Suas informações foram enviadas para a Psicóloga Prylucki. Em breve ela entrará em contato pelo WhatsApp para confirmar sua consulta. 🌿',
    };

    const res2 = database
      .prepare(
        `INSERT INTO tenants (slug, name, type, operator_phone, config)
         VALUES ('psicologa-prylucki', 'Psicóloga Prylucki', 'collect_forward', ?, ?)`
      )
      .run(config.OPERATOR_PHONE, JSON.stringify(pryluckiConfig));
    const pryluckiId = res2.lastInsertRowid as number;
    console.log('[Seed] Tenant "Psicóloga Prylucki" created with id:', pryluckiId);

    // Professional
    database
      .prepare(
        `INSERT INTO professionals (tenant_id, name, specialty, active)
         VALUES (?, 'Dra. Prylucki', 'Psicóloga', 1)`
      )
      .run(pryluckiId);
  }

  console.log('[Seed] Tenant seed complete. Barbearia id:', barberiaId);
}

// ─── Conversation Functions ────────────────────────────────────────────────

export interface Conversation {
  id: number;
  phone: string;
  tenant_id: number;
  name: string | null;
  status: 'active' | 'escalated' | 'closed';
  state: string;
  state_data: string | null;
  created_at: string;
  updated_at: string;
}

export interface ConversationWithLastMessage extends Conversation {
  last_message: string | null;
  last_message_time: string | null;
  message_count: number;
}

export function getOrCreateConversation(phone: string, tenantId: number): Conversation {
  const database = getDb();

  const existing = database
    .prepare('SELECT * FROM conversations WHERE phone = ? AND tenant_id = ?')
    .get(phone, tenantId) as Conversation | undefined;

  if (existing) {
    database
      .prepare("UPDATE conversations SET updated_at = datetime('now') WHERE id = ?")
      .run(existing.id);
    return existing;
  }

  const result = database
    .prepare(
      "INSERT INTO conversations (phone, tenant_id, status, state) VALUES (?, ?, 'active', 'GREETING')"
    )
    .run(phone, tenantId);

  return database
    .prepare('SELECT * FROM conversations WHERE id = ?')
    .get(result.lastInsertRowid) as Conversation;
}

export function updateConversationState(
  conversationId: number,
  state: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  stateData?: any
): void {
  const database = getDb();
  database
    .prepare(
      "UPDATE conversations SET state = ?, state_data = ?, updated_at = datetime('now') WHERE id = ?"
    )
    .run(state, stateData ? JSON.stringify(stateData) : null, conversationId);
}

export function updateConversationName(conversationId: number, name: string): void {
  const database = getDb();
  database
    .prepare("UPDATE conversations SET name = ?, updated_at = datetime('now') WHERE id = ?")
    .run(name, conversationId);
}

export function updateConversationStatus(
  conversationId: number,
  status: 'active' | 'escalated' | 'closed'
): void {
  const database = getDb();
  database
    .prepare("UPDATE conversations SET status = ?, updated_at = datetime('now') WHERE id = ?")
    .run(status, conversationId);
}

export function listConversations(tenantId?: number): ConversationWithLastMessage[] {
  const database = getDb();
  if (tenantId) {
    return database
      .prepare(
        `SELECT c.*,
          (SELECT content FROM messages WHERE conversation_id = c.id ORDER BY timestamp DESC LIMIT 1) as last_message,
          (SELECT timestamp FROM messages WHERE conversation_id = c.id ORDER BY timestamp DESC LIMIT 1) as last_message_time,
          (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id) as message_count
        FROM conversations c
        WHERE c.tenant_id = ?
        ORDER BY c.updated_at DESC`
      )
      .all(tenantId) as ConversationWithLastMessage[];
  }
  return database
    .prepare(
      `SELECT c.*,
        (SELECT content FROM messages WHERE conversation_id = c.id ORDER BY timestamp DESC LIMIT 1) as last_message,
        (SELECT timestamp FROM messages WHERE conversation_id = c.id ORDER BY timestamp DESC LIMIT 1) as last_message_time,
        (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id) as message_count
      FROM conversations c
      ORDER BY c.updated_at DESC`
    )
    .all() as ConversationWithLastMessage[];
}

export function getConversationById(id: number): Conversation | undefined {
  const database = getDb();
  return database
    .prepare('SELECT * FROM conversations WHERE id = ?')
    .get(id) as Conversation | undefined;
}

// ─── Message Functions ─────────────────────────────────────────────────────

export interface Message {
  id: number;
  conversation_id: number;
  tenant_id: number;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
}

export function addMessage(
  conversationId: number,
  role: 'user' | 'assistant' | 'system',
  content: string,
  tenantId?: number
): void {
  const database = getDb();

  if (tenantId !== undefined) {
    database
      .prepare('INSERT INTO messages (conversation_id, tenant_id, role, content) VALUES (?, ?, ?, ?)')
      .run(conversationId, tenantId, role, content);
  } else {
    database
      .prepare('INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)')
      .run(conversationId, role, content);
  }

  database
    .prepare("UPDATE conversations SET updated_at = datetime('now') WHERE id = ?")
    .run(conversationId);
}

export function getConversationHistory(
  conversationId: number,
  limit = 10
): Array<{ role: 'user' | 'assistant'; content: string }> {
  const database = getDb();
  const messages = database
    .prepare(
      `SELECT role, content FROM messages
       WHERE conversation_id = ? AND role IN ('user', 'assistant')
       ORDER BY timestamp DESC
       LIMIT ?`
    )
    .all(conversationId, limit) as Array<{ role: 'user' | 'assistant'; content: string }>;

  return messages.reverse();
}

export function getConversationMessages(conversationId: number): Message[] {
  const database = getDb();
  return database
    .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY timestamp ASC')
    .all(conversationId) as Message[];
}

// ─── Appointment Functions ─────────────────────────────────────────────────

export interface Appointment {
  id: number;
  conversation_id: number;
  tenant_id: number;
  phone: string;
  name: string;
  service: string;
  date: string;
  time: string;
  notes: string | null;
  status: 'pending' | 'confirmed' | 'cancelled' | 'pending_professional';
  reminder_sent: number;
  scheduled_at: string | null;
  created_at: string;
}

export function createAppointment(data: {
  conversationId: number;
  tenantId: number;
  phone: string;
  name: string;
  service: string;
  date: string;
  time: string;
  notes?: string;
  status?: 'pending' | 'confirmed' | 'cancelled' | 'pending_professional';
  scheduledAt?: string;
}): Appointment {
  const database = getDb();
  const status = data.status ?? 'pending';
  const result = database
    .prepare(
      `INSERT INTO appointments (conversation_id, tenant_id, phone, name, service, date, time, notes, status, scheduled_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      data.conversationId,
      data.tenantId,
      data.phone,
      data.name,
      data.service,
      data.date,
      data.time,
      data.notes ?? null,
      status,
      data.scheduledAt ?? null
    );

  return database
    .prepare('SELECT * FROM appointments WHERE id = ?')
    .get(result.lastInsertRowid) as Appointment;
}

export function listAppointments(status?: string, tenantId?: number): Appointment[] {
  const database = getDb();

  let query = 'SELECT * FROM appointments';
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (status) {
    conditions.push('status = ?');
    params.push(status);
  }
  if (tenantId !== undefined) {
    conditions.push('tenant_id = ?');
    params.push(tenantId);
  }

  if (conditions.length > 0) {
    query += ' WHERE ' + conditions.join(' AND ');
  }
  query += ' ORDER BY date ASC, time ASC';

  return database.prepare(query).all(...params) as Appointment[];
}

export function updateAppointmentStatus(
  id: number,
  status: 'pending' | 'confirmed' | 'cancelled' | 'pending_professional'
): Appointment | undefined {
  const database = getDb();
  database
    .prepare('UPDATE appointments SET status = ? WHERE id = ?')
    .run(status, id);
  return database
    .prepare('SELECT * FROM appointments WHERE id = ?')
    .get(id) as Appointment | undefined;
}

export function markReminderSent(appointmentId: number): void {
  const database = getDb();
  database.prepare('UPDATE appointments SET reminder_sent = 1 WHERE id = ?').run(appointmentId);
}

export function getAppointmentsDueForReminder(): Appointment[] {
  const database = getDb();
  return database
    .prepare(
      `SELECT * FROM appointments
       WHERE scheduled_at IS NOT NULL
         AND reminder_sent = 0
         AND status = 'confirmed'
         AND datetime(scheduled_at) > datetime('now', '+23 hours')
         AND datetime(scheduled_at) <= datetime('now', '+25 hours')`
    )
    .all() as Appointment[];
}

// ─── Escalation Functions ──────────────────────────────────────────────────

export interface Escalation {
  id: number;
  conversation_id: number;
  tenant_id: number;
  reason: string;
  operator_notified: number;
  resolved_at: string | null;
  created_at: string;
}

export function escalateConversation(conversationId: number, reason: string, tenantId?: number): Escalation {
  const database = getDb();

  updateConversationStatus(conversationId, 'escalated');
  updateConversationState(conversationId, 'ESCALATED');

  let result;
  if (tenantId !== undefined) {
    result = database
      .prepare(
        'INSERT INTO escalations (conversation_id, tenant_id, reason) VALUES (?, ?, ?)'
      )
      .run(conversationId, tenantId, reason);
  } else {
    result = database
      .prepare(
        'INSERT INTO escalations (conversation_id, reason) VALUES (?, ?)'
      )
      .run(conversationId, reason);
  }

  return database
    .prepare('SELECT * FROM escalations WHERE id = ?')
    .get(result.lastInsertRowid) as Escalation;
}

export function markEscalationNotified(escalationId: number): void {
  const database = getDb();
  database
    .prepare('UPDATE escalations SET operator_notified = 1 WHERE id = ?')
    .run(escalationId);
}

// ─── Metrics ───────────────────────────────────────────────────────────────

export interface Metrics {
  total_conversations: number;
  active_conversations: number;
  escalated_conversations: number;
  closed_conversations: number;
  total_appointments: number;
  pending_appointments: number;
  confirmed_appointments: number;
  appointments_today: number;
  messages_today: number;
  total_messages: number;
}

export function getMetrics(tenantId?: number): Metrics {
  const database = getDb();

  const tenantFilter = tenantId ? `WHERE tenant_id = ${tenantId}` : '';
  const tenantFilterAnd = tenantId ? `AND tenant_id = ${tenantId}` : '';

  const conversationStats = database
    .prepare(
      `SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active,
        SUM(CASE WHEN status = 'escalated' THEN 1 ELSE 0 END) as escalated,
        SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) as closed
       FROM conversations ${tenantFilter}`
    )
    .get() as { total: number; active: number; escalated: number; closed: number };

  const appointmentStats = database
    .prepare(
      `SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = 'confirmed' THEN 1 ELSE 0 END) as confirmed,
        SUM(CASE WHEN date = date('now') THEN 1 ELSE 0 END) as today
       FROM appointments ${tenantFilter}`
    )
    .get() as { total: number; pending: number; confirmed: number; today: number };

  const messageStats = database
    .prepare(
      `SELECT
        COUNT(*) as total,
        SUM(CASE WHEN date(timestamp) = date('now') THEN 1 ELSE 0 END) as today
       FROM messages
       WHERE role IN ('user', 'assistant') ${tenantFilterAnd}`
    )
    .get() as { total: number; today: number };

  return {
    total_conversations: conversationStats.total || 0,
    active_conversations: conversationStats.active || 0,
    escalated_conversations: conversationStats.escalated || 0,
    closed_conversations: conversationStats.closed || 0,
    total_appointments: appointmentStats.total || 0,
    pending_appointments: appointmentStats.pending || 0,
    confirmed_appointments: appointmentStats.confirmed || 0,
    appointments_today: appointmentStats.today || 0,
    messages_today: messageStats.today || 0,
    total_messages: messageStats.total || 0,
  };
}
