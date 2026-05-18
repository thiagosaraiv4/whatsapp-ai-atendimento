/* ═══════════════════════════════════════
   WhatsApp AI Dashboard - app.js
══════════════════════════════════════ */

'use strict';

// ── State ──────────────────────────────────────────────
let allConversations = [];
let selectedConversationId = null;
let refreshInterval = null;
const REFRESH_INTERVAL_MS = 10000; // 10 seconds

// ── Init ───────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  loadConversations();
  startAutoRefresh();
});

// ── View switching ─────────────────────────────────────
function switchView(view) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

  const viewEl = document.getElementById(`view-${view}`);
  const navEl = document.querySelector(`[data-view="${view}"]`);
  if (viewEl) viewEl.classList.add('active');
  if (navEl) navEl.classList.add('active');

  if (view === 'appointments') loadAppointments();
  if (view === 'metrics') loadMetrics();
  if (view === 'conversations') loadConversations();
}

// ── Auto-refresh ───────────────────────────────────────
function startAutoRefresh() {
  refreshInterval = setInterval(() => {
    const activeView = document.querySelector('.view.active');
    if (!activeView) return;

    const viewId = activeView.id;
    if (viewId === 'view-conversations') loadConversations(true);
    if (viewId === 'view-appointments') loadAppointments(true);
    if (viewId === 'view-metrics') loadMetrics(true);

    animateRefreshDot();
  }, REFRESH_INTERVAL_MS);
}

function animateRefreshDot() {
  const dot = document.getElementById('refreshDot');
  const text = document.getElementById('refreshText');
  if (!dot || !text) return;

  dot.style.background = '#27ae60';
  text.textContent = 'Atualizado';
  setTimeout(() => {
    text.textContent = 'Atualizando em 10s';
  }, 1500);
}

// ── Conversations ──────────────────────────────────────
async function loadConversations(silent = false) {
  if (!silent) {
    document.getElementById('conversationsList').innerHTML = `
      <div class="loading-state">
        <div class="spinner"></div>
        <span>Carregando conversas...</span>
      </div>`;
  }

  try {
    const res = await fetch('/api/conversations');
    const json = await res.json();
    if (!json.success) throw new Error(json.error);

    allConversations = json.data || [];
    renderConversationsList(allConversations);

    // Refresh open chat if needed
    if (selectedConversationId) {
      loadChatMessages(selectedConversationId, true);
    }
  } catch (err) {
    console.error('[App] Failed to load conversations:', err);
    if (!silent) {
      document.getElementById('conversationsList').innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">⚠️</div>
          <p>Erro ao carregar conversas</p>
        </div>`;
    }
  }
}

function renderConversationsList(conversations) {
  const list = document.getElementById('conversationsList');
  const search = (document.getElementById('searchInput')?.value || '').toLowerCase();
  const statusFilter = document.getElementById('statusFilter')?.value || '';

  const filtered = conversations.filter(c => {
    const matchSearch = !search ||
      (c.phone && c.phone.toLowerCase().includes(search)) ||
      (c.name && c.name.toLowerCase().includes(search));
    const matchStatus = !statusFilter || c.status === statusFilter;
    return matchSearch && matchStatus;
  });

  if (filtered.length === 0) {
    list.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">💬</div>
        <p>${allConversations.length === 0 ? 'Nenhuma conversa ainda' : 'Nenhum resultado encontrado'}</p>
      </div>`;
    return;
  }

  list.innerHTML = filtered.map(c => {
    const initials = getInitials(c.name, c.phone);
    const timeStr = formatTime(c.last_message_time || c.updated_at);
    const preview = c.last_message ? truncate(c.last_message, 55) : 'Sem mensagens';
    const isSelected = c.id === selectedConversationId;

    return `
      <div class="conversation-item ${isSelected ? 'selected' : ''}" onclick="selectConversation(${c.id})">
        <div class="conv-avatar">${initials}</div>
        <div class="conv-info">
          <div class="conv-top">
            <span class="conv-name">${escHtml(c.name || formatPhone(c.phone))}</span>
            <span class="conv-time">${timeStr}</span>
          </div>
          <div class="conv-preview">
            <span class="conv-status-dot ${c.status}"></span>
            ${escHtml(preview)}
          </div>
        </div>
      </div>`;
  }).join('');
}

function filterConversations() {
  renderConversationsList(allConversations);
}

async function selectConversation(id) {
  selectedConversationId = id;

  // Update selected state in list
  document.querySelectorAll('.conversation-item').forEach(el => el.classList.remove('selected'));
  const items = document.querySelectorAll('.conversation-item');
  items.forEach(item => {
    if (item.onclick?.toString().includes(`(${id})`)) {
      item.classList.add('selected');
    }
  });

  // Re-render list to show selection properly
  renderConversationsList(allConversations);

  // Load messages
  await loadChatMessages(id, false);
}

async function loadChatMessages(id, silent = false) {
  const chatEmpty = document.getElementById('chatEmpty');
  const chatView = document.getElementById('chatView');

  if (!silent) {
    chatEmpty.style.display = 'none';
    chatView.style.display = 'flex';
    document.getElementById('chatMessages').innerHTML = `
      <div class="loading-state" style="margin:auto;">
        <div class="spinner"></div>
        <span>Carregando mensagens...</span>
      </div>`;
  }

  try {
    const res = await fetch(`/api/conversations/${id}/messages`);
    const json = await res.json();
    if (!json.success) throw new Error(json.error);

    const { conversation, messages } = json.data;

    // Update header
    const name = conversation.name || formatPhone(conversation.phone);
    document.getElementById('contactName').textContent = name;
    document.getElementById('contactPhone').textContent = formatPhone(conversation.phone);
    document.getElementById('contactAvatar').textContent = getInitials(conversation.name, conversation.phone);
    document.getElementById('chatStatusBadge').innerHTML = `<span class="badge badge-${conversation.status}">${statusLabel(conversation.status)}</span>`;

    chatEmpty.style.display = 'none';
    chatView.style.display = 'flex';

    // Update action buttons based on status
    const btnEscalate = document.getElementById('btnEscalate');
    const btnClose = document.getElementById('btnClose');
    const btnReopen = document.getElementById('btnReopen');

    if (conversation.status === 'closed' || conversation.status === 'escalated') {
      btnEscalate.style.display = 'none';
      btnClose.style.display = 'none';
      btnReopen.style.display = 'inline-flex';
    } else {
      btnEscalate.style.display = 'inline-flex';
      btnClose.style.display = 'inline-flex';
      btnReopen.style.display = 'none';
    }

    // Render messages
    const container = document.getElementById('chatMessages');
    if (messages.length === 0) {
      container.innerHTML = `<div class="empty-state" style="margin:auto;"><p>Sem mensagens</p></div>`;
      return;
    }

    container.innerHTML = messages.map(m => {
      const senderLabel = m.role === 'user' ? '👤 Usuário' : m.role === 'assistant' ? '🤖 IA' : '⚙️ Sistema';
      return `
        <div class="message-bubble ${m.role}">
          ${m.role !== 'user' ? `<span class="bubble-sender">${senderLabel}</span>` : ''}
          <div class="bubble-content">${escHtml(m.content)}</div>
          <span class="bubble-time">${formatDateTime(m.timestamp)}</span>
        </div>`;
    }).join('');

    // Scroll to bottom
    container.scrollTop = container.scrollHeight;

  } catch (err) {
    console.error('[App] Failed to load messages:', err);
    if (!silent) {
      document.getElementById('chatMessages').innerHTML = `
        <div class="empty-state" style="margin:auto;">
          <div class="empty-state-icon">⚠️</div>
          <p>Erro ao carregar mensagens</p>
        </div>`;
    }
  }
}

// ── Conversation Actions ───────────────────────────────
function escalateConversation() {
  if (!selectedConversationId) return;
  document.getElementById('escalateReason').value = '';
  document.getElementById('escalateModal').style.display = 'flex';
}

async function confirmEscalate() {
  if (!selectedConversationId) return;
  const reason = document.getElementById('escalateReason').value.trim() || 'Escalonamento manual pelo operador';

  try {
    const res = await fetch(`/api/conversations/${selectedConversationId}/escalate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason }),
    });
    const json = await res.json();
    if (!json.success) throw new Error(json.error);

    closeModal('escalateModal');
    showToast('Conversa escalonada com sucesso!', 'success');
    await loadConversations();
    await loadChatMessages(selectedConversationId);
  } catch (err) {
    showToast(`Erro: ${err.message}`, 'error');
  }
}

async function closeConversation() {
  if (!selectedConversationId) return;
  if (!confirm('Fechar esta conversa?')) return;

  try {
    const res = await fetch(`/api/conversations/${selectedConversationId}/close`, {
      method: 'POST',
    });
    const json = await res.json();
    if (!json.success) throw new Error(json.error);

    showToast('Conversa fechada.', 'success');
    await loadConversations();
    await loadChatMessages(selectedConversationId);
  } catch (err) {
    showToast(`Erro: ${err.message}`, 'error');
  }
}

async function reopenConversation() {
  if (!selectedConversationId) return;

  try {
    const res = await fetch(`/api/conversations/${selectedConversationId}/reopen`, {
      method: 'POST',
    });
    const json = await res.json();
    if (!json.success) throw new Error(json.error);

    showToast('Conversa reaberta!', 'success');
    await loadConversations();
    await loadChatMessages(selectedConversationId);
  } catch (err) {
    showToast(`Erro: ${err.message}`, 'error');
  }
}

// ── Appointments ───────────────────────────────────────
async function loadAppointments(silent = false) {
  const filter = document.getElementById('appointmentFilter')?.value || '';
  const container = document.getElementById('appointmentsContainer');

  if (!silent) {
    container.innerHTML = `
      <div class="loading-state">
        <div class="spinner"></div>
        <span>Carregando agendamentos...</span>
      </div>`;
  }

  try {
    const url = filter ? `/api/appointments?status=${filter}` : '/api/appointments';
    const res = await fetch(url);
    const json = await res.json();
    if (!json.success) throw new Error(json.error);

    const appointments = json.data || [];

    if (appointments.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">📅</div>
          <p>Nenhum agendamento encontrado</p>
        </div>`;
      return;
    }

    container.innerHTML = `
      <div class="appointments-table-wrap">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Cliente</th>
              <th>WhatsApp</th>
              <th>Serviço</th>
              <th>Data</th>
              <th>Horário</th>
              <th>Observações</th>
              <th>Status</th>
              <th>Ações</th>
            </tr>
          </thead>
          <tbody>
            ${appointments.map(a => `
              <tr>
                <td>${a.id}</td>
                <td>${escHtml(a.name)}</td>
                <td>${formatPhone(a.phone)}</td>
                <td>${escHtml(a.service)}</td>
                <td>${escHtml(a.date)}</td>
                <td>${escHtml(a.time)}</td>
                <td>${escHtml(a.notes || '—')}</td>
                <td><span class="badge badge-${a.status}">${appointmentStatusLabel(a.status)}</span></td>
                <td>
                  <div class="table-actions">
                    ${a.status === 'pending' ? `
                      <button class="btn btn-sm btn-success" onclick="updateAppointment(${a.id}, 'confirmed')">✓ Confirmar</button>
                      <button class="btn btn-sm btn-danger" onclick="updateAppointment(${a.id}, 'cancelled')">✕ Cancelar</button>
                    ` : a.status === 'confirmed' ? `
                      <button class="btn btn-sm btn-danger" onclick="updateAppointment(${a.id}, 'cancelled')">✕ Cancelar</button>
                    ` : `
                      <button class="btn btn-sm btn-outline" onclick="updateAppointment(${a.id}, 'pending')">↩ Reabrir</button>
                    `}
                  </div>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>`;
  } catch (err) {
    console.error('[App] Failed to load appointments:', err);
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">⚠️</div>
        <p>Erro ao carregar agendamentos</p>
      </div>`;
  }
}

async function updateAppointment(id, status) {
  const labels = { confirmed: 'confirmar', cancelled: 'cancelar', pending: 'reabrir' };
  if (!confirm(`Deseja ${labels[status] || 'atualizar'} este agendamento?`)) return;

  try {
    const res = await fetch(`/api/appointments/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    const json = await res.json();
    if (!json.success) throw new Error(json.error);

    showToast('Agendamento atualizado!', 'success');
    loadAppointments();
  } catch (err) {
    showToast(`Erro: ${err.message}`, 'error');
  }
}

// ── Metrics ────────────────────────────────────────────
async function loadMetrics(silent = false) {
  const grid = document.getElementById('metricsGrid');
  if (!silent) {
    grid.innerHTML = `
      <div class="loading-state full-width">
        <div class="spinner"></div>
        <span>Carregando métricas...</span>
      </div>`;
  }

  try {
    const res = await fetch('/api/metrics');
    const json = await res.json();
    if (!json.success) throw new Error(json.error);

    const m = json.data;

    const cards = [
      { icon: '💬', value: m.total_conversations, label: 'Total de Conversas', color: 'blue' },
      { icon: '🟢', value: m.active_conversations, label: 'Conversas Ativas', color: 'green' },
      { icon: '⚡', value: m.escalated_conversations, label: 'Escalonadas', color: 'orange' },
      { icon: '✅', value: m.closed_conversations, label: 'Encerradas', color: '' },
      { icon: '📅', value: m.total_appointments, label: 'Total de Agendamentos', color: 'blue' },
      { icon: '⏳', value: m.pending_appointments, label: 'Agendamentos Pendentes', color: 'orange' },
      { icon: '✔️', value: m.confirmed_appointments, label: 'Agendamentos Confirmados', color: 'green' },
      { icon: '📆', value: m.appointments_today, label: 'Agendamentos Hoje', color: 'blue' },
      { icon: '📨', value: m.messages_today, label: 'Mensagens Hoje', color: 'blue' },
      { icon: '📬', value: m.total_messages, label: 'Total de Mensagens', color: '' },
    ];

    grid.innerHTML = cards.map(c => `
      <div class="metric-card ${c.color}">
        <div class="metric-icon">${c.icon}</div>
        <div class="metric-value">${c.value ?? 0}</div>
        <div class="metric-label">${c.label}</div>
      </div>
    `).join('');
  } catch (err) {
    console.error('[App] Failed to load metrics:', err);
    grid.innerHTML = `
      <div class="empty-state full-width">
        <div class="empty-state-icon">⚠️</div>
        <p>Erro ao carregar métricas</p>
      </div>`;
  }
}

// ── Modal helpers ──────────────────────────────────────
function closeModal(id) {
  const el = document.getElementById(id);
  if (el) el.style.display = 'none';
}

// ── Toast ──────────────────────────────────────────────
let toastTimeout = null;
function showToast(msg, type = '') {
  const toast = document.getElementById('toast');
  if (!toast) return;

  toast.textContent = msg;
  toast.className = `toast ${type} show`;

  if (toastTimeout) clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => {
    toast.classList.remove('show');
  }, 3500);
}

// ── Utility helpers ────────────────────────────────────
function escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function truncate(str, len) {
  if (!str) return '';
  return str.length > len ? str.substring(0, len) + '...' : str;
}

function formatPhone(phone) {
  if (!phone) return '—';
  const d = phone.replace(/\D/g, '');
  if (d.length === 13) return `+${d.substring(0,2)} (${d.substring(2,4)}) ${d.substring(4,9)}-${d.substring(9)}`;
  if (d.length === 12) return `+${d.substring(0,2)} (${d.substring(2,4)}) ${d.substring(4,8)}-${d.substring(8)}`;
  return phone;
}

function getInitials(name, phone) {
  if (name && name.trim()) {
    const parts = name.trim().split(' ');
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return parts[0][0].toUpperCase();
  }
  if (phone) {
    const d = phone.replace(/\D/g, '');
    return d.slice(-2);
  }
  return '?';
}

function formatTime(dateStr) {
  if (!dateStr) return '';
  try {
    const d = new Date(dateStr.includes('T') ? dateStr : dateStr.replace(' ', 'T') + 'Z');
    const now = new Date();
    const diffMs = now - d;
    const diffMin = Math.floor(diffMs / 60000);

    if (diffMin < 1) return 'agora';
    if (diffMin < 60) return `${diffMin}min`;
    const diffH = Math.floor(diffMin / 60);
    if (diffH < 24) return `${diffH}h`;
    return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
  } catch {
    return dateStr;
  }
}

function formatDateTime(dateStr) {
  if (!dateStr) return '';
  try {
    const d = new Date(dateStr.includes('T') ? dateStr : dateStr.replace(' ', 'T') + 'Z');
    return d.toLocaleString('pt-BR', {
      day: '2-digit', month: '2-digit', year: '2-digit',
      hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return dateStr;
  }
}

function statusLabel(status) {
  const labels = { active: 'Ativo', escalated: 'Escalonado', closed: 'Fechado' };
  return labels[status] || status;
}

function appointmentStatusLabel(status) {
  const labels = { pending: 'Pendente', confirmed: 'Confirmado', cancelled: 'Cancelado' };
  return labels[status] || status;
}
