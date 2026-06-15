/**
 * tickets.js — Módulo de Vista y Gestión de Tickets
 * ==================================================
 * Responsable de:
 *   - Renderizar la vista individual de un programador con su tabla de tickets
 *   - Gestionar el cambio de estado de tickets (select interactivo)
 *   - Edición inline de campos de texto (N° Ticket, Descripción, Proyecto, Notas)
 *   - Filtrado y búsqueda en tiempo real dentro de la tabla
 *   - Actualizar el anillo SVG de efectividad del programador
 */

const Tickets = (() => {

  // Estado interno de la vista actual
  let currentProgrammer = null;
  let currentTickets = [];
  let activeFilter = 'all';
  let searchQuery = '';
  let currentTicketIdForNotes = null;
  let notesModalSetup = false;
  let readOnly = false;

  // ----------------------------------------------------------------
  // HELPERS
  // ----------------------------------------------------------------

  /**
   * Retorna la clase CSS para el badge de estado.
   * @param {string} status
   * @returns {string}
   */
  function statusClass(status) {
    switch (status) {
      case 'Solventado':  return 'status-badge--solventado';
      case 'En proceso':  return 'status-badge--proceso';
      case 'No Aplica':   return 'status-badge--noaplica';
      default:            return 'status-badge--noresuelto';
    }
  }

  /**
   * Genera las iniciales para el avatar.
   * @param {string} name
   * @returns {string}
   */
  function getInitials(name) {
    return name.split(' ')
      .map(w => w.charAt(0).toUpperCase())
      .slice(0, 2)
      .join('');
  }

  /**
   * Escapa HTML para evitar XSS al mostrar contenido de los tickets.
   * @param {string} str
   * @returns {string}
   */
  function escHtml(str) {
    const div = document.createElement('div');
    div.textContent = String(str ?? '');
    return div.innerHTML;
  }

  // ----------------------------------------------------------------
  // RING DE EFECTIVIDAD
  // ----------------------------------------------------------------

  /**
   * Actualiza el anillo SVG de efectividad con animación.
   * Circunferencia del círculo (r=50): 2π×50 ≈ 314
   * @param {number} pct - Porcentaje de efectividad (0-100)
   */
  function updateRing(pct) {
    const CIRCUMFERENCE = 314;
    const ring = document.getElementById('ring-fill');
    const label = document.getElementById('ring-label');
    if (!ring || !label) return;

    const offset = CIRCUMFERENCE - (pct / 100) * CIRCUMFERENCE;

    // Asignar color según efectividad
    let color = '#ef4444';
    if (pct >= 75) color = '#10b981';
    else if (pct >= 40) color = '#f59e0b';

    ring.style.stroke = color;
    ring.style.filter = `drop-shadow(0 0 6px ${color}80)`;

    // Animar el offset
    setTimeout(() => {
      ring.style.strokeDashoffset = offset;
    }, 50);

    label.innerHTML = `<strong>${pct}%</strong><small>efectividad</small>`;
  }

  // ----------------------------------------------------------------
  // EDICIÓN INLINE
  // ----------------------------------------------------------------

  /**
   * Convierte una celda de texto en un input editable.
   * @param {HTMLElement} cell - La <td> que se editará
   * @param {string} ticketId - ID del ticket
   * @param {string} field - Campo a editar ('ticket','description','project','notes')
   * @param {string} currentValue - Valor actual del campo
   */
  function makeEditable(cell, ticketId, field, currentValue) {
    if (cell.dataset.editing === 'true') return; // Evitar doble edición
    cell.dataset.editing = 'true';

    const input = document.createElement('input');
    input.type = 'text';
    input.value = currentValue;
    input.className = 'editable-input';
    input.setAttribute('aria-label', `Editar ${field}`);

    const originalContent = cell.innerHTML;
    cell.innerHTML = '';
    cell.appendChild(input);
    input.focus();
    input.select();

    /**
     * Guarda el cambio y restaura la celda.
     */
    function saveEdit() {
      const newValue = input.value.trim();
      cell.dataset.editing = 'false';

      // Actualizar en el estado local y en localStorage
      const ticket = currentTickets.find(t => t.id === ticketId);
      if (ticket && newValue !== ticket[field]) {
        ticket[field] = newValue;
        Storage.updateTicketField(currentProgrammer, ticketId, field, newValue);
        UI.showToast(`Campo actualizado correctamente`, 'success');
      }

      // Restaurar celda con nuevo valor
      cell.innerHTML = `<span class="editable-field" title="Clic para editar">${escHtml(newValue || '—')}</span>`;
      attachEditListeners(cell, ticketId, field, newValue);
    }

    function cancelEdit() {
      cell.dataset.editing = 'false';
      cell.innerHTML = originalContent;
      attachEditListeners(cell, ticketId, field, currentValue);
    }

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') saveEdit();
      if (e.key === 'Escape') cancelEdit();
    });

    input.addEventListener('blur', saveEdit);
  }

  /**
   * Agrega el listener de clic para activar la edición inline.
   */
  function attachEditListeners(cell, ticketId, field, value) {
    const span = cell.querySelector('.editable-field');
    if (span) {
      span.addEventListener('click', () => makeEditable(cell, ticketId, field, value));
      span.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          makeEditable(cell, ticketId, field, value);
        }
      });
    }
  }

  // ----------------------------------------------------------------
  // FILTROS Y BÚSQUEDA
  // ----------------------------------------------------------------

  /**
   * Retorna los tickets filtrados según el filtro activo y la búsqueda.
   * @returns {Array}
   */
  function getFilteredTickets() {
    return currentTickets.filter(t => {
      // Filtro por estado
      const statusOk = activeFilter === 'all' || t.status === activeFilter;

      // Filtro por búsqueda (en todos los campos de texto)
      const query = searchQuery.toLowerCase();
      const searchOk = !query || [t.ticket, t.description, t.project, t.notes, t.status]
        .some(val => String(val).toLowerCase().includes(query));

      return statusOk && searchOk;
    });
  }

  /**
   * Configura los botones de filtro y el input de búsqueda.
   */
  function setupFilters() {
    // Botones de filtro
    document.querySelectorAll('.filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        activeFilter = btn.dataset.filter;
        renderTicketsTable();
      });
    });

    // Input de búsqueda
    const searchInput = document.getElementById('ticket-search');
    if (searchInput) {
      searchInput.value = '';
      searchInput.addEventListener('input', (e) => {
        searchQuery = e.target.value;
        renderTicketsTable();
      });
    }
  }

  // ----------------------------------------------------------------
  // TABLA DE TICKETS
  // ----------------------------------------------------------------

  /**
   * Renderiza (o vuelve a renderizar) la tabla de tickets con los filtros aplicados.
   */
  function renderTicketsTable() {
    const tbody = document.getElementById('tickets-tbody');
    if (!tbody) return;

    const filtered = getFilteredTickets();

    if (filtered.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6">
        <div class="empty-state">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/>
          </svg>
          <p>No se encontraron tickets con los filtros actuales</p>
        </div>
      </td></tr>`;
      return;
    }

    tbody.innerHTML = filtered.map((ticket, rowIdx) => {
      const sClass = statusClass(ticket.status);
      const statusBadge = readOnly
        ? `<span class="status-badge status-badge--${sClass}">${escHtml(ticket.status)}</span>`
        : `<select class="status-select" data-ticket-id="${ticket.id}" aria-label="Estado del ticket ${ticket.ticket}">
            <option value="No resuelto"  ${ticket.status === 'No resuelto'  ? 'selected' : ''}>No resuelto</option>
            <option value="En proceso"   ${ticket.status === 'En proceso'   ? 'selected' : ''}>En proceso</option>
            <option value="Solventado"   ${ticket.status === 'Solventado'   ? 'selected' : ''}>Solventado</option>
            <option value="No Aplica"    ${ticket.status === 'No Aplica'    ? 'selected' : ''}>No Aplica</option>
           </select>`;
      const editTitle = readOnly ? '' : 'title="Clic para editar"';
      const actionsCell = readOnly ? ''
        : `<td>
            <div class="td-actions">
              <button
                class="btn btn--ghost btn--icon btn--sm"
                title="Editar ticket"
                onclick="Tickets.startEditRow('${ticket.id}')">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" width="14" height="14">
                  <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
                  <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
                </svg>
              </button>
            </div>
          </td>`;
      const notesOpenBtn = readOnly ? ''
        : `<button class="notes-open-btn ${ticket.notes ? 'has-content' : ''}"
                  onclick="Tickets.openNotesModal('${ticket.id}')"
                  aria-label="Editar notas" title="Editar notas">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" width="14" height="14">
              <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
              <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
            </svg>
          </button>`;
      return `
        <tr id="row-${ticket.id}" class="ticket-row" data-id="${ticket.id}">
          <td class="td-ticket" data-field="ticket" data-id="${ticket.id}">
            <span class="editable-field" ${editTitle} tabindex="0">
              ${escHtml(ticket.ticket || '—')}
            </span>
          </td>
          <td class="td-description" data-field="description" data-id="${ticket.id}">
            <span class="editable-field" ${editTitle} tabindex="0">
              ${escHtml(ticket.description || '—')}
            </span>
          </td>
          <td class="td-project" data-field="project" data-id="${ticket.id}">
            <span class="editable-field" ${editTitle} tabindex="0">
              ${escHtml(ticket.project || '—')}
            </span>
          </td>
          <td class="td-notes" data-field="notes" data-id="${ticket.id}">
            <div class="td-notes-cell">
              <span class="notes-preview ${ticket.notes ? '' : 'notes-preview--empty'}"
                    ${readOnly ? '' : 'onclick="Tickets.openNotesModal(\'' + ticket.id + '\')"'}
                    title="${readOnly ? 'Ver notas' : 'Clic para abrir notas'}" tabindex="0">
                ${escHtml(ticket.notes ? (ticket.notes.length > 80 ? ticket.notes.substring(0, 80) + '...' : ticket.notes) : 'Sin notas')}
              </span>
              ${notesOpenBtn}
            </div>
          </td>
          <td>${statusBadge}</td>
          ${actionsCell}
        </tr>
      `;
    }).join('');

    // En modo solo lectura no se adjuntan listeners de edición ni cambio de estado
    if (readOnly) return;

    // Attach listeners de edición inline a todas las celdas editables
    filtered.forEach(ticket => {
      ['ticket', 'description', 'project'].forEach(field => {
        const td = tbody.querySelector(`td.td-${field}[data-id="${ticket.id}"]`);
        if (td) {
          attachEditListeners(td, ticket.id, field, ticket[field] || '');
        }
      });
    });

    // Listeners de cambio de estado
    tbody.querySelectorAll('.status-select').forEach(select => {
      select.addEventListener('change', (e) => {
        const ticketId = e.target.dataset.ticketId;
        const newStatus = e.target.value;
        handleStatusChange(ticketId, newStatus);
      });
    });
  }

  /**
   * Maneja el cambio de estado de un ticket.
   * Actualiza localStorage, el estado local y refresca la efectividad.
   * @param {string} ticketId
   * @param {string} newStatus
   */
  function handleStatusChange(ticketId, newStatus) {
    if (readOnly) return;
    const ticket = currentTickets.find(t => t.id === ticketId);
    if (!ticket) return;

    const oldStatus = ticket.status;
    ticket.status = newStatus;

    const ok = Storage.updateTicketStatus(currentProgrammer, ticketId, newStatus);

    if (ok) {
      // Actualizar el anillo de efectividad sin re-renderizar toda la tabla
      const stats = Dashboard.calcStats(currentTickets);
      updateRing(stats.pct);

      // Actualizar el subtítulo
      const subtitle = document.getElementById('prog-subtitle');
      if (subtitle) {
        subtitle.textContent = `${stats.total} tickets · ${stats.solved} solventados · ${stats.noAplica} no aplica · ${stats.inProgress} en proceso · ${stats.unsolved} sin resolver`;
      }

      // Actualizar badge en sidebar
      updateSidebarBadge(currentProgrammer, stats.pct);

      UI.showToast(`Estado actualizado: ${newStatus}`, 'success');
    } else {
      ticket.status = oldStatus; // Revertir
      UI.showToast('Error al guardar el estado. Inténtalo de nuevo.', 'error');
    }
  }

  /**
   * Actualiza el badge de efectividad de un programador en la barra lateral.
   * @param {string} name
   * @param {number} pct
   */
  function updateSidebarBadge(name, pct) {
    const theme = Dashboard.effectivenessTheme(pct);
    const btn = document.querySelector(`#nav-programmers .nav-item[data-programmer="${name}"]`);
    if (btn) {
      const badge = btn.querySelector('.effectiveness-badge');
      if (badge) {
        badge.textContent = `${pct}%`;
        badge.className = `effectiveness-badge ${theme.cssClass}`;
      }
    }
  }

  // ----------------------------------------------------------------
  // MODAL DE NOTAS
  // ----------------------------------------------------------------

  function setupNotesModalEvents() {
    if (notesModalSetup) return;
    notesModalSetup = true;

    const modal = document.getElementById('notes-modal');
    const textarea = document.getElementById('notes-textarea');
    const saveBtn = document.getElementById('notes-modal-save');
    const cancelBtn = document.getElementById('notes-modal-cancel');
    const clearBtn = document.getElementById('notes-modal-clear');
    const closeBtn = document.getElementById('notes-modal-close');

    saveBtn?.addEventListener('click', saveNotesChanges);
    cancelBtn?.addEventListener('click', closeNotesModal);
    closeBtn?.addEventListener('click', closeNotesModal);
    clearBtn?.addEventListener('click', () => {
      if (textarea) textarea.value = '';
      updateNotesCharCount();
      textarea?.focus();
    });

    modal?.addEventListener('mousedown', (e) => {
      if (e.target === modal) closeNotesModal();
    });

    textarea?.addEventListener('input', updateNotesCharCount);

    textarea?.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeNotesModal();
      }
      if (e.key === 'Enter' && e.ctrlKey) {
        e.preventDefault();
        saveNotesChanges();
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !document.getElementById('notes-modal')?.classList.contains('hidden')) {
        closeNotesModal();
      }
    });
  }

  function openNotesModal(ticketId) {
    const ticket = currentTickets.find(t => t.id === ticketId);
    if (!ticket) return;

    currentTicketIdForNotes = ticketId;
    setupNotesModalEvents();

    document.getElementById('notes-modal-title').textContent = `Notas del Ticket ${ticket.ticket}`;
    document.getElementById('notes-modal-subtitle').textContent = `${ticket.description || 'Sin descripción'} · ${ticket.project || 'Sin proyecto'}`;

    const meta = document.getElementById('notes-modal-meta');
    meta.innerHTML = `
      <span class="notes-meta-chip">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/></svg>
        ${escHtml(ticket.ticket || '—')}
      </span>
      <span class="notes-meta-chip">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/></svg>
        ${escHtml(ticket.project || '—')}
      </span>
      <span class="notes-meta-chip">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg>
        ${escHtml(ticket.status || '—')}
      </span>
    `;

    const textarea = document.getElementById('notes-textarea');
    textarea.value = ticket.notes || '';
    updateNotesCharCount();

    if (readOnly) {
      textarea.disabled = true;
      document.getElementById('notes-modal-save').style.display = 'none';
      document.getElementById('notes-modal-clear').style.display = 'none';
      document.getElementById('notes-char-count').style.display = 'none';
    } else {
      textarea.disabled = false;
      document.getElementById('notes-modal-save').style.display = '';
      document.getElementById('notes-modal-clear').style.display = '';
      document.getElementById('notes-char-count').style.display = '';
    }

    const modal = document.getElementById('notes-modal');
    modal.classList.remove('hidden');
    modal.classList.add('active');

    if (!readOnly) setTimeout(() => textarea?.focus(), 100);
  }

  function closeNotesModal() {
    const modal = document.getElementById('notes-modal');
    modal.classList.add('hidden');
    modal.classList.remove('active');
    currentTicketIdForNotes = null;
  }

  function saveNotesChanges() {
    if (!currentTicketIdForNotes || readOnly) return;

    const textarea = document.getElementById('notes-textarea');
    const newValue = textarea.value.trim();
    const ticket = currentTickets.find(t => t.id === currentTicketIdForNotes);

    if (ticket && newValue !== ticket.notes) {
      ticket.notes = newValue;
      Storage.updateTicketField(currentProgrammer, currentTicketIdForNotes, 'notes', newValue);
      UI.showToast('Notas guardadas correctamente', 'success');

      renderTicketsTable();
    }

    closeNotesModal();
  }

  function updateNotesCharCount() {
    const textarea = document.getElementById('notes-textarea');
    const counter = document.getElementById('notes-char-count');
    if (textarea && counter) {
      counter.textContent = textarea.value.length;
    }
  }

  // ----------------------------------------------------------------
  // MODAL NUEVO TICKET
  // ----------------------------------------------------------------

  let addTicketModalSetup = false;

  function setupAddTicketModal() {
    if (addTicketModalSetup) return;
    addTicketModalSetup = true;

    const modal = document.getElementById('add-ticket-modal');
    const saveBtn = document.getElementById('add-ticket-save');
    const cancelBtn = document.getElementById('add-ticket-cancel');
    const closeBtn = document.getElementById('add-ticket-close');

    saveBtn?.addEventListener('click', saveNewTicket);
    cancelBtn?.addEventListener('click', closeAddTicketModal);
    closeBtn?.addEventListener('click', closeAddTicketModal);

    modal?.addEventListener('mousedown', (e) => {
      if (e.target === modal) closeAddTicketModal();
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !modal?.classList.contains('hidden')) {
        closeAddTicketModal();
      }
    });

    document.getElementById('btn-add-ticket')?.addEventListener('click', openAddTicketModal);
  }

  function openAddTicketModal() {
    if (readOnly) return;
    document.getElementById('add-ticket-number').value = '';
    document.getElementById('add-ticket-description').value = '';
    document.getElementById('add-ticket-project').value = '';
    document.getElementById('add-ticket-notes').value = '';

    const modal = document.getElementById('add-ticket-modal');
    modal.classList.remove('hidden');
    modal.classList.add('active');

    setTimeout(() => document.getElementById('add-ticket-number')?.focus(), 100);
  }

  function closeAddTicketModal() {
    const modal = document.getElementById('add-ticket-modal');
    modal.classList.add('hidden');
    modal.classList.remove('active');
  }

  function saveNewTicket() {
    if (readOnly) return;
    const ticketNumber = document.getElementById('add-ticket-number').value.trim();
    const description = document.getElementById('add-ticket-description').value.trim();
    const project = document.getElementById('add-ticket-project').value.trim();
    const notes = document.getElementById('add-ticket-notes').value.trim();

    if (!ticketNumber) {
      UI.showToast('El campo N° Ticket es obligatorio', 'error');
      document.getElementById('add-ticket-number')?.focus();
      return;
    }

    const newTicket = {
      id: `${currentProgrammer}-new-${Date.now()}`,
      ticket: ticketNumber,
      description: description || '',
      project: project || '',
      notes: notes || '',
      status: 'No resuelto',
    };

    currentTickets.push(newTicket);

    const data = Storage.loadData();
    if (data) {
      data.programmers[currentProgrammer] = currentTickets;
      Storage.saveData(data);
    }

    closeAddTicketModal();

    const stats = Dashboard.calcStats(currentTickets);
    updateRing(stats.pct);

    const subtitle = document.getElementById('prog-subtitle');
    if (subtitle) {
      subtitle.textContent = `${stats.total} tickets · ${stats.solved} solventados · ${stats.noAplica} no aplica · ${stats.inProgress} en proceso · ${stats.unsolved} sin resolver`;
    }

    renderTicketsTable();

    UI.showToast(`Ticket ${ticketNumber} agregado correctamente`, 'success');
  }

  // ----------------------------------------------------------------
  // VISTA PRINCIPAL DEL PROGRAMADOR
  // ----------------------------------------------------------------

  /**
   * Renderiza la vista completa del programador.
   * @param {string} name - Nombre del programador
   * @param {Array} tickets - Array de tickets del programador
   */
  function render(name, tickets, isReadOnly) {
    currentProgrammer = name;
    currentTickets = tickets;
    activeFilter = 'all';
    searchQuery = '';
    readOnly = isReadOnly === true;

    const stats = Dashboard.calcStats(tickets);

    // Avatar e iniciales
    const avatar = document.getElementById('prog-avatar');
    if (avatar) avatar.textContent = getInitials(name);

    // Nombre y subtítulo
    const nameEl = document.getElementById('prog-name');
    if (nameEl) nameEl.textContent = name;

    const subtitleEl = document.getElementById('prog-subtitle');
    if (subtitleEl) {
      subtitleEl.textContent = `${stats.total} tickets · ${stats.solved} solventados · ${stats.noAplica} no aplica · ${stats.inProgress} en proceso · ${stats.unsolved} sin resolver`;
    }

    // Anillo de efectividad
    // Reset antes de animar
    const ring = document.getElementById('ring-fill');
    if (ring) ring.style.strokeDashoffset = '314';
    updateRing(stats.pct);

    // Configurar filtros (resetear estado)
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    const allBtn = document.querySelector('.filter-btn[data-filter="all"]');
    if (allBtn) allBtn.classList.add('active');

    // Mostrar/ocultar elementos según modo
    const progActions = document.querySelector('.prog-actions');
    if (progActions) progActions.style.display = readOnly ? 'none' : '';

    const filtersBar = document.querySelector('.filters-bar');
    if (filtersBar) filtersBar.style.display = readOnly ? 'none' : '';

    const headerRow = document.querySelector('#tickets-table thead tr');
    if (headerRow && readOnly) {
      const thAcciones = headerRow.querySelector('th:last-child');
      if (thAcciones) thAcciones.style.display = 'none';
    } else if (headerRow) {
      const thAcciones = headerRow.querySelector('th:last-child');
      if (thAcciones) thAcciones.style.display = '';
    }

    setupFilters();
    renderTicketsTable();

    setupNotesModalEvents();
    setupAddTicketModal();
  }

  /**
   * Activa la edición de todas las celdas de texto de una fila.
   * Se llama desde el botón de edición en la columna de acciones.
   * @param {string} ticketId
   */
  function startEditRow(ticketId) {
    if (readOnly) return;
    const ticket = currentTickets.find(t => t.id === ticketId);
    if (!ticket) return;

    ['ticket', 'description', 'project'].forEach(field => {
      const tbody = document.getElementById('tickets-tbody');
      const td = tbody?.querySelector(`td.td-${field}[data-id="${ticketId}"]`);
      if (td && td.dataset.editing !== 'true') {
        makeEditable(td, ticketId, field, ticket[field] || '');
      }
    });

    openNotesModal(ticketId);
  }

  /**
   * Retorna los tickets actuales (para exportación).
   * @returns {{ name: string, tickets: Array }}
   */
  function getCurrentData() {
    return { name: currentProgrammer, tickets: currentTickets };
  }

  // API pública del módulo
  return {
    render,
    startEditRow,
    getCurrentData,
    updateSidebarBadge,
    openNotesModal,
  };

})();
