/**
 * storage.js — Módulo de Persistencia en LocalStorage
 * =====================================================
 * Responsable de toda la interacción con localStorage:
 *   - Guardar datos procesados del Excel
 *   - Recuperar datos al recargar la página
 *   - Actualizar estado individual de tickets
 *   - Limpiar todos los datos almacenados
 */

const Storage = (() => {

  // Clave principal usada en localStorage
  const KEY = 'prog_dashboard_data';
  let onSaveCallback = null;

  function setOnSaveCallback(cb) {
    onSaveCallback = cb;
  }

  /**
   * Guarda el objeto completo de datos en localStorage.
   * @param {Object} data - Estructura: { programmers: { [nombre]: [tickets] } }
   */
  function saveData(data) {
    try {
      localStorage.setItem(KEY, JSON.stringify(data));
      if (onSaveCallback) onSaveCallback(data);
    } catch (err) {
      console.error('[Storage] Error al guardar datos:', err);
      // localStorage lleno (QuotaExceededError) u otro problema
      throw new Error('No se pudo guardar en el almacenamiento local. Puede que el navegador esté en modo privado o sin espacio disponible.');
    }
  }

  /**
   * Lee y retorna los datos almacenados.
   * @returns {Object|null} Los datos guardados o null si no existen.
   */
  function loadData() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (err) {
      console.error('[Storage] Error al leer datos:', err);
      return null;
    }
  }

  /**
   * Verifica si existen datos guardados en localStorage.
   * @returns {boolean}
   */
  function hasData() {
    return localStorage.getItem(KEY) !== null;
  }

  /**
   * Elimina todos los datos del dashboard del localStorage.
   */
  function clearData() {
    localStorage.removeItem(KEY);
  }

  /**
   * Actualiza el estado de un ticket específico y persiste el cambio.
   * @param {string} programmerName - Nombre del programador (clave del objeto)
   * @param {string|number} ticketId - ID del ticket (campo 'id' generado)
   * @param {string} newStatus - Nuevo estado: 'No resuelto' | 'En proceso' | 'Solventado'
   * @returns {boolean} true si la actualización fue exitosa
   */
  function updateTicketStatus(programmerName, ticketId, newStatus) {
    const data = loadData();
    if (!data || !data.programmers[programmerName]) return false;

    const tickets = data.programmers[programmerName];
    const ticket = tickets.find(t => t.id === ticketId);
    if (!ticket) return false;

    ticket.status = newStatus;
    saveData(data);
    return true;
  }

  /**
   * Actualiza un campo de texto de un ticket y persiste el cambio.
   * @param {string} programmerName - Nombre del programador
   * @param {string|number} ticketId - ID del ticket
   * @param {string} field - Campo a actualizar ('ticket', 'description', 'project', 'notes')
   * @param {string} value - Nuevo valor del campo
   * @returns {boolean} true si la actualización fue exitosa
   */
  function updateTicketField(programmerName, ticketId, field, value) {
    const data = loadData();
    if (!data || !data.programmers[programmerName]) return false;

    const tickets = data.programmers[programmerName];
    const ticket = tickets.find(t => t.id === ticketId);
    if (!ticket) return false;

    ticket[field] = value;
    saveData(data);
    return true;
  }

  // API pública del módulo
  return {
    saveData,
    loadData,
    hasData,
    clearData,
    updateTicketStatus,
    updateTicketField,
    setOnSaveCallback,
  };

})();
