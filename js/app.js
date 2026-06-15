/**
 * app.js — Orquestador Principal de la Aplicación
 * =================================================
 * Responsable de:
 *   - Inicializar la app: detectar si hay datos en localStorage
 *   - Gestionar la navegación entre vistas (upload, dashboard, programmer)
 *   - Coordinar la carga del archivo Excel
 *   - Conectar todos los módulos (Storage, Parser, Dashboard, Tickets, Exporter)
 *   - Gestionar el sidebar responsivo y el modal de confirmación
 *   - Mostrar notificaciones toast al usuario
 */

// ----------------------------------------------------------------
// MÓDULO UI — Utilidades de Interfaz de Usuario
// ----------------------------------------------------------------
const UI = (() => {

  /**
   * Muestra u oculta el overlay de carga.
   * @param {boolean} show
   */
  function setLoading(show) {
    const overlay = document.getElementById('loading-overlay');
    if (overlay) {
      overlay.classList.toggle('hidden', !show);
    }
  }

  /**
   * Muestra una pantalla y oculta las demás.
   * @param {'screen-upload'|'screen-app'} screenId
   */
  function showScreen(screenId) {
    document.querySelectorAll('.screen').forEach(s => {
      s.classList.remove('active');
      s.classList.add('hidden');
    });
    const target = document.getElementById(screenId);
    if (target) {
      target.classList.remove('hidden');
      target.classList.add('active');
    }
  }

  /**
   * Muestra una vista dentro de la pantalla de app.
   * @param {'view-dashboard'|'view-programmer'} viewId
   */
  function showView(viewId) {
    document.querySelectorAll('.view').forEach(v => {
      v.classList.remove('active');
      v.classList.add('hidden');
    });
    const target = document.getElementById(viewId);
    if (target) {
      target.classList.remove('hidden');
      target.classList.add('active');
    }
  }

  /**
   * Muestra un mensaje de error en la pantalla de upload.
   * @param {string} message
   */
  function showUploadError(message) {
    const el = document.getElementById('upload-error');
    if (el) {
      el.textContent = message;
      el.classList.remove('hidden');
    }
  }

  /**
   * Oculta el mensaje de error de upload.
   */
  function hideUploadError() {
    const el = document.getElementById('upload-error');
    if (el) el.classList.add('hidden');
  }

  /**
   * Muestra una notificación toast.
   * @param {string} message
   * @param {'success'|'error'|'info'} type
   * @param {number} duration - milisegundos antes de auto-cerrar
   */
  function showToast(message, type = 'info', duration = 3000) {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const icons = {
      success: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
                  <path d="M20 6L9 17l-5-5"/>
                </svg>`,
      error:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
                  <circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/>
                </svg>`,
      info:    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
                  <circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/>
                </svg>`,
    };

    const toast = document.createElement('div');
    toast.className = `toast toast--${type}`;
    toast.innerHTML = `${icons[type] || ''}${message}`;
    container.appendChild(toast);

    setTimeout(() => {
      toast.addEventListener('animationend', () => toast.remove(), { once: true });
      if (!toast.classList.contains('remove')) {
        toast.remove();
      }
    }, duration);
  }

  /**
   * Abre el modal de confirmación.
   * @param {string} title
   * @param {string} message
   * @returns {Promise<boolean>} true si el usuario confirma
   */
  function confirm(title, message) {
    return new Promise((resolve) => {
      const modal = document.getElementById('confirm-modal');
      const titleEl = document.getElementById('modal-title');
      const msgEl = document.getElementById('modal-message');
      const confirmBtn = document.getElementById('modal-confirm');
      const cancelBtn = document.getElementById('modal-cancel');

      if (!modal) { resolve(false); return; }

      titleEl.textContent = title;
      msgEl.textContent = message;
      modal.classList.remove('hidden');
      modal.classList.add('active');

      function cleanup(result) {
        modal.classList.add('hidden');
        modal.classList.remove('active');
        confirmBtn.removeEventListener('click', onConfirm);
        cancelBtn.removeEventListener('click', onCancel);
        resolve(result);
      }

      const onConfirm = () => cleanup(true);
      const onCancel  = () => cleanup(false);

      confirmBtn.addEventListener('click', onConfirm);
      cancelBtn.addEventListener('click', onCancel);

      // Cerrar con Escape
      const onKeydown = (e) => {
        if (e.key === 'Escape') { cleanup(false); document.removeEventListener('keydown', onKeydown); }
      };
      document.addEventListener('keydown', onKeydown);
    });
  }

  return { setLoading, showScreen, showView, showUploadError, hideUploadError, showToast, confirm };

})();

// ================================================================
// APP — Módulo Principal de Aplicación
// ================================================================
const App = (() => {

  // Estado de la aplicación
  let appData = null; // { programmers: {...}, loadedAt: string }
  let lastSnapshotJson = null;

  // ----------------------------------------------------------------
  // INICIALIZACIÓN
  // ----------------------------------------------------------------

  /**
   * Configura el toggle de tema claro/oscuro y restaura la preferencia guardada.
   */
  function setupTheme() {
    const THEME_KEY = 'prog_theme';
    const saved = localStorage.getItem(THEME_KEY);

    if (saved === 'light') {
      document.documentElement.setAttribute('data-theme', 'light');
      document.getElementById('theme-label').textContent = 'Tema oscuro';
    }

    document.getElementById('btn-theme-toggle')?.addEventListener('click', () => {
      const html = document.documentElement;
      const isLight = html.getAttribute('data-theme') === 'light';
      if (isLight) {
        html.removeAttribute('data-theme');
        localStorage.setItem(THEME_KEY, 'dark');
        document.getElementById('theme-label').textContent = 'Tema claro';
      } else {
        html.setAttribute('data-theme', 'light');
        localStorage.setItem(THEME_KEY, 'light');
        document.getElementById('theme-label').textContent = 'Tema oscuro';
      }
    });
  }

  /**
   * Inicializa Firebase y configura la sincronización en tiempo real.
   */
  function setupFirebaseSync() {
    const firebaseConfig = {
      apiKey: "AIzaSyAMQKrHDvK-XiPVuUWVKE9N2JK231P68BM",
      authDomain: "efectividad.firebaseapp.com",
      projectId: "efectividad",
      storageBucket: "efectividad.firebasestorage.app",
      messagingSenderId: "727705891475",
      appId: "1:727705891475:web:8bb241e2091648ad0a1366",
      measurementId: "G-K8SV40LSN7"
    };

    try {
      FirebaseDB.init(firebaseConfig);

      // Cada vez que Storage guarde en localStorage, también sube a Firestore
      Storage.setOnSaveCallback((data) => {
        FirebaseDB.saveData(data);
      });

      // Escuchar cambios remotos en tiempo real
      FirebaseDB.onRemoteChange((remoteData) => {
        const remoteJson = JSON.stringify(remoteData);
        // Evitar bucle: ignorar si es el mismo dato que ya tenemos
        if (remoteJson === lastSnapshotJson) return;
        lastSnapshotJson = remoteJson;

        // Actualizar localStorage y estado local
        Storage.saveData(remoteData);
        appData = remoteData;

        // Re-renderizar según la vista actual
        const viewDashboard = document.getElementById('view-dashboard');
        if (viewDashboard?.classList.contains('active')) {
          Dashboard.render(appData.programmers, navigateToProgrammer);
        } else {
          const currentName = document.getElementById('prog-name')?.textContent;
          if (currentName && appData.programmers[currentName]) {
            Tickets.render(currentName, appData.programmers[currentName]);
          }
        }

        UI.showToast('Datos actualizados por otro usuario', 'info', 2000);
      });

      // Cargar datos desde Firestore si existen
      FirebaseDB.loadData().then((remoteData) => {
        if (remoteData && remoteData.programmers) {
          Storage.saveData(remoteData);
          appData = remoteData;
          lastSnapshotJson = JSON.stringify(remoteData);
          goToDashboard();
        }
      });
    } catch (err) {
      console.warn('[App] Firebase no disponible, modo local:', err);
    }
  }

  /**
   * Punto de entrada. Se llama cuando el DOM está listo.
   */
  function init() {
    setupTheme();
    setupUploadScreen();
    setupSidebar();
    setupExportButtons();
    setupFirebaseSync();

    // Verificar si hay datos en localStorage
    if (!appData && Storage.hasData()) {
      const saved = Storage.loadData();
      if (saved && saved.programmers) {
        appData = saved;
        goToDashboard();
      } else {
        Storage.clearData();
        UI.showScreen('screen-upload');
      }
    } else if (!appData) {
      UI.showScreen('screen-upload');
    }
  }

  // ----------------------------------------------------------------
  // PANTALLA DE UPLOAD
  // ----------------------------------------------------------------

  /**
   * Configura todos los eventos de la pantalla de carga de archivos.
   */
  function setupUploadScreen() {
    const zone = document.getElementById('upload-zone');
    const fileInput = document.getElementById('file-input');

    if (!zone || !fileInput) return;

    // Clic en la zona → activar el input
    zone.addEventListener('click', (e) => {
      // Evitar activar si el clic fue en el input (ya se activa solo)
      if (e.target !== fileInput) fileInput.click();
    });

    // Accesibilidad: activar con teclado
    zone.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        fileInput.click();
      }
    });

    // Selección de archivo
    fileInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) handleFileSelected(file);
      fileInput.value = ''; // Resetear para permitir seleccionar el mismo archivo de nuevo
    });

    // Drag & Drop
    zone.addEventListener('dragover', (e) => {
      e.preventDefault();
      zone.classList.add('dragging');
    });

    zone.addEventListener('dragleave', (e) => {
      // Solo quitar la clase si el cursor sale completamente de la zona
      if (!zone.contains(e.relatedTarget)) {
        zone.classList.remove('dragging');
      }
    });

    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      zone.classList.remove('dragging');
      const file = e.dataTransfer.files[0];
      if (file) handleFileSelected(file);
    });

    // Botón de limpiar datos (dentro de la app)
    document.getElementById('btn-clear-data')?.addEventListener('click', handleClearData);
  }

  /**
   * Procesa el archivo seleccionado o arrastrado.
   * @param {File} file
   */
  async function handleFileSelected(file) {
    // 1. Validar el archivo antes de procesarlo
    const { valid, error } = Parser.validateFile(file);
    if (!valid) {
      UI.showUploadError(error);
      return;
    }

    UI.hideUploadError();
    UI.setLoading(true);

    try {
      // 2. Parsear el Excel con SheetJS
      const { data, errors } = await Parser.parseExcel(file);

      // 3. Informar sobre hojas con errores estructurales (no fatales)
      const errorSheets = Object.keys(errors);
      if (errorSheets.length > 0) {
        const msg = `Advertencia: Las hojas "${errorSheets.join('", "')}" fueron omitidas por formato incorrecto.`;
        console.warn('[App]', msg);
        UI.showToast(msg, 'info', 5000);
      }

      // 4. Verificar que haya al menos un programador con datos
      const totalProgrammers = Object.keys(data.programmers).length;
      if (totalProgrammers === 0) {
        throw new Error('No se encontraron hojas con datos válidos en el archivo.');
      }

      // 5. Guardar en localStorage y actualizar estado
      Storage.saveData(data);
      appData = data;

      const totalTickets = Object.values(data.programmers).flat().length;
      UI.showToast(
        `✓ Cargados ${totalProgrammers} programadores y ${totalTickets} tickets`,
        'success',
        4000
      );

      goToDashboard();

    } catch (err) {
      console.error('[App] Error al procesar el archivo:', err);
      UI.showUploadError(err.message || 'Error desconocido al procesar el archivo.');
    } finally {
      UI.setLoading(false);
    }
  }

  // ----------------------------------------------------------------
  // NAVEGACIÓN
  // ----------------------------------------------------------------

  /**
   * Navega a la vista del Dashboard principal.
   */
  function goToDashboard() {
    if (!appData) return;

    UI.showScreen('screen-app');
    UI.showView('view-dashboard');

    // Actualizar breadcrumb y topbar
    document.getElementById('topbar-breadcrumb').textContent = 'Dashboard';
    updateTopbarActions('dashboard');

    // Actualizar nav activo en sidebar
    updateActiveNav(null);

    // Renderizar el dashboard
    Dashboard.render(appData.programmers, navigateToProgrammer);
  }

  /**
   * Navega a la vista individual de un programador.
   * @param {string} programmerName
   */
  function navigateToProgrammer(programmerName) {
    if (!appData || !appData.programmers[programmerName]) {
      UI.showToast(`No se encontraron datos para "${programmerName}"`, 'error');
      return;
    }

    UI.showView('view-programmer');

    // Actualizar breadcrumb
    document.getElementById('topbar-breadcrumb').textContent = `Programadores › ${programmerName}`;
    updateTopbarActions('programmer');

    // Actualizar nav activo
    updateActiveNav(programmerName);

    // Cerrar sidebar en mobile
    closeSidebar();

    // Renderizar la vista del programador
    const tickets = appData.programmers[programmerName];
    Tickets.render(programmerName, tickets);

    // Scroll al inicio
    document.getElementById('main-content')?.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /**
   * Maneja el botón "Limpiar datos y cargar nuevo Excel".
   */
  async function handleClearData() {
    const confirmed = await UI.confirm(
      '¿Limpiar todos los datos?',
      'Se eliminarán todos los datos guardados incluyendo los estados de los tickets. Esta acción no se puede deshacer.'
    );

    if (confirmed) {
      Storage.clearData();
      appData = null;
      UI.showScreen('screen-upload');
      UI.hideUploadError();
      UI.showToast('Datos eliminados. Carga un nuevo archivo Excel.', 'info');
    }
  }

  // ----------------------------------------------------------------
  // SIDEBAR RESPONSIVO
  // ----------------------------------------------------------------

  /**
   * Configura el comportamiento responsivo del sidebar.
   */
  function setupSidebar() {
    const sidebar = document.getElementById('sidebar');
    const menuBtn = document.getElementById('menu-btn');
    const closeBtn = document.getElementById('sidebar-toggle');

    // Crear overlay para cerrar sidebar en mobile
    const overlay = document.createElement('div');
    overlay.className = 'sidebar-overlay';
    overlay.id = 'sidebar-overlay';
    document.body.appendChild(overlay);

    menuBtn?.addEventListener('click', () => {
      sidebar?.classList.add('open');
      overlay.classList.add('active');
    });

    closeBtn?.addEventListener('click', closeSidebar);
    overlay.addEventListener('click', closeSidebar);

    // Botón Dashboard en sidebar
    document.getElementById('nav-dashboard')?.addEventListener('click', () => {
      goToDashboard();
      closeSidebar();
    });
  }

  /**
   * Cierra el sidebar en mobile.
   */
  function closeSidebar() {
    document.getElementById('sidebar')?.classList.remove('open');
    document.getElementById('sidebar-overlay')?.classList.remove('active');
  }

  // ----------------------------------------------------------------
  // ACCIONES DE EXPORTACIÓN (TOPBAR)
  // ----------------------------------------------------------------

  /**
   * Actualiza los botones de acción en el topbar según la vista activa.
   * @param {'dashboard'|'programmer'} view
   */
  function updateTopbarActions(view) {
    const container = document.getElementById('topbar-actions');
    if (!container) return;
    // Los botones de exportación están dentro de las vistas, no en el topbar.
    // El topbar solo muestra breadcrumb. Limpiar si hay algo.
    container.innerHTML = '';
  }

  /**
   * Configura los botones de exportación (dashboard + programador).
   */
  function setupExportButtons() {
    // --- Dashboard: Exportar CSV Global ---
    document.getElementById('btn-export-csv-global')?.addEventListener('click', () => {
      if (!appData) return;
      try {
        Exporter.exportCSVConsolidated(appData.programmers);
        UI.showToast('CSV global descargado correctamente', 'success');
      } catch (err) {
        UI.showToast('Error al generar el CSV: ' + err.message, 'error');
      }
    });

    // --- Dashboard: Exportar PDF Global ---
    document.getElementById('btn-export-pdf-global')?.addEventListener('click', () => {
      if (!appData) return;
      try {
        const canvas = Dashboard.getBarChartCanvas();
        Exporter.exportPDFConsolidated(appData.programmers, canvas);
        UI.showToast('PDF global descargado correctamente', 'success');
      } catch (err) {
        console.error(err);
        UI.showToast('Error al generar el PDF: ' + err.message, 'error');
      }
    });

    // --- Programador: Exportar CSV Individual ---
    document.getElementById('btn-export-csv-prog')?.addEventListener('click', () => {
      const { name, tickets } = Tickets.getCurrentData();
      if (!name) return;
      try {
        Exporter.exportCSVIndividual(name, tickets);
        UI.showToast(`CSV de ${name} descargado`, 'success');
      } catch (err) {
        UI.showToast('Error al generar el CSV: ' + err.message, 'error');
      }
    });

    // --- Programador: Exportar PDF Individual ---
    document.getElementById('btn-export-pdf-prog')?.addEventListener('click', () => {
      const { name, tickets } = Tickets.getCurrentData();
      if (!name) return;
      try {
        Exporter.exportPDFIndividual(name, tickets);
        UI.showToast(`PDF de ${name} descargado`, 'success');
      } catch (err) {
        console.error(err);
        UI.showToast('Error al generar el PDF: ' + err.message, 'error');
      }
    });
  }

  // ----------------------------------------------------------------
  // HELPERS DE NAVEGACIÓN
  // ----------------------------------------------------------------

  /**
   * Actualiza el nav-item activo en el sidebar.
   * @param {string|null} programmerName - null para dashboard
   */
  function updateActiveNav(programmerName) {
    document.querySelectorAll('.nav-item').forEach(item => {
      item.classList.remove('active');
    });

    if (programmerName === null) {
      // Dashboard activo
      document.getElementById('nav-dashboard')?.classList.add('active');
    } else {
      // Programador activo
      const btn = document.querySelector(`#nav-programmers .nav-item[data-programmer="${programmerName}"]`);
      btn?.classList.add('active');
    }
  }

  // ----------------------------------------------------------------
  // API PÚBLICA
  // ----------------------------------------------------------------
  return {
    init,
    navigateToProgrammer,
    goToDashboard,
  };

})();

// ================================================================
// ARRANQUE DE LA APLICACIÓN
// ================================================================
document.addEventListener('DOMContentLoaded', () => {
  App.init();
});
