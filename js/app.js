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
    try {
      FirebaseDB.init();

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
        if (sharedViewName && appData.programmers[sharedViewName]) {
          Tickets.render(sharedViewName, appData.programmers[sharedViewName], true);
        } else {
          const viewDashboard = document.getElementById('view-dashboard');
          if (viewDashboard?.classList.contains('active')) {
            Dashboard.render(appData.programmers, navigateToProgrammer);
          } else {
            const currentName = document.getElementById('prog-name')?.textContent;
            if (currentName && appData.programmers[currentName]) {
              Tickets.render(currentName, appData.programmers[currentName]);
            }
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
          if (sharedViewName) {
            enterSharedView(sharedViewName);
          } else {
            goToDashboard();
          }
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
    // Detectar vista compartida por URL (?compartir=Nombre)
    const params = new URLSearchParams(window.location.search);
    sharedViewName = params.get('compartir') || null;

    setupTheme();
    setupUploadScreen();
    setupSidebar();
    setupExportButtons();
    setupAddProgrammerButton();

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
  function initApp() {
    setupFirebaseSync();

    // Verificar si hay datos en localStorage
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

    // Renderizar el dashboard y perfiles
    Dashboard.render(appData.programmers, navigateToProgrammer);
    renderProfiles();
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

    const calc = (name) => {
      const tickets = appData.programmers[name];
      if (!tickets || tickets.length === 0) return 0;
      const solved = tickets.filter(t => t.status === 'Solventado').length;
      const noA = tickets.filter(t => t.status === 'No Aplica' || t.status === 'Información Adicional').length;
      const eff = tickets.length - noA;
      return eff > 0 ? Math.round((solved / eff) * 100) : 0;
    };

    container.innerHTML = specials.map(([name, role]) => {
      const label = role === 'lider' ? 'Líder Técnico' : 'Evaluación';
      const pct = calc(name);
      const theme = pct >= 75 ? 'green' : pct >= 40 ? 'yellow' : 'red';
      return `
        <div class="profile-row">
          <div class="profile-info">
            <span class="profile-name">${name}</span>
            <span class="profile-role">${label}</span>
          </div>
          <span class="effectiveness-badge effectiveness-badge--${theme}">${pct}%</span>
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
  function getAllProgrammerNames() {
    return appData ? Object.keys(appData.programmers) : [];
  }

  return {
    init,
    navigateToProgrammer,
    goToDashboard,
    getAllProgrammerNames,
  };

})();

// ================================================================
// ARRANQUE DE LA APLICACIÓN
// ================================================================
document.addEventListener('DOMContentLoaded', () => {
  App.init();
});
