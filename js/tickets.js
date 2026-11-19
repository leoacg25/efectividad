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
  let notesAttachments = [];
  let notesReadOnly = false;
  let notesAttachmentsBusy = false;
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
      case 'Información Adicional': return 'status-badge--info';
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
      const searchOk = !query || [t.ticket, t.description, t.project, t.tipo, t.notes, t.status]
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
      tbody.innerHTML = `<tr><td colspan="7">
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
            <option value="Información Adicional" ${ticket.status === 'Información Adicional' ? 'selected' : ''}>Info. Adicional</option>
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
              <button
                class="btn btn--ghost btn--icon btn--sm"
                title="Transferir ticket"
                onclick="Tickets.openTransferModal('${ticket.id}')">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" width="14" height="14">
                  <path d="M17 1l4 4-4 4M7 23l-4-4 4-4"/>
                  <path d="M3 5h14a4 4 0 014 4v2M21 13v2a4 4 0 01-4 4H3"/>
                </svg>
              </button>
              <button
                class="btn btn--ghost btn--icon btn--sm btn--icon-danger"
                title="Eliminar ticket"
                onclick="Tickets.deleteTicket('${ticket.id}')">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" width="14" height="14">
                  <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>
                </svg>
              </button>
            </div>
          </td>`;
      const notesOpenAttr = `onclick="Tickets.openNotesModal('${ticket.id}')"`;
      const notesOpenBtn = `<button class="notes-open-btn ${ticket.notes ? 'has-content' : ''}"
                onclick="Tickets.openNotesModal('${ticket.id}')"
                aria-label="${readOnly ? 'Ver notas' : 'Editar notas'}"
                title="${readOnly ? 'Ver notas' : 'Editar notas'}">
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
          <td class="td-tipo" data-field="tipo" data-id="${ticket.id}">
            ${readOnly
              ? escHtml(ticket.tipo || '—')
              : `<label class="tipo-radio ${ticket.tipo === 'Mejora/requerimiento' ? 'tipo-radio--active' : ''}">
                   <input type="radio" name="tipo-${ticket.id}" value="Mejora/requerimiento" ${ticket.tipo === 'Mejora/requerimiento' ? 'checked' : ''}>
                   <span>Mejora/Req.</span>
                 </label>
                 <label class="tipo-radio ${ticket.tipo === 'Avería/Falla' ? 'tipo-radio--active' : ''}">
                   <input type="radio" name="tipo-${ticket.id}" value="Avería/Falla" ${ticket.tipo === 'Avería/Falla' ? 'checked' : ''}>
                   <span>Avería/Falla</span>
                 </label>`
            }
          </td>
          <td class="td-notes" data-field="notes" data-id="${ticket.id}">
            <div class="td-notes-cell">
              <span class="notes-preview ${ticket.notes ? '' : 'notes-preview--empty'}"
                    ${notesOpenAttr}
                    title="Ver notas" tabindex="0">
                ${escHtml(ticket.notes ? (readOnly ? ticket.notes : (ticket.notes.length > 120 ? ticket.notes.substring(0, 120) + '...' : ticket.notes)) : 'Sin notas')}
              </span>
              ${Attachments.renderBadge(ticket.attachments)}
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

    // Listeners de cambio de tipo (radio buttons)
    tbody.querySelectorAll('input[type="radio"][name^="tipo-"]').forEach(radio => {
      radio.addEventListener('change', (e) => {
        const ticketId = e.target.name.replace('tipo-', '');
        const newTipo = e.target.value;
        const ticket = currentTickets.find(t => t.id === ticketId);
        if (!ticket) return;
        ticket.tipo = newTipo;
        Storage.updateTicketField(currentProgrammer, ticketId, 'tipo', newTipo);
        // Actualizar estilo visual de los labels
        const td = e.target.closest('.td-tipo');
        td.querySelectorAll('.tipo-radio').forEach(l => l.classList.remove('tipo-radio--active'));
        e.target.closest('.tipo-radio').classList.add('tipo-radio--active');

        // Recalcular efectividad y actualizar UI
        const stats = Dashboard.calcStats(currentTickets);
        updateRing(stats.pct);
        const subtitle = document.getElementById('prog-subtitle');
        if (subtitle) {
          subtitle.textContent = `${stats.total} tickets · ${stats.solved} solventados · ${stats.noAplica} no aplica · ${stats.infoAdicional} informaci\u00f3n adicional · ${stats.inProgress} en proceso · ${stats.unsolved} sin resolver`;
        }
        updateSidebarBadge(currentProgrammer, stats.pct);
        if (typeof App !== 'undefined' && App.syncProgrammerFromStorage) {
          App.syncProgrammerFromStorage(currentProgrammer);
          App.refreshProfiles();
        }
        // Fijar la bandera de cambio local para que el snapshot remoto
        // no sobrescriba el estado visual con datos posiblemente anteriores
        window.__localTipoChange = true;
        setTimeout(() => { window.__localTipoChange = false; }, 2000);
        renderTicketsTable();
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
        subtitle.textContent = `${stats.total} tickets · ${stats.solved} solventados · ${stats.noAplica} no aplica · ${stats.infoAdicional} informaci\u00f3n adicional · ${stats.inProgress} en proceso · ${stats.unsolved} sin resolver`;
      }

      // Actualizar badge en sidebar
      updateSidebarBadge(currentProgrammer, stats.pct);
      // Sincronizar appData con localStorage y actualizar perfiles especiales
      if (typeof App !== 'undefined' && App.syncProgrammerFromStorage) {
        App.syncProgrammerFromStorage(currentProgrammer);
        App.refreshProfiles();
      }

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
    const addImagesBtn = document.getElementById('notes-attachments-add');
    const fileInput = document.getElementById('notes-attachments-input');
    const dropZone = document.getElementById('notes-attachments-drop');
    const grid = document.getElementById('notes-attachments-grid');

    saveBtn?.addEventListener('click', saveNotesChanges);
    cancelBtn?.addEventListener('click', closeNotesModal);
    closeBtn?.addEventListener('click', closeNotesModal);
    clearBtn?.addEventListener('click', () => {
      if (textarea) textarea.value = '';
      notesAttachments = [];
      updateNotesCharCount();
      renderNotesAttachments();
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

    // --- Adjuntos: selector de archivos ---
    addImagesBtn?.addEventListener('click', () => fileInput?.click());
    fileInput?.addEventListener('change', async (e) => {
      const files = e.target.files;
      e.target.value = '';
      await addAttachmentFiles(files);
    });

    // --- Adjuntos: arrastrar y soltar ---
    if (dropZone) {
      ['dragenter', 'dragover'].forEach(evt => {
        dropZone.addEventListener(evt, (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (!notesReadOnly) dropZone.classList.add('is-dragover');
        });
      });
      ['dragleave', 'dragend'].forEach(evt => {
        dropZone.addEventListener(evt, (e) => {
          e.preventDefault();
          e.stopPropagation();
          dropZone.classList.remove('is-dragover');
        });
      });
      dropZone.addEventListener('drop', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropZone.classList.remove('is-dragover');
        await addAttachmentFiles(e.dataTransfer?.files);
      });
    }

    // --- Adjuntos: pegar desde el portapapeles (Ctrl+V) ---
    document.addEventListener('paste', (e) => {
      if (modal?.classList.contains('hidden')) return;
      if (notesReadOnly) return;
      if (!document.getElementById('image-lightbox')?.classList.contains('hidden')) return;
      const files = getClipboardImageFiles(e.clipboardData);
      if (!files.length) return;
      e.preventDefault();
      addAttachmentFiles(files);
    });

    // --- Adjuntos: abrir vista previa / quitar ---
    grid?.addEventListener('click', (e) => {
      const removeBtn = e.target.closest('[data-att-remove]');
      if (removeBtn) {
        const index = Number(removeBtn.getAttribute('data-att-remove'));
        if (Number.isInteger(index) && index >= 0 && index < notesAttachments.length) {
          notesAttachments.splice(index, 1);
          renderNotesAttachments();
        }
        return;
      }
      const openBtn = e.target.closest('[data-att-open]');
      if (openBtn) {
        const index = Number(openBtn.getAttribute('data-att-open'));
        const att = notesAttachments[index];
        if (att) Attachments.openPreview(att);
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !document.getElementById('notes-modal')?.classList.contains('hidden')) {
        closeNotesModal();
      }
    });
  }

  /**
   * Extrae las imágenes disponibles en un evento de portapapeles.
   * @param {DataTransfer|null} clipboardData
   * @returns {File[]}
   */
  function getClipboardImageFiles(clipboardData) {
    const files = [];
    if (!clipboardData) return files;

    if (clipboardData.items) {
      Array.from(clipboardData.items).forEach(item => {
        if (item.kind === 'file' && /^image\//i.test(item.type)) {
          const file = item.getAsFile();
          if (file) files.push(file);
        }
      });
    }

    if (!files.length && clipboardData.files) {
      Array.from(clipboardData.files).forEach(file => {
        if (file && /^image\//i.test(file.type)) files.push(file);
      });
    }

    return files;
  }

  /**
   * Procesa y añade imágenes al ticket abierto en el modal.
   * @param {FileList|File[]} fileList
   */
  async function addAttachmentFiles(fileList) {
    if (notesReadOnly || notesAttachmentsBusy) return;

    const files = Array.from(fileList || []).filter(Boolean);
    if (!files.length) return;

    const max = Attachments.MAX_PER_TICKET;
    if (notesAttachments.length >= max) {
      UI.showToast(`Máximo ${max} imágenes por ticket`, 'warning');
      return;
    }

    setNotesAttachmentsBusy(true);
    try {
      const result = await Attachments.processFiles(files, {
        existing: notesAttachments,
        max,
      });

      if (result.added.length) {
        notesAttachments = notesAttachments.concat(result.added);
        renderNotesAttachments();
        UI.showToast(
          result.added.length === 1 ? 'Imagen adjuntada' : `${result.added.length} imágenes adjuntadas`,
          'success'
        );
      }

      result.errors.forEach(msg => UI.showToast(msg, 'error', 6000));
      if (result.skipped) {
        UI.showToast(`Solo se permiten ${max} imágenes por ticket`, 'warning');
      }
    } finally {
      setNotesAttachmentsBusy(false);
    }
  }

  function setNotesAttachmentsBusy(busy) {
    notesAttachmentsBusy = !!busy;
    const dropZone = document.getElementById('notes-attachments-drop');
    const addBtn = document.getElementById('notes-attachments-add');
    if (dropZone) dropZone.classList.toggle('is-busy', !!busy);
    if (addBtn) addBtn.disabled = !!busy;
  }

  /**
   * Renderiza las miniaturas y el estado del área de adjuntos.
   */
  function renderNotesAttachments() {
    const grid = document.getElementById('notes-attachments-grid');
    const size = document.getElementById('notes-attachments-size');
    const dropZone = document.getElementById('notes-attachments-drop');
    const section = document.getElementById('notes-attachments');
    if (!grid) return;

    const totalBytes = notesAttachments.reduce((sum, a) => sum + (Number(a.bytes) || 0), 0);
    if (size) {
      size.textContent = notesAttachments.length
        ? `${notesAttachments.length}/${Attachments.MAX_PER_TICKET} · ${Attachments.formatBytes(totalBytes)}`
        : '';
    }

    grid.innerHTML = notesAttachments.map((att, index) => `
      <figure class="attachment-thumb">
        <button type="button" class="attachment-thumb__open" data-att-open="${index}" title="Ver imagen" aria-label="Ver ${escHtml(att.name)}">
          <img src="${att.dataUrl}" alt="${escHtml(att.name)}" loading="lazy">
        </button>
        ${notesReadOnly ? '' : `<button type="button" class="attachment-thumb__remove" data-att-remove="${index}" title="Quitar imagen" aria-label="Quitar ${escHtml(att.name)}">×</button>`}
        <figcaption>${escHtml(att.name)} · ${Attachments.formatBytes(att.bytes)}</figcaption>
      </figure>
    `).join('');

    if (dropZone) {
      const atLimit = notesAttachments.length >= Attachments.MAX_PER_TICKET;
      dropZone.classList.toggle('hidden', notesReadOnly || atLimit);
      const hint = dropZone.querySelector('.notes-attachments__drop-hint');
      if (hint) {
        hint.textContent = atLimit
          ? `Máximo ${Attachments.MAX_PER_TICKET} imágenes por ticket`
          : 'Arrastra imágenes o pégalas desde el portapapeles';
      }
    }

    if (section) section.classList.toggle('hidden', notesReadOnly && notesAttachments.length === 0);
    const pasteHint = section?.querySelector('.notes-attachments__hint');
    if (pasteHint) pasteHint.classList.toggle('hidden', notesReadOnly);
  }

  /**
   * Define los adjuntos del ticket abierto (usado también por Pos Web).
   * @param {Array} list
   * @param {boolean} [isReadOnly=false]
   */
  function setNotesAttachments(list, isReadOnly = false) {
    notesReadOnly = !!isReadOnly;
    notesAttachments = Attachments.sanitize(list);
    renderNotesAttachments();
  }

  function getNotesAttachments() {
    return notesAttachments.slice();
  }

  function openNotesModal(ticketId) {
    const ticket = currentTickets.find(t => t.id === ticketId);
    if (!ticket) return;

    currentTicketIdForNotes = ticketId;
    setupNotesModalEvents();

    document.getElementById('notes-modal-title').textContent = `Notas del Ticket ${ticket.ticket}`;
    document.getElementById('notes-modal-subtitle').textContent = `${ticket.description || 'Sin descripción'} · ${ticket.project || 'Sin proyecto'}${ticket.tipo ? ` · ${ticket.tipo}` : ''}`;

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

    notesReadOnly = readOnly;
    notesAttachments = Attachments.sanitize(ticket.attachments);
    renderNotesAttachments();

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
    notesAttachments = [];
    notesReadOnly = false;
    if (window._posWebNotesCleanup) window._posWebNotesCleanup();
  }

  function saveNotesChanges() {
    if (window._posWebNotesSave) {
      const handled = window._posWebNotesSave();
      if (handled !== false) return;
    }
    if (!currentTicketIdForNotes || readOnly) return;

    const textarea = document.getElementById('notes-textarea');
    const newValue = textarea.value.trim();
    const ticket = currentTickets.find(t => t.id === currentTicketIdForNotes);
    if (!ticket) {
      closeNotesModal();
      return;
    }

    const nextAttachments = notesAttachments.slice();
    const notesChanged = newValue !== (ticket.notes || '');
    const attachmentsChanged = JSON.stringify(nextAttachments)
      !== JSON.stringify(Attachments.sanitize(ticket.attachments));

    if (notesChanged || attachmentsChanged) {
      const fields = { notes: newValue, attachments: nextAttachments };

      // Evitar que el documento del programador supere el límite de Firestore.
      const projected = currentTickets.map(t => t.id === ticket.id ? Object.assign({}, t, fields) : t);
      if (Attachments.estimateChars(projected) > Attachments.MAX_PROGRAMMER_CHARS) {
        UI.showToast(
          'No hay espacio suficiente para guardar estas imágenes. Elimina algunas o reduce su cantidad.',
          'error',
          7000
        );
        return;
      }

      try {
        const ok = Storage.updateTicketFields(currentProgrammer, currentTicketIdForNotes, fields);
        if (!ok) throw new Error('No se pudo guardar el ticket.');

        Object.assign(ticket, fields);
        UI.showToast(
          notesChanged ? 'Notas guardadas correctamente' : 'Imágenes guardadas correctamente',
          'success'
        );
        renderTicketsTable();
      } catch (err) {
        UI.showToast(err.message || 'Error al guardar las notas.', 'error', 6000);
        return;
      }
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
    document.querySelector('input[name="add-ticket-tipo"][value="Mejora/requerimiento"]').checked = true;

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

    const tipoRadio = document.querySelector('input[name="add-ticket-tipo"]:checked');
    const newTicket = {
      id: `${currentProgrammer}-new-${Date.now()}`,
      ticket: ticketNumber,
      description: description || '',
      project: project || '',
      tipo: tipoRadio ? tipoRadio.value : '',
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
      subtitle.textContent = `${stats.total} tickets · ${stats.solved} solventados · ${stats.noAplica} no aplica · ${stats.infoAdicional} informaci\u00f3n adicional · ${stats.inProgress} en proceso · ${stats.unsolved} sin resolver`;
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
      subtitleEl.textContent = `${stats.total} tickets · ${stats.solved} solventados · ${stats.noAplica} no aplica · ${stats.infoAdicional} informaci\u00f3n adicional · ${stats.inProgress} en proceso · ${stats.unsolved} sin resolver`;
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
    const progActions = document.querySelector('#view-programmer .prog-actions');
    if (progActions) {
      if (readOnly) {
        progActions.style.display = '';
        progActions.querySelectorAll('button, input[type="file"]').forEach(el => {
          el.style.display = el.id === 'btn-export-pdf-prog' ? '' : 'none';
        });
      } else {
        progActions.style.display = '';
        progActions.querySelectorAll('button, input[type="file"]').forEach(el => {
          el.style.display = '';
        });
      }
    }

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
    setupDuplicatesCleanup();
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

  // ----------------------------------------------------------------
  // ELIMINAR DUPLICADOS SIN NOTA
  // ----------------------------------------------------------------

  /**
   * Indica si un ticket tiene contenido en la nota (texto o imágenes adjuntas).
   * @param {Object} ticket
   * @returns {boolean}
   */
  function ticketHasNote(ticket) {
    if (String((ticket && ticket.notes) || '').trim() !== '') return true;
    return Array.isArray(ticket && ticket.attachments)
      && ticket.attachments.some(a => a && typeof a.dataUrl === 'string');
  }

  /**
   * Detecta repeticiones de un mismo ticket que no tienen nota, siempre que
   * otra repetición del mismo número sí la tenga. Se usa la misma
   * normalización de número que la importación (0003125 = 3125).
   * @param {Object[]} list
   * @returns {{ tickets: Object[], keys: string[] }} tickets restantes y números afectados
   */
  function findDuplicatesWithoutNotes(list) {
    const tickets = Array.isArray(list) ? list : [];
    const groups = new Map();

    tickets.forEach((ticket, index) => {
      const key = typeof Parser !== 'undefined' && Parser.normalizeTicketKey
        ? Parser.normalizeTicketKey(ticket && ticket.ticket)
        : String((ticket && ticket.ticket) || '').trim().toLowerCase();
      if (!key) return;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(index);
    });

    const drop = new Set();
    const keys = [];

    groups.forEach((indexes, key) => {
      if (indexes.length < 2) return;
      // Si ninguna repetición tiene nota, no se elimina nada: no hay información
      // que permita decidir cuál conservar.
      if (!indexes.some(i => ticketHasNote(tickets[i]))) return;

      const withoutNote = indexes.filter(i => !ticketHasNote(tickets[i]));
      if (!withoutNote.length) return;
      withoutNote.forEach(i => drop.add(i));
      keys.push(key);
    });

    return {
      tickets: tickets.filter((_, index) => !drop.has(index)),
      keys,
    };
  }

  /**
   * Actualiza anillo, subtítulo y badge de la vista con los tickets vigentes.
   */
  function refreshProgrammerSummary() {
    const stats = Dashboard.calcStats(currentTickets);
    updateRing(stats.pct);

    const subtitle = document.getElementById('prog-subtitle');
    if (subtitle) {
      subtitle.textContent = `${stats.total} tickets · ${stats.solved} solventados · ${stats.noAplica} no aplica · ${stats.infoAdicional} informaci\u00f3n adicional · ${stats.inProgress} en proceso · ${stats.unsolved} sin resolver`;
    }
    updateSidebarBadge(currentProgrammer, stats.pct);
  }

  /**
   * Elimina los tickets repetidos sin nota del programador actual, conservando
   * la repetición que sí tiene comentario o imágenes en la nota.
   */
  function removeDuplicatesWithoutNotes() {
    if (readOnly || !currentProgrammer || !currentTickets.length) return;

    const preview = findDuplicatesWithoutNotes(currentTickets);
    const previewCount = currentTickets.length - preview.tickets.length;
    if (!previewCount) {
      UI.showToast('No hay tickets repetidos sin nota para eliminar', 'info');
      return;
    }

    const list = preview.keys.slice(0, 6).join(', ') + (preview.keys.length > 6 ? '…' : '');
    UI.confirm(
      'Eliminar tickets repetidos sin nota',
      `Se eliminarán ${previewCount} ticket(s) repetido(s) sin nota de ${currentProgrammer} (${list}). Se conservarán los que tienen comentario o imágenes en la nota. ¿Continuar?`
    ).then(confirmed => {
      if (!confirmed) return;

      const data = Storage.loadData();
      if (!data || !data.programmers) {
        UI.showToast('No se pudo acceder a los datos guardados', 'error');
        return;
      }

      // Recalcular sobre lo guardado por si cambió mientras se confirmaba
      const result = findDuplicatesWithoutNotes(data.programmers[currentProgrammer] || currentTickets);
      const removed = (data.programmers[currentProgrammer] || currentTickets).length - result.tickets.length;
      if (!removed) {
        UI.showToast('No quedaron duplicados sin nota para eliminar', 'info');
        return;
      }

      const previousTickets = currentTickets;
      currentTickets = result.tickets;
      data.programmers[currentProgrammer] = currentTickets;

      try {
        Storage.saveData(data);
      } catch (err) {
        currentTickets = previousTickets; // No mostrar cambios que no se pudieron guardar
        UI.showToast('No se pudieron guardar los cambios: ' + err.message, 'error');
        return;
      }

      refreshProgrammerSummary();
      if (typeof App !== 'undefined' && App.syncProgrammerFromStorage) {
        App.syncProgrammerFromStorage(currentProgrammer);
        if (App.refreshProfiles) App.refreshProfiles();
      }
      renderTicketsTable();
      UI.showToast(`Se eliminaron ${removed} ticket(s) repetido(s) sin nota`, 'success');
    });
  }

  let duplicatesSetup = false;

  function setupDuplicatesCleanup() {
    if (duplicatesSetup) return;
    duplicatesSetup = true;
    document.getElementById('btn-remove-duplicates-prog')?.addEventListener('click', removeDuplicatesWithoutNotes);
  }

  // ----------------------------------------------------------------
  // ELIMINAR TICKET
  // ----------------------------------------------------------------

  /**
   * Elimina un ticket tras confirmación del usuario.
   * @param {string} ticketId
   */
  function deleteTicket(ticketId) {
    if (readOnly) return;
    const ticket = currentTickets.find(t => t.id === ticketId);
    if (!ticket) return;

    UI.confirm('Eliminar ticket', `¿Eliminar el ticket "${ticket.ticket || ticketId}"?`).then(confirmed => {
      if (!confirmed) return;

      currentTickets = currentTickets.filter(t => t.id !== ticketId);

      const data = Storage.loadData();
      if (data) {
        data.programmers[currentProgrammer] = currentTickets;
        Storage.saveData(data);
      }

      const stats = Dashboard.calcStats(currentTickets);
      updateRing(stats.pct);

      const subtitle = document.getElementById('prog-subtitle');
      if (subtitle) {
        subtitle.textContent = `${stats.total} tickets · ${stats.solved} solventados · ${stats.noAplica} no aplica · ${stats.infoAdicional} informaci\u00f3n adicional · ${stats.inProgress} en proceso · ${stats.unsolved} sin resolver`;
      }
      updateSidebarBadge(currentProgrammer, stats.pct);

      renderTicketsTable();
      UI.showToast('Ticket eliminado', 'success');
    });
  }

  // ----------------------------------------------------------------
  // TRANSFERIR TICKET
  // ----------------------------------------------------------------

  let transferTicketId = null;

  function setupTransferModal() {
    const modal = document.getElementById('transfer-modal');
    if (!modal) return;
    if (modal.dataset.setup) return;
    modal.dataset.setup = 'true';

    document.getElementById('transfer-modal-close')?.addEventListener('click', closeTransferModal);
    document.getElementById('transfer-modal-cancel')?.addEventListener('click', closeTransferModal);
    document.getElementById('transfer-modal-confirm')?.addEventListener('click', executeTransfer);

    modal.addEventListener('mousedown', (e) => {
      if (e.target === modal) closeTransferModal();
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !modal.classList.contains('hidden')) {
        closeTransferModal();
      }
    });
  }

  function openTransferModal(ticketId) {
    if (readOnly) return;
    const ticket = currentTickets.find(t => t.id === ticketId);
    if (!ticket) return;

    transferTicketId = ticketId;
    setupTransferModal();

    document.getElementById('transfer-modal-title').textContent = `Transferir Ticket ${ticket.ticket || ''}`;
    document.getElementById('transfer-modal-desc').textContent =
      `Transferir "${ticket.description || ticket.ticket || ticketId}" a:`;

    const select = document.getElementById('transfer-target');
    const allNames = App.getAllProgrammerNames();
    select.innerHTML = allNames
      .filter(n => n !== currentProgrammer)
      .map(n => `<option value="${escHtml(n)}">${escHtml(n)}</option>`)
      .join('');

    const modal = document.getElementById('transfer-modal');
    modal.classList.remove('hidden');
    modal.classList.add('active');
  }

  function closeTransferModal() {
    const modal = document.getElementById('transfer-modal');
    modal.classList.add('hidden');
    modal.classList.remove('active');
    transferTicketId = null;
  }

  function executeTransfer() {
    if (!transferTicketId) return;
    const targetName = document.getElementById('transfer-target').value;
    if (!targetName || targetName === currentProgrammer) return;

    const ticket = currentTickets.find(t => t.id === transferTicketId);
    if (!ticket) return;

    // Remove from current
    currentTickets = currentTickets.filter(t => t.id !== transferTicketId);

    // Add to target
    const data = Storage.loadData();
    if (!data) return;
    if (!data.programmers[targetName]) data.programmers[targetName] = [];
    data.programmers[targetName].push(ticket);
    data.programmers[currentProgrammer] = currentTickets;
    Storage.saveData(data);

    closeTransferModal();

    // Re-render current view
    const stats = Dashboard.calcStats(currentTickets);
    updateRing(stats.pct);

    const subtitle = document.getElementById('prog-subtitle');
    if (subtitle) {
      subtitle.textContent = `${stats.total} tickets · ${stats.solved} solventados · ${stats.noAplica} no aplica · ${stats.infoAdicional} informaci\u00f3n adicional · ${stats.inProgress} en proceso · ${stats.unsolved} sin resolver`;
    }
    updateSidebarBadge(currentProgrammer, stats.pct);
    updateSidebarBadge(targetName, Dashboard.calcStats(data.programmers[targetName]).pct);

    renderTicketsTable();
    UI.showToast(`Ticket transferido a ${targetName}`, 'success');
  }

  // API pública del módulo
  return {
    render,
    startEditRow,
    getCurrentData,
    updateSidebarBadge,
    openNotesModal,
    closeNotesModal,
    deleteTicket,
    removeDuplicatesWithoutNotes,
    findDuplicatesWithoutNotes,
    openTransferModal,
    setupNotesModalEvents,
    getNotesAttachments,
    setNotesAttachments,
  };

})();
