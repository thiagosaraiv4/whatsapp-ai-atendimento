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

  database.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL UNIQUE,
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
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
      content TEXT NOT NULL,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS appointments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL,
      phone TEXT NOT NULL,
      name TEXT NOT NULL,
      service TEXT NOT NULL,
      date TEXT NOT NULL,
      time TEXT NOT NULL,
      notes TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'confirmed', 'cancelled')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS escalations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL,
      reason TEXT NOT NULL,
      operator_notified INTEGER NOT NULL DEFAULT 0,
      resolved_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_conversations_phone ON conversations(phone);
    CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_appointments_phone ON appointments(phone);
    CREATE INDEX IF NOT EXISTS idx_appointments_status ON appointments(status);
    CREATE INDEX IF NOT EXISTS idx_escalations_conversation ON escalations(conversation_id);
  `);

  console.log('[Database] Tables created/verified successfully');
}

// ─── Conversation Functions ────────────────────────────────────────────────

export interface Conversation {
  id: number;
  phone: string;
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

export function getOrCreateConversation(phone: string): Conversation {
  const database = getDb();

  const existing = database
    .prepare('SELECT * FROM conversations WHERE phone = ?')
    .get(phone) as Conversation | undefined;

  if (existing) {
    database
      .prepare("UPDATE conversations SET updated_at = datetime('now') WHERE id = ?")
      .run(existing.id);
    return existing;
  }

  const result = database
    .prepare(
      "INSERT INTO conversations (phone, status, state) VALUES (?, 'active', 'GREETING')"
    )
    .run(phone);

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

export function listConversations(): ConversationWithLastMessage[] {
  const database = getDb();
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
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
}

export function addMessage(
  conversationId: number,
  role: 'user' | 'assistant' | 'system',
  content: string
): void {
  const database = getDb();
  database
    .prepare('INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)')
    .run(conversationId, role, content);

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
  phone: string;
  name: string;
  service: string;
  date: string;
  time: string;
  notes: string | null;
  status: 'pending' | 'confirmed' | 'cancelled';
  created_at: string;
}

export function createAppointment(data: {
  conversationId: number;
  phone: string;
  name: string;
  service: string;
  date: string;
  time: string;
  notes?: string;
}): Appointment {
  const database = getDb();
  const result = database
    .prepare(
      `INSERT INTO appointments (conversation_id, phone, name, service, date, time, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      data.conversationId,
      data.phone,
      data.name,
      data.service,
      data.date,
      data.time,
      data.notes ?? null
    );

  return database
    .prepare('SELECT * FROM appointments WHERE id = ?')
    .get(result.lastInsertRowid) as Appointment;
}

export function listAppointments(status?: string): Appointment[] {
  const database = getDb();
  if (status) {
    return database
      .prepare('SELECT * FROM appointments WHERE status = ? ORDER BY date ASC, time ASC')
      .all(status) as Appointment[];
  }
  return database
    .prepare('SELECT * FROM appointments ORDER BY date ASC, time ASC')
    .all() as Appointment[];
}

export function updateAppointmentStatus(
  id: number,
  status: 'pending' | 'confirmed' | 'cancelled'
): Appointment | undefined {
  const database = getDb();
  database
    .prepare('UPDATE appointments SET status = ? WHERE id = ?')
    .run(status, id);
  return database
    .prepare('SELECT * FROM appointments WHERE id = ?')
    .get(id) as Appointment | undefined;
}

// ─── Escalation Functions ──────────────────────────────────────────────────

export interface Escalation {
  id: number;
  conversation_id: number;
  reason: string;
  operator_notified: number;
  resolved_at: string | null;
  created_at: string;
}

export function escalateConversation(conversationId: number, reason: string): Escalation {
  const database = getDb();

  updateConversationStatus(conversationId, 'escalated');
  updateConversationState(conversationId, 'ESCALATED');

  const result = database
    .prepare(
      'INSERT INTO escalations (conversation_id, reason) VALUES (?, ?)'
    )
    .run(conversationId, reason);

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

export function getMetrics(): Metrics {
  const database = getDb();

  const conversationStats = database
    .prepare(
      `SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active,
        SUM(CASE WHEN status = 'escalated' THEN 1 ELSE 0 END) as escalated,
        SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) as closed
       FROM conversations`
    )
    .get() as { total: number; active: number; escalated: number; closed: number };

  const appointmentStats = database
    .prepare(
      `SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = 'confirmed' THEN 1 ELSE 0 END) as confirmed,
        SUM(CASE WHEN date = date('now') THEN 1 ELSE 0 END) as today
       FROM appointments`
    )
    .get() as { total: number; pending: number; confirmed: number; today: number };

  const messageStats = database
    .prepare(
      `SELECT
        COUNT(*) as total,
        SUM(CASE WHEN date(timestamp) = date('now') THEN 1 ELSE 0 END) as today
       FROM messages`
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
