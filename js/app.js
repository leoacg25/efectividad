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
  let sharedViewName = null; // Nombre del programador en vista compartida
  let _viewingPlanification = null; // ID de planificación en vista (read-only), null si modo normal

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
  async function setupFirebaseSync() {
    try {
      FirebaseDB.init();

      Storage.setOnSaveCallback((data) => {
        FirebaseDB.saveData(data);
      });

      FirebaseDB.onRemoteChange((remoteData) => {
        const remoteJson = JSON.stringify(remoteData);
        if (remoteJson === lastSnapshotJson) return;
        lastSnapshotJson = remoteJson;

        Storage.saveData(remoteData);
        appData = remoteData;

        if (window.__localTipoChange) return;
        if (_viewingPlanification) return;

        if (sharedViewName && appData.programmers[sharedViewName]) {
          Tickets.render(sharedViewName, appData.programmers[sharedViewName], true);
        } else {
          const viewDashboard = document.getElementById('view-dashboard');
          if (viewDashboard?.classList.contains('active')) {
            Dashboard.render(appData.programmers, navigateToProgrammer, appData.profiles);
          } else {
            const currentName = document.getElementById('prog-name')?.textContent;
            if (currentName && appData.programmers[currentName]) {
              Tickets.render(currentName, appData.programmers[currentName]);
            }
          }
        }

        renderPosWebView();
        UI.showToast('Datos actualizados por otro usuario', 'info', 2000);
      });

      const remoteData = await FirebaseDB.loadData();
      if (remoteData && remoteData.programmers) {
        Storage.saveData(remoteData);
        appData = remoteData;
        lastSnapshotJson = JSON.stringify(remoteData);
        renderPosWebView();
        if (sharedViewName) {
          enterSharedView(sharedViewName);
        } else {
          goToDashboard();
        }
      } else {
        console.warn('[App] Firebase loadData: no data or no programmers');
      }
    } catch (err) {
      console.warn('[App] Firebase no disponible, modo local:', err);
    }
  }

  /**
   * Punto de entrada. Se llama cuando el DOM está listo.
   */
  function init() {
    // Detectar vista compartida por URL (?compartir=Nombre)
    const params = new URLSearchParams(window.location.search);
    sharedViewName = params.get('compartir') || null;

    setupTheme();
    setupUploadScreen();
    setupSidebar();
    setupExportButtons();
    setupAddProgrammerButton();
    setupPlanificationButton();
    setupPosWebView();

    // Inicializar Firebase app antes de auth o FirebaseDB
    initFirebase();

    if (sharedViewName) {
      // Vista compartida: no requiere autenticación
      initApp();
    } else {
      // Dashboard principal: requiere autenticación
      initAuth();
    }
  }

  /**
   * Inicializa la app de Firebase (una sola vez).
   */
  function initFirebase() {
    if (window.__firebaseInitialized) return;
    window.__firebaseInitialized = true;
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
      firebase.initializeApp(firebaseConfig);
    } catch (e) {
      console.warn('[App] Firebase init:', e);
    }
  }

  /**
   * Inicializa Firebase, datos locales y entra a la app.
   * Se llama tras confirmar autenticación o en vista compartida.
   */
  async function initApp() {
    await setupFirebaseSync();

    loadAppData();
  }

  /**
   * Carga datos desde localStorage y muestra la vista correspondiente.
   */
  function loadAppData() {
    if (!appData && Storage.hasData()) {
      const saved = Storage.loadData();
      if (saved && saved.programmers) {
        if (!saved.profiles) saved.profiles = {};
        appData = saved;
        renderPosWebView();
        if (sharedViewName) {
          enterSharedView(sharedViewName);
        } else {
          goToDashboard();
        }
      } else {
        Storage.clearData();
        UI.showScreen('screen-upload');
      }
    } else if (!appData) {
      UI.showScreen('screen-upload');
    }
  }

  /**
   * Configura la pantalla de login y espera autenticación.
   */
  function initAuth() {
    Auth.init();

    Auth.onAuthChange((user) => {
      if (user) {
        document.getElementById('btn-logout').classList.remove('hidden');
        UI.showScreen('screen-upload');
        initApp();
      } else {
        UI.showScreen('screen-login');
      }
    });

    // Formulario de login
    document.getElementById('login-form')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const email = document.getElementById('login-email').value;
      const password = document.getElementById('login-password').value;
      const errorEl = document.getElementById('login-error');
      errorEl.classList.add('hidden');

      Auth.signIn(email, password).catch((err) => {
        errorEl.textContent = authErrorMessage(err);
        errorEl.classList.remove('hidden');
      });
    });

    // Cerrar sesión
    document.getElementById('btn-logout')?.addEventListener('click', () => {
      Auth.signOut();
      document.getElementById('btn-logout').classList.add('hidden');
      sharedViewName = null;
      appData = null;
    });
  }

  /**
   * Traduce errores de Firebase Auth a mensajes legibles.
   * @param {Error} err
   * @returns {string}
   */
  function authErrorMessage(err) {
    const map = {
      'auth/user-not-found': 'No hay una cuenta con este correo',
      'auth/wrong-password': 'Contraseña incorrecta',
      'auth/invalid-email': 'Correo electrónico inválido',
      'auth/invalid-credential': 'Correo o contraseña incorrectos',
      'auth/too-many-requests': 'Demasiados intentos. Espera un momento',
      'auth/network-request-failed': 'Error de red. Verifica tu conexión',
    };
    return map[err.code] || 'Error al iniciar sesión. Intenta de nuevo.';
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

      // 5. Inicializar perfiles si no existen
      if (!data.profiles) data.profiles = {};

      // 6. Guardar en localStorage y actualizar estado
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

    Dashboard.render(appData.programmers, navigateToProgrammer, appData.profiles);
    renderProfiles();
    renderSavedPlanifications();
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

    // Renderizar la vista del programador (solo lectura si estamos viendo una planificación)
    const tickets = appData.programmers[programmerName];
    Tickets.render(programmerName, tickets, !!_viewingPlanification);

    // Scroll al inicio
    document.getElementById('main-content')?.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /**
   * Entra en modo vista compartida (solo lectura) para un programador.
   * @param {string} name
   */
  function enterSharedView(name) {
    if (!appData || !appData.programmers) {
      showSharedError('No hay datos cargados');
      return;
    }

    // Búsqueda insensible a mayúsculas
    const realName = Object.keys(appData.programmers).find(
      k => k.toLowerCase() === name.toLowerCase()
    );

    if (!realName) {
      showSharedError(`No se encontró "${name}"`);
      return;
    }

    // Actualizar sharedViewName con el nombre real (preservando mayúsculas)
    sharedViewName = realName;

    UI.showScreen('screen-app');
    UI.showView('view-programmer');

    // Ocultar sidebar completamente
    document.getElementById('sidebar').style.display = 'none';
    document.getElementById('menu-btn').style.display = 'none';
    document.getElementById('main-content').style.marginLeft = '0';

    // Breadcrumb simple
    document.getElementById('topbar-breadcrumb').textContent = `Vista compartida: ${realName}`;
    updateTopbarActions('programmer');

    // Agregar banner de solo lectura (evitar duplicados)
    const existing = document.getElementById('shared-banner');
    if (!existing) {
      const banner = document.createElement('div');
      banner.id = 'shared-banner';
      banner.className = 'shared-banner';
      banner.textContent = '🔍 Vista compartida — solo lectura';
      document.getElementById('main-content').insertBefore(
        banner,
        document.getElementById('main-content').firstChild
      );
    }

    // Renderizar vista del programador en modo solo lectura
    const tickets = appData.programmers[realName];
    Tickets.render(realName, tickets, true);
  }

  /**
   * Muestra pantalla de error limpia en vista compartida (sin exponer el dashboard).
   * @param {string} msg
   */
  function showSharedError(msg) {
    UI.showScreen('screen-app');
    UI.showView('view-programmer');
    document.getElementById('sidebar').style.display = 'none';
    document.getElementById('menu-btn').style.display = 'none';
    document.getElementById('main-content').style.marginLeft = '0';
    document.getElementById('topbar-breadcrumb').textContent = 'Vista compartida';

    const existing = document.getElementById('shared-banner');
    if (!existing) {
      const banner = document.createElement('div');
      banner.id = 'shared-banner';
      banner.className = 'shared-banner shared-banner--error';
      document.getElementById('main-content').insertBefore(
        banner,
        document.getElementById('main-content').firstChild
      );
    }

    // Ocultar secciones editables y mostrar solo el error
    document.getElementById('prog-header')?.classList.add('hidden');
    document.getElementById('prog-tickets-section')?.classList.add('hidden');

    const banner = document.getElementById('shared-banner');
    if (banner) banner.textContent = `⚠️ ${msg}`;
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
    container.innerHTML = '';
    if (view === 'posweb') {
      return;
    }
    if (_viewingPlanification) {
      const loadBtn = document.createElement('button');
      loadBtn.className = 'btn btn--primary btn--sm';
      loadBtn.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" width="14" height="14">
          <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/>
        </svg>
        Cargar planificación
      `;
      loadBtn.addEventListener('click', () => {
        openPasswordModal(_viewingPlanification);
      });
      container.appendChild(loadBtn);

      const exitBtn = document.createElement('button');
      exitBtn.className = 'btn btn--outline btn--sm';
      exitBtn.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" width="14" height="14">
          <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9"/>
        </svg>
        Salir de vista
      `;
      exitBtn.addEventListener('click', exitPlanificationView);
      container.appendChild(exitBtn);
    }
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

    // --- Dashboard: Exportar CSV Global de Pruebas ---
    document.getElementById('btn-export-csv-pruebas')?.addEventListener('click', () => {
      if (!appData) return;
      try {
        Exporter.exportCSVPruebas(appData.programmers, appData.profiles || {});
        UI.showToast('CSV de pruebas descargado correctamente', 'success');
      } catch (err) {
        UI.showToast('Error al generar el CSV de pruebas: ' + err.message, 'error');
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

    // --- Exportar BD como JSON ---
    document.getElementById('btn-export-json')?.addEventListener('click', () => {
      if (!appData) { UI.showToast('No hay datos para exportar', 'error'); return; }
      try {
        const json = JSON.stringify(appData, null, 2);
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `efectividad_backup_${new Date().toISOString().slice(0,10)}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        UI.showToast('Respaldo JSON descargado', 'success');
      } catch (err) {
        UI.showToast('Error al exportar: ' + err.message, 'error');
      }
    });

    // --- Importar BD desde JSON ---
    const jsonInput = document.getElementById('file-json-input');
    document.getElementById('btn-import-json')?.addEventListener('click', () => {
      jsonInput?.click();
    });
    jsonInput?.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        try {
          const data = JSON.parse(ev.target.result);
          if (!data || !data.programmers || typeof data.programmers !== 'object') {
            throw new Error('Formato inválido: debe contener "programmers"');
          }
          Storage.saveData(data);
          appData = data;
          UI.showToast('Datos restaurados correctamente', 'success');
          goToDashboard();
        } catch (err) {
          UI.showToast('Error al importar: ' + err.message, 'error');
        }
      };
      reader.readAsText(file);
      e.target.value = '';
    });
  }

  // ----------------------------------------------------------------
  // GESTIÓN DE PERFILES
  // ----------------------------------------------------------------

  /**
   * Renderiza los perfiles especiales (QA / Líder Técnico) en el sidebar.
   */
  function renderProfiles() {
    const container = document.getElementById('nav-profiles');
    if (!container || !appData) return;

    const profiles = appData.profiles || {};
    const specials = Object.entries(profiles).filter(([, role]) => role !== 'desarrollador');

    if (specials.length === 0) {
      container.innerHTML = `<button class="profile-add-btn" id="btn-add-profile">+</button>`;
      document.getElementById('btn-add-profile')?.addEventListener('click', promptAddProfile);
      return;
    }

    // Calcular promedio de efectividad de todos los desarrolladores
    const devs = Object.entries(appData.programmers).filter(
      ([name]) => !profiles[name] || profiles[name] === 'desarrollador'
    );
    let totalPct = 0;
    for (const [, tickets] of devs) {
      const stats = Dashboard.calcStats(tickets);
      totalPct += stats.pct;
    }
    const avgPct = devs.length > 0 ? totalPct / devs.length : 0;
    const displayPct = avgPct.toFixed(2);
    const theme = avgPct >= 75 ? 'green' : avgPct >= 40 ? 'yellow' : 'red';

    container.innerHTML = specials.map(([name, role]) => {
      const label = role === 'lider' ? 'Líder Técnico' : 'Evaluación';
      return `
        <div class="profile-row">
          <div class="profile-info">
            <span class="profile-name">${name}</span>
            <span class="profile-role">${label}</span>
          </div>
          <span class="effectiveness-badge effectiveness-badge--${theme}">${displayPct}%</span>
          <span class="profile-edit-btn" title="Cambiar rol" onclick="App.editProfile('${name.replace(/'/g, "\\'")}')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12">
              <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
              <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
            </svg>
          </span>
          <span class="profile-delete-btn" title="Eliminar" onclick="event.stopPropagation();App.deleteProfile('${name.replace(/'/g, "\\'")}')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12">
              <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>
            </svg>
          </span>
        </div>
      `;
    }).join('') + `<button class="profile-add-btn" id="btn-add-profile">+</button>`;

    document.getElementById('btn-add-profile')?.addEventListener('click', promptAddProfile);
  }

  /**
   * Pide nombre y rol para agregar una persona especial.
   */
  function promptAddProfile() {
    if (!appData) { UI.showToast('Carga datos primero', 'error'); return; }
    const name = prompt('Nombre:');
    if (!name || !name.trim()) return;
    const trimmed = name.trim();
    if (appData.programmers[trimmed]) {
      UI.showToast(`"${trimmed}" ya existe`, 'error');
      return;
    }
    const role = prompt('Rol (lider / evaluacion):');
    if (!role || !['lider', 'evaluacion'].includes(role.trim().toLowerCase())) {
      UI.showToast('Rol inválido. Usa "lider" o "evaluacion"', 'error');
      return;
    }
    appData.programmers[trimmed] = [];
    if (!appData.profiles) appData.profiles = {};
    appData.profiles[trimmed] = role.trim().toLowerCase();
    Storage.saveData(appData);
    UI.showToast(`"${trimmed}" agregado como ${role}`, 'success');
    goToDashboard();
  }

  /**
   * Edita el rol de un perfil especial.
   * @param {string} name
   */
  function editProfile(name) {
    if (!appData || !appData.profiles || !appData.profiles[name]) return;
    const role = prompt(`Nuevo rol para "${name}" (lider / evaluacion):`, appData.profiles[name]);
    if (!role || !['lider', 'evaluacion'].includes(role.trim().toLowerCase())) {
      UI.showToast('Rol inválido. Usa "lider" o "evaluacion"', 'error');
      return;
    }
    appData.profiles[name] = role.trim().toLowerCase();
    Storage.saveData(appData);
    UI.showToast(`"${name}" ahora es ${role}`, 'success');
    goToDashboard();
  }

  /**
   * Elimina un perfil especial con confirmación.
   * @param {string} name
   */
  async function deleteProfile(name) {
    if (!appData || !appData.profiles || !appData.profiles[name]) return;
    const confirmed = await UI.confirm(
      `¿Eliminar a "${name}"?`,
      `Se eliminará su perfil especial y todos sus tickets.`
    );
    if (!confirmed) return;
    delete appData.programmers[name];
    delete appData.profiles[name];
    Storage.saveData(appData);
    UI.showToast(`"${name}" eliminado`, 'success');
    goToDashboard();
  }

  /**
   * Configura el botón "Agregar programador de línea" en el sidebar.
   */
  function setupAddProgrammerButton() {
    const btn = document.getElementById('btn-add-programmer');
    const pContainer = document.getElementById('nav-profiles');
    if (btn) btn.remove();

    // Crear botón fijo en nav-programmers
    const navProg = document.getElementById('nav-programmers');
    if (!navProg) return;
    const addBtn = document.createElement('button');
    addBtn.className = 'nav-item nav-item--add';
    addBtn.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" width="14" height="14">
        <path d="M12 5v14M5 12h14"/>
      </svg>
      <span>Agregar programador</span>
    `;
    addBtn.addEventListener('click', () => {
      if (!appData) { UI.showToast('Carga datos primero', 'error'); return; }
      const name = prompt('Nombre del nuevo programador:');
      if (!name || !name.trim()) return;
      const trimmed = name.trim();
      if (appData.programmers[trimmed]) {
        UI.showToast(`"${trimmed}" ya existe`, 'error');
        return;
      }
      appData.programmers[trimmed] = [];
      if (!appData.profiles) appData.profiles = {};
      appData.profiles[trimmed] = 'desarrollador';
      Storage.saveData(appData);
      UI.showToast(`"${trimmed}" agregado`, 'success');
      goToDashboard();
    });
    navProg.appendChild(addBtn);
  }

  // ----------------------------------------------------------------
  // HELPERS DE NAVEGACIÓN
  // ----------------------------------------------------------------

  /**
   * Actualiza el nav-item activo en el sidebar.
   * @param {string|null} programmerName - null para dashboard
   */
  function updateActiveNav(programmerName, activeView = null) {
    document.querySelectorAll('.nav-item').forEach(item => {
      item.classList.remove('active');
    });

    if (activeView === 'posweb') {
      document.getElementById('nav-posweb')?.classList.add('active');
      return;
    }

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
  // PLANIFICACIONES GUARDADAS
  // ----------------------------------------------------------------

  let _posWebState = null;
  let _posWebFilters = { status: 'Todos', search: '' };

  /**
   * Configura la vista de Pos Web y sus acciones.
   */
  function setupPosWebView() {
    const addBtn = document.getElementById('posweb-add-case');
    const ticketInput = document.getElementById('posweb-ticket-input');
    const descriptionInput = document.getElementById('posweb-description-input');
    const typeSelect = document.getElementById('posweb-type-select');
    const statusSelect = document.getElementById('posweb-status-select');
    const programmerSelect = document.getElementById('posweb-programmer');
    const saveBtn = document.getElementById('posweb-save');
    const downloadTemplateBtn = document.getElementById('posweb-download-template');
    const importBtn = document.getElementById('posweb-import');
    const exportExcelBtn = document.getElementById('posweb-export-excel');
    const exportPdfBtn = document.getElementById('posweb-export-pdf');
    const fileInput = document.getElementById('posweb-file-input');
    const searchInput = document.getElementById('posweb-search');

    if (!addBtn || !ticketInput || !descriptionInput || !typeSelect || !statusSelect || !programmerSelect || !saveBtn) return;

    addBtn.addEventListener('click', () => {
      const ticket = ticketInput.value.trim();
      const description = descriptionInput.value.trim();
      const type = typeSelect.value;
      const status = statusSelect.value;
      if (!description) {
        UI.showToast('Ingresa una descripción para agregar el caso', 'error');
        descriptionInput.focus();
        return;
      }

      const state = getPosWebState();
      state.cases.push({
        id: `case_${Date.now()}`,
        ticket: ticket || 'Sin ticket',
        description,
        type,
        status,
        programmer: programmerSelect.value,
      });
      savePosWebState(state);
      ticketInput.value = '';
      descriptionInput.value = '';
      typeSelect.value = 'Mejora';
      statusSelect.value = 'No resuelto';
      descriptionInput.focus();
      UI.showToast('Caso agregado', 'success');
    });

    [ticketInput, descriptionInput].forEach(input => {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          addBtn.click();
        }
      });
    });

    programmerSelect.addEventListener('change', () => {
      const state = getPosWebState();
      state.programmer = programmerSelect.value;
      savePosWebState(state);
    });

    document.getElementById('posweb-add-programmer')?.addEventListener('click', () => {
      const name = prompt('Nombre del programador:');
      if (name && name.trim()) {
        const trimmed = name.trim();
        const exists = [...select.options].some(opt => opt.value === trimmed);
        if (!exists) {
          const opt = document.createElement('option');
          opt.value = trimmed;
          opt.textContent = trimmed;
          select.appendChild(opt);
        }
        select.value = trimmed;
        const state = getPosWebState();
        state.programmer = trimmed;
        savePosWebState(state);
      }
    });

    saveBtn.addEventListener('click', () => {
      const state = getPosWebState();
      state.programmer = programmerSelect.value;
      savePosWebState(state);
      UI.showToast('Pos Web guardado', 'success');
    });

    document.getElementById('nav-posweb')?.addEventListener('click', () => {
      openPosWebView();
      closeSidebar();
    });

    document.querySelectorAll('#view-posweb .filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#view-posweb .filter-btn').forEach(item => item.classList.toggle('active', item === btn));
        _posWebFilters.status = btn.getAttribute('data-filter') || 'Todos';
        renderPosWebView();
      });
    });

    searchInput?.addEventListener('input', () => {
      _posWebFilters.search = searchInput.value;
      renderPosWebView();
    });

    downloadTemplateBtn?.addEventListener('click', downloadPosWebTemplate);
    importBtn?.addEventListener('click', () => fileInput?.click());
    exportExcelBtn?.addEventListener('click', exportPosWebExcel);
    exportPdfBtn?.addEventListener('click', exportPosWebPdf);
    fileInput?.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (file) {
        importPosWebFile(file);
      }
      e.target.value = '';
    });

    renderPosWebView();
  }

  function getPosWebState() {
    if (_posWebState) return _posWebState;
    const saved = Storage.loadPosWebData();
    _posWebState = saved && typeof saved === 'object'
      ? { programmer: saved.programmer || '', cases: Array.isArray(saved.cases) ? saved.cases : [] }
      : { programmer: '', cases: [] };
    return _posWebState;
  }

  function savePosWebState(state) {
    _posWebState = {
      programmer: state?.programmer || '',
      cases: Array.isArray(state?.cases) ? state.cases : [],
    };
    Storage.savePosWebData(_posWebState);
    renderPosWebView();
  }

  function getFilteredPosWebCases(state) {
    const searchTerm = (_posWebFilters.search || '').trim().toLowerCase();

    return (state.cases || []).filter(item => {
      const normalizedStatus = String(item.status || 'No resuelto').trim();
      const matchesStatus = _posWebFilters.status === 'Todos'
        || normalizedStatus === _posWebFilters.status
        || (_posWebFilters.status === 'En proceso' && normalizedStatus === 'En proceso');

      const haystack = `${item.ticket || ''} ${item.description || ''} ${item.type || ''} ${normalizedStatus}`.toLowerCase();
      const matchesSearch = !searchTerm || haystack.includes(searchTerm);
      return matchesStatus && matchesSearch;
    });
  }

  function renderPosWebView() {
    const state = getPosWebState();
    const select = document.getElementById('posweb-programmer');
    const count = document.getElementById('posweb-count');
    const tbody = document.getElementById('posweb-tbody');
    const progressBadge = document.getElementById('posweb-progress-badge');
    const progressFill = document.getElementById('posweb-progress-fill');
    const summary = document.getElementById('posweb-summary');
    const ringLabel = document.getElementById('posweb-ring-label');
    const ringFill = document.getElementById('posweb-ring-fill');

    if (!select || !tbody) return;

    document.querySelectorAll('#view-posweb .filter-btn').forEach(btn => {
      btn.classList.toggle('active', (btn.getAttribute('data-filter') || 'Todos') === _posWebFilters.status);
    });

    if (!appData && Storage.hasData()) {
      const saved = Storage.loadData();
      if (saved && saved.programmers) {
        appData = saved;
      }
    }

    let programmerNames = appData && appData.programmers ? Object.keys(appData.programmers) : [];
    const casesProgrammers = [...new Set((state.cases || []).map(c => c.programmer).filter(Boolean))];
    if (casesProgrammers.length) {
      programmerNames = [...new Set([...programmerNames, ...casesProgrammers])];
    }

    select.innerHTML = '<option value="">Selecciona un programador</option>';

    let debugEl = document.getElementById('posweb-debug-names');
    if (debugEl) debugEl.textContent = programmerNames.length ? `Programadores cargados: ${programmerNames.join(', ')}` : 'Sin programadores';

    programmerNames.forEach(name => {
      const option = document.createElement('option');
      option.value = name;
      option.textContent = name;
      select.appendChild(option);
    });

    select.value = programmerNames.includes(state.programmer) ? state.programmer : '';
    const visibleCases = getFilteredPosWebCases(state);
    const validCases = visibleCases.filter(item => item.status !== 'No Aplica' && item.status !== 'Información Adicional');
    const effectiveTotal = validCases.length;
    const solved = validCases.filter(item => item.status === 'Solventado').length;
    const pct = effectiveTotal > 0 ? Math.round((solved / effectiveTotal) * 100) : 0;

    if (progressBadge) progressBadge.textContent = `${pct}%`;
    if (progressFill) progressFill.style.width = `${pct}%`;
    if (ringLabel) ringLabel.innerHTML = `${pct}%<small>avance</small>`;
    if (ringFill) {
      const circumference = 314;
      const offset = circumference - (pct / 100) * circumference;
      ringFill.style.strokeDasharray = `${circumference}`;
      ringFill.style.strokeDashoffset = `${offset}`;
      ringFill.style.stroke = pct >= 75 ? '#10b981' : pct >= 40 ? '#f59e0b' : '#ef4444';
    }
    if (summary) {
      summary.innerHTML = `
        <strong>${solved}</strong> solventados / <strong>${effectiveTotal}</strong> casos válidos<br/>
        <span>No aplica e info. adicional se excluyen del cálculo del porcentaje.</span>
      `;
    }

    count.textContent = `${visibleCases.length} caso${visibleCases.length === 1 ? '' : 's'}`;

    if (visibleCases.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6"><div class="posweb-empty-state">No hay casos que coincidan con el filtro actual.</div></td></tr>';
      return;
    }

    const typeOpts = ['Mejora', 'Falla'];
    const statusOpts = ['No resuelto', 'En proceso', 'Solventado', 'No Aplica', 'Información Adicional'];

    tbody.innerHTML = visibleCases.map(item => `
      <tr>
        <td>${escHtml(item.programmer || '—')}</td>
        <td>${escHtml(item.ticket || 'Sin ticket')}</td>
        <td><span class="posweb-editable" tabindex="0" data-case-id="${escHtml(item.id)}" data-field="description">${escHtml(item.description || '')}</span></td>
        <td><select class="posweb-inline-select posweb-type-select" data-case-id="${escHtml(item.id)}">${typeOpts.map(t => `<option value="${t}"${item.type === t ? ' selected' : ''}>${t}</option>`).join('')}</select></td>
        <td><select class="posweb-inline-select posweb-status-select" data-case-id="${escHtml(item.id)}">${statusOpts.map(s => `<option value="${s}"${item.status === s ? ' selected' : ''}>${s}</option>`).join('')}</select></td>
        <td>
          <button class="posweb-case-remove" data-case-id="${escHtml(item.id || '')}" title="Eliminar caso" type="button">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" width="14" height="14">
              <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>
            </svg>
          </button>
        </td>
      </tr>
    `).join('');

    tbody.querySelectorAll('.posweb-case-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        const caseId = btn.getAttribute('data-case-id');
        const nextState = getPosWebState();
        nextState.cases = nextState.cases.filter(c => String(c.id) !== String(caseId));
        savePosWebState(nextState);
        UI.showToast('Caso eliminado', 'info');
      });
    });

    tbody.querySelectorAll('.posweb-editable').forEach(span => {
      const caseId = span.dataset.caseId;
      const field = span.dataset.field;
      span.addEventListener('click', function onClick() {
        if (this.dataset.editing === 'true') return;
        this.dataset.editing = 'true';
        const currentValue = this.textContent;
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'posweb-inline-input';
        input.value = currentValue;
        this.textContent = '';
        this.appendChild(input);
        input.focus();
        input.select();

        const save = () => {
          this.dataset.editing = 'false';
          const newVal = input.value.trim();
          const state = getPosWebState();
          const c = state.cases.find(c => String(c.id) === String(caseId));
          if (c) {
            c[field] = newVal;
            savePosWebState(state);
            UI.showToast('Descripción actualizada', 'success');
          } else {
            this.textContent = currentValue;
          }
        };

        input.addEventListener('blur', save);
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); save(); }
          if (e.key === 'Escape') { e.preventDefault(); this.dataset.editing = 'false'; this.textContent = currentValue; }
        });
      });
    });

    tbody.querySelectorAll('.posweb-type-select, .posweb-status-select').forEach(sel => {
      sel.addEventListener('change', () => {
        const caseId = sel.dataset.caseId;
        const field = sel.classList.contains('posweb-type-select') ? 'type' : 'status';
        const state = getPosWebState();
        const c = state.cases.find(c => String(c.id) === String(caseId));
        if (c) {
          c[field] = sel.value;
          savePosWebState(state);
          UI.showToast(`${field === 'type' ? 'Tipo' : 'Estado'} actualizado`, 'success');
        }
      });
    });
  }

  function openPosWebView() {
    UI.showScreen('screen-app');
    UI.showView('view-posweb');
    document.getElementById('topbar-breadcrumb').textContent = 'Pos Web';
    updateTopbarActions('posweb');
    updateActiveNav(null, 'posweb');
    renderPosWebView();
  }

  function downloadPosWebTemplate() {
    try {
      const wb = XLSX.utils.book_new();
      const headers = [['Programador encargado', 'Número de ticket', 'Descripción', 'Tipo', 'Estatus']];
      const ws = XLSX.utils.aoa_to_sheet(headers);
      ws['!cols'] = [{ wch: 24 }, { wch: 16 }, { wch: 40 }, { wch: 12 }, { wch: 20 }];
      XLSX.utils.book_append_sheet(wb, ws, 'Pos Web');
      XLSX.writeFile(wb, 'plantilla_pos_web.xlsx');
      UI.showToast('Plantilla descargada', 'success');
    } catch (err) {
      UI.showToast('Error al generar la plantilla: ' + err.message, 'error');
    }
  }

  function exportPosWebExcel() {
    try {
      const state = getPosWebState();
      const rows = getFilteredPosWebCases(state).map(item => [
        item.programmer || state.programmer || '',
        item.ticket || '',
        item.description || '',
        item.type || 'Mejora',
        item.status || 'No resuelto',
      ]);
      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.aoa_to_sheet([['Programador encargado', 'Número de ticket', 'Descripción', 'Tipo', 'Estatus'], ...rows]);
      ws['!cols'] = [{ wch: 16 }, { wch: 40 }, { wch: 12 }, { wch: 20 }, { wch: 24 }];
      XLSX.utils.book_append_sheet(wb, ws, 'Pos Web');
      XLSX.writeFile(wb, 'posweb_export.xlsx');
      UI.showToast('Excel exportado', 'success');
    } catch (err) {
      UI.showToast('Error al exportar Excel: ' + err.message, 'error');
    }
  }

  function exportPosWebPdf() {
    try {
      const state = getPosWebState();
      const rows = getFilteredPosWebCases(state).map((item, index) => [
        index + 1,
        item.programmer || state.programmer || '—',
        item.ticket || '',
        item.description || '',
        item.type || 'Mejora',
        item.status || 'No resuelto',
      ]);
      const { jsPDF } = window.jspdf;
      const doc = new jsPDF();
      doc.setFontSize(18);
      doc.text('Reporte Pos Web', 14, 20);
      doc.setFontSize(11);
      doc.text(`Programador encargado: ${state.programmer || 'Sin asignar'}`, 14, 30);
      doc.text(`Casos mostrados: ${rows.length}`, 14, 38);
      if (doc.autoTable) {
        doc.autoTable({
          startY: 45,
          head: [['#', 'Programador', 'Ticket', 'Descripción', 'Tipo', 'Estatus']],
          body: rows,
          styles: { fontSize: 9 },
          headStyles: { fillColor: [99, 102, 241] },
        });
      } else {
        let y = 45;
        rows.forEach((row) => {
          doc.text(row.join(' | '), 14, y);
          y += 8;
        });
      }
      doc.save('posweb_reporte.pdf');
      UI.showToast('PDF exportado', 'success');
    } catch (err) {
      UI.showToast('Error al exportar PDF: ' + err.message, 'error');
    }
  }

  async function importPosWebFile(file) {
    try {
      const ext = file.name.toLowerCase().split('.').pop();
      let rows = [];

      if (ext === 'json') {
        const text = await file.text();
        const parsed = JSON.parse(text);
        rows = Array.isArray(parsed) ? parsed : (parsed.cases || []);
      } else {
        const buffer = await file.arrayBuffer();
        const workbook = XLSX.read(buffer, { type: 'array' });
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
      }

      const state = getPosWebState();
      const importedCases = rows.map((row, index) => {
        const normalized = Object.keys(row).reduce((acc, key) => {
          acc[key.toLowerCase().normalize('NFKD').replace(/[^\w]/g, '').replace(/ /g, '')] = row[key];
          return acc;
        }, {});

        const ticket = normalized.numerodeticket || normalized.ticket || normalized.nroticket || `Caso ${index + 1}`;
        const description = normalized.descripcion || normalized.description || normalized.detalle || '';
        const type = normalized.tipo || normalized.tipodeticket || normalized.tipodeTicket || 'Mejora';
        const status = normalized.estatus || normalized.status || 'No resuelto';
        const programmer = normalized.programadorencargado || normalized.programador || normalized.responsable || state.programmer || '';

        return {
          id: `case_${Date.now()}_${index}`,
          ticket: String(ticket),
          description: String(description),
          type: String(type),
          status: String(status),
          programmer: String(programmer),
        };
      }).filter(item => item.description);

      if (importedCases.length === 0) {
        throw new Error('No se encontraron datos válidos para importar.');
      }

      state.programmer = importedCases[0].programmer || state.programmer || '';
      state.cases = importedCases;
      savePosWebState(state);
      UI.showToast(`Importados ${importedCases.length} casos`, 'success');
    } catch (err) {
      UI.showToast('Error al importar: ' + err.message, 'error');
    }
  }

  /**
   * Configura el botón "Efectividad evaluada" y los modales relacionados.
   */
  function setupPlanificationButton() {
    const btn = document.getElementById('btn-save-planification');
    if (!btn) return;

    btn.addEventListener('click', () => {
      if (!appData) { UI.showToast('No hay datos para guardar', 'error'); return; }
      openSavePlanModal();
    });

    // Modal guardar
    document.getElementById('save-plan-close')?.addEventListener('click', closeSavePlanModal);
    document.getElementById('save-plan-cancel')?.addEventListener('click', closeSavePlanModal);
    document.getElementById('save-plan-confirm')?.addEventListener('click', confirmSavePlan);
    document.getElementById('save-plan-name')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') confirmSavePlan();
      if (e.key === 'Escape') closeSavePlanModal();
    });

    // Modal "guardado exitoso"
    document.getElementById('plan-saved-close')?.addEventListener('click', closePlanSavedModal);
    document.getElementById('plan-saved-done')?.addEventListener('click', closePlanSavedModal);
    document.getElementById('plan-saved-view')?.addEventListener('click', () => {
      closePlanSavedModal();
      if (_lastSavedPlanId) viewPlanification(_lastSavedPlanId);
    });
    document.getElementById('plan-saved-new')?.addEventListener('click', () => {
      closePlanSavedModal();
      openNewPlanningModal();
    });

    // Modal nueva planificación
    document.getElementById('new-plan-close')?.addEventListener('click', closeNewPlanningModal);
    document.getElementById('new-plan-cancel')?.addEventListener('click', closeNewPlanningModal);
    document.getElementById('new-plan-download-template')?.addEventListener('click', downloadTemplate);
    document.getElementById('new-plan-start')?.addEventListener('click', startNewPlanning);

    // Modal password
    document.getElementById('password-modal-close')?.addEventListener('click', closePasswordModal);
    document.getElementById('password-modal-cancel')?.addEventListener('click', closePasswordModal);
    document.getElementById('password-modal-confirm')?.addEventListener('click', confirmPassword);
    document.getElementById('password-pass')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') confirmPassword();
      if (e.key === 'Escape') closePasswordModal();
    });

    // Cerrar modales con clic en overlay
    document.querySelectorAll('.modal-overlay').forEach(overlay => {
      overlay.addEventListener('mousedown', (e) => {
        if (e.target === overlay) {
          overlay.classList.add('hidden');
          overlay.classList.remove('active');
        }
      });
    });
  }

  let _lastSavedPlanId = null;
  let _pendingResumePlanId = null;

  // --- Guardar planificación ---

  function openSavePlanModal() {
    const modal = document.getElementById('save-plan-modal');
    const input = document.getElementById('save-plan-name');
    const now = new Date();
    const meses = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
    input.value = `Efectividad ${meses[now.getMonth()]} ${now.getFullYear()}`;
    modal.classList.remove('hidden');
    modal.classList.add('active');
    setTimeout(() => input?.focus(), 100);
  }

  function closeSavePlanModal() {
    document.getElementById('save-plan-modal')?.classList.add('hidden');
    document.getElementById('save-plan-modal')?.classList.remove('active');
  }

  function confirmSavePlan() {
    const input = document.getElementById('save-plan-name');
    const name = input.value.trim();
    if (!name) { UI.showToast('Ingresa un nombre para la planificación', 'error'); input.focus(); return; }

    try {
      const plan = Storage.savePlanification(name);
      _lastSavedPlanId = plan.id;
      UI.showToast(`"${name}" guardada correctamente`, 'success', 3000);
      closeSavePlanModal();
      renderSavedPlanifications();
      // Mostrar modal de opciones post-guardado
      document.getElementById('plan-saved-modal').classList.remove('hidden');
      document.getElementById('plan-saved-modal').classList.add('active');
    } catch (err) {
      UI.showToast('Error al guardar: ' + err.message, 'error');
    }
  }

  function closePlanSavedModal() {
    document.getElementById('plan-saved-modal')?.classList.add('hidden');
    document.getElementById('plan-saved-modal')?.classList.remove('active');
  }

  // --- Renderizar planificaciones guardadas en sidebar ---

  function renderSavedPlanifications() {
    const container = document.getElementById('nav-planifications');
    const section = document.getElementById('nav-planifications-section');
    if (!container || !section) return;

    const plans = Storage.getAllPlanifications();
    if (plans.length === 0) {
      section.classList.add('hidden');
      return;
    }

    section.classList.remove('hidden');
    container.innerHTML = plans.slice().reverse().map(p => {
      const d = new Date(p.timestamp);
      const fecha = d.toLocaleDateString('es-VE', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
      const isViewing = _viewingPlanification === p.id;
      return `
        <div class="plan-item ${isViewing ? 'plan-item--viewing' : ''}" data-plan-id="${p.id}">
          <div class="plan-info">
            <span class="plan-name">${escHtml(p.name)}</span>
            <span class="plan-date">${fecha}${isViewing ? ' · Viendo' : ''}</span>
          </div>
          ${isViewing ? '<span class="plan-view-badge plan-view-badge--viewing">VIENDO</span>' : ''}
          <span class="plan-delete-btn" title="Eliminar planificación" onclick="event.stopPropagation();App.deletePlanification('${p.id}')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="10" height="10">
              <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>
            </svg>
          </span>
        </div>
      `;
    }).join('');

    // Click para ver planificación
    container.querySelectorAll('.plan-item').forEach(el => {
      el.addEventListener('click', () => {
        const pid = el.dataset.planId;
        const plan = Storage.getPlanification(pid);
        if (!plan) { UI.showToast('Planificación no encontrada', 'error'); return; }
        if (_viewingPlanification === pid) {
          // Ya la estamos viendo, salir del modo vista
          exitPlanificationView();
        } else {
          viewPlanification(pid);
        }
      });
    });
  }

  // --- Ver planificación guardada (read-only) ---

  function viewPlanification(planId) {
    const plan = Storage.getPlanification(planId);
    if (!plan) { UI.showToast('Planificación no encontrada', 'error'); return; }

    _viewingPlanification = planId;

    // Reemplazar appData temporalmente con los datos de la planificación
    // SIN guardar a localStorage para no perder los datos activos
    appData = {
      programmers: JSON.parse(JSON.stringify(plan.data.programmers)),
      profiles: JSON.parse(JSON.stringify(plan.data.profiles || {})),
      _planRef: plan.id,
    };

    UI.showToast(`Viendo: ${plan.name}`, 'info', 3000);
    renderSavedPlanifications();
    goToDashboard();

    // Mostrar badge indicador en el dashboard
    const breadcrumb = document.getElementById('topbar-breadcrumb');
    if (breadcrumb) {
      breadcrumb.innerHTML = `Dashboard <span class="plan-viewing-badge">🔍 ${escHtml(plan.name)}</span>`;
    }
  }

  function exitPlanificationView() {
    if (!_viewingPlanification) return;
    _viewingPlanification = null;

    // Recargar datos actuales desde localStorage
    const saved = Storage.loadData();
    if (saved && saved.programmers) {
      if (!saved.profiles) saved.profiles = {};
      appData = saved;
    }
    renderSavedPlanifications();
    goToDashboard();
    UI.showToast('Has salido del modo vista', 'info', 2000);
  }

  // --- Eliminar planificación ---

  async function deletePlanification(planId) {
    const plan = Storage.getPlanification(planId);
    if (!plan) return;
    const confirmed = await UI.confirm(
      'Eliminar planificación',
      `¿Eliminar "${plan.name}"? Esta acción no se puede deshacer.`
    );
    if (!confirmed) return;

    if (_viewingPlanification === planId) {
      exitPlanificationView();
    }
    Storage.deletePlanification(planId);
    renderSavedPlanifications();
    UI.showToast('Planificación eliminada', 'success');
  }

  // --- Nueva planificación (modal parámetros + plantilla) ---

  function openNewPlanningModal() {
    const input = document.getElementById('new-plan-period');
    const now = new Date();
    const meses = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
    input.value = `${meses[now.getMonth()]} ${now.getFullYear()}`;
    document.getElementById('new-plan-modal').classList.remove('hidden');
    document.getElementById('new-plan-modal').classList.add('active');
    setTimeout(() => input?.focus(), 100);
  }

  function closeNewPlanningModal() {
    document.getElementById('new-plan-modal')?.classList.add('hidden');
    document.getElementById('new-plan-modal')?.classList.remove('active');
  }

  function downloadTemplate() {
    try {
      const wb = XLSX.utils.book_new();
      const headers = ['N° Ticket', 'Descripcion', 'Proyecto', 'Notas'];
      const ws = XLSX.utils.aoa_to_sheet([headers]);
      ws['!cols'] = [{ wch: 12 }, { wch: 40 }, { wch: 20 }, { wch: 30 }];
      XLSX.utils.book_append_sheet(wb, ws, 'Programador Ejemplo');
      XLSX.writeFile(wb, 'plantilla_efectividad.xlsx');
      UI.showToast('Plantilla descargada', 'success');
    } catch (err) {
      UI.showToast('Error al generar plantilla: ' + err.message, 'error');
    }
  }

  function startNewPlanning() {
    const period = document.getElementById('new-plan-period').value.trim();
    if (!period) {
      UI.showToast('Ingresa el período de evaluación', 'error');
      return;
    }

    // Si estamos viendo una planificación, salir del modo vista
    if (_viewingPlanification) {
      const saved = Storage.loadData();
      if (saved && saved.programmers) {
        if (!saved.profiles) saved.profiles = {};
        appData = saved;
      }
      _viewingPlanification = null;
      renderSavedPlanifications();
    }

    // Preguntar si desea limpiar los datos actuales
    UI.confirm(
      'Iniciar nueva planificación',
      `Se limpiarán los datos actuales para comenzar "${period}". ¿Deseas continuar?`
    ).then(confirmed => {
      if (!confirmed) return;
      closeNewPlanningModal();

      // Opción: descargar plantilla antes de continuar
      downloadTemplate();

      // Mostrar pantalla de upload para cargar nuevo Excel
      Storage.clearData();
      appData = null;
      UI.showScreen('screen-upload');
      UI.hideUploadError();
      UI.showToast('Datos eliminados. Carga el nuevo archivo Excel.', 'info', 4000);
    });
  }

  // --- Verificación de contraseña para retomar planificación cerrada ---

  let _passwordResolve = null;

  function openPasswordModal(planId) {
    _pendingResumePlanId = planId;
    document.getElementById('password-email').value = '';
    document.getElementById('password-pass').value = '';
    document.getElementById('password-error').classList.add('hidden');
    document.getElementById('password-modal').classList.remove('hidden');
    document.getElementById('password-modal').classList.add('active');
    setTimeout(() => document.getElementById('password-email')?.focus(), 100);
  }

  function closePasswordModal() {
    document.getElementById('password-modal')?.classList.add('hidden');
    document.getElementById('password-modal')?.classList.remove('active');
    _pendingResumePlanId = null;
  }

  function confirmPassword() {
    const email = document.getElementById('password-email').value.trim();
    const password = document.getElementById('password-pass').value;
    const errorEl = document.getElementById('password-error');

    if (!email || !password) {
      errorEl.textContent = 'Ingresa correo y contraseña';
      errorEl.classList.remove('hidden');
      return;
    }

    errorEl.classList.add('hidden');

    // Verificar con Firebase Auth
    Auth.signIn(email, password).then(() => {
      // Autenticación exitosa
      UI.showToast('Acceso verificado', 'success');
      closePasswordModal();

      if (_pendingResumePlanId) {
        loadPlanificationAsActive(_pendingResumePlanId);
        _pendingResumePlanId = null;
      }
    }).catch((err) => {
      errorEl.textContent = authErrorMessage(err);
      errorEl.classList.remove('hidden');
    });
  }

  /**
   * Carga una planificación guardada como datos activos (editable).
   * Requiere haber verificado contraseña antes.
   */
  function loadPlanificationAsActive(planId) {
    const plan = Storage.getPlanification(planId);
    if (!plan) { UI.showToast('Planificación no encontrada', 'error'); return; }

    // Salir de modo vista si estaba activo
    _viewingPlanification = null;
    renderSavedPlanifications();

    // Restaurar los datos de la planificación como activos
    appData = {
      programmers: JSON.parse(JSON.stringify(plan.data.programmers)),
      profiles: JSON.parse(JSON.stringify(plan.data.profiles || {})),
    };
    Storage.saveData(appData);
    UI.showToast(`"${plan.name}" cargada como planificación activa`, 'success', 4000);
    goToDashboard();

    // Quitar el badge de vista del breadcrumb
    const breadcrumb = document.getElementById('topbar-breadcrumb');
    if (breadcrumb) breadcrumb.textContent = 'Dashboard';
  }

  // --- Helper: escapar HTML ---
  function escHtml(str) {
    const div = document.createElement('div');
    div.textContent = String(str ?? '');
    return div.innerHTML;
  }

  // ----------------------------------------------------------------
  // API PÚBLICA
  // ----------------------------------------------------------------
  function getAllProgrammerNames() {
    return appData ? Object.keys(appData.programmers) : [];
  }

  /**
   * Elimina un programador del sistema con confirmación.
   * @param {string} name
   */
  async function deleteProgrammer(name) {
    if (!appData || !appData.programmers[name]) return;
    const confirmed = await UI.confirm(
      `¿Eliminar a "${name}"?`,
      `Se eliminarán todos sus tickets y su perfil. Esta acción no se puede deshacer.`
    );
    if (!confirmed) return;
    delete appData.programmers[name];
    if (appData.profiles && appData.profiles[name]) {
      delete appData.profiles[name];
    }
    Storage.saveData(appData);
    UI.showToast(`"${name}" eliminado`, 'success');
    goToDashboard();
  }

  function refreshProfiles() {
    renderProfiles();
  }

  /**
   * Sincroniza un programador de appData con localStorage.
   * Se llama después de modificar tickets desde tickets.js.
   * @param {string} name
   */
  function syncProgrammerFromStorage(name) {
    if (!appData) return;
    const stored = Storage.loadData();
    if (stored && stored.programmers[name]) {
      appData.programmers[name] = stored.programmers[name];
    }
  }

  return {
    init,
    navigateToProgrammer,
    goToDashboard,
    getAllProgrammerNames,
    deleteProgrammer,
    editProfile,
    deleteProfile,
    refreshProfiles,
    syncProgrammerFromStorage,
    deletePlanification,
  };

})();

// ================================================================
// ARRANQUE DE LA APLICACIÓN
// ================================================================
document.addEventListener('DOMContentLoaded', () => {
  App.init();
});
