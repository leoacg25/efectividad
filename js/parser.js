/**
 * parser.js — Módulo de Procesamiento de Excel
 * =============================================
 * Responsable de:
 *   - Leer el archivo .xlsx con SheetJS
 *   - Validar que las hojas tengan las columnas correctas
 *   - Normalizar y estructurar los datos extraídos
 *   - Asignar IDs únicos y estado inicial a cada ticket
 */

const Parser = (() => {

  /**
   * Columnas requeridas en cada hoja (normalizado a minúsculas sin acentos para comparación).
   * El mapa asocia el nombre normalizado con la clave interna.
   */
  const COLUMN_MAP = {
    'n° ticket':    'ticket',
    'n ticket':     'ticket',
    'no ticket':    'ticket',
    'nticket':      'ticket',
    'descripcion':  'description',
    'descripción':  'description',
    'proyecto':     'project',
    'tipo':         'tipo',
    'tipodeticket': 'tipo',
    'tipodeTicket': 'tipo',
    'notas':        'notes',
    'estado':       'status',
    'status':       'status',
    'estatus':      'status',
  };

  /**
   * Normaliza un string para comparación (lower, sin tildes, sin espacios extra).
   * @param {string} str
   * @returns {string}
   */
  function normalize(str) {
    return String(str || '')
      .toLowerCase()
      .trim()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
  }

  /**
   * Detecta qué columnas reales del encabezado mapean a qué campo interno.
   * @param {string[]} headers - Cabeceras tal como vienen del Excel
   * @returns {{ map: Object, missing: string[] }}
   *   - map:     { campoInterno: índiceEnHeader }
   *   - missing: columnas requeridas que no se encontraron
   */
  function detectColumns(headers) {
    const required = ['ticket', 'description', 'project', 'notes'];
    const foundMap = {};

    headers.forEach((h, idx) => {
      const norm = normalize(h);
      const internalKey = COLUMN_MAP[norm];
      if (internalKey && foundMap[internalKey] === undefined) {
        foundMap[internalKey] = idx;
      }
    });

    const missing = required.filter(r => foundMap[r] === undefined);
    return { map: foundMap, missing };
  }

  /**
   * Normaliza el número de ticket para comparar: recorta espacios y, si es
   * puramente numérico, ignora los ceros a la izquierda (0001617 = 1617).
   * @param {string} raw
   * @returns {string} Clave de comparación ('' si no hay número de ticket)
   */
  function normalizeTicketKey(raw) {
    const s = String(raw || '').trim();
    if (!s) return '';
    if (/^\d+$/.test(s)) return s.replace(/^0+(?=\d)/, '');
    return s.toLowerCase();
  }

  /**
   * Elimina tickets repetidos conservando una sola fila por número.
   * Criterio: preferir filas con modificaciones (notas con texto o estatus
   * distinto de "No resuelto"); entre varias modificadas, la última; si
   * ninguna, la última fila.
   * @param {Object[]} tickets
   * @returns {{ tickets: Object[], removed: number }}
   */
  function dedupeTickets(tickets) {
    const groups = new Map();
    const order = [];

    tickets.forEach((t, idx) => {
      const key = normalizeTicketKey(t.ticket);
      if (!key) return; // sin número de ticket: no se deduplica
      if (!groups.has(key)) {
        groups.set(key, []);
        order.push(key);
      }
      groups.get(key).push(idx);
    });

    const drop = new Set();
    order.forEach(key => {
      const idxs = groups.get(key);
      if (idxs.length < 2) return;
      const modified = idxs.filter(i => tickets[i]._hasModified);
      const winner = modified.length ? modified[modified.length - 1] : idxs[idxs.length - 1];
      idxs.forEach(i => { if (i !== winner) drop.add(i); });
    });

    const result = tickets
      .filter((_, idx) => !drop.has(idx))
      .map(({ _hasModified, ...rest }) => rest);

    return { tickets: result, removed: drop.size };
  }

  /**
   * Convierte una hoja de SheetJS en un array de objetos ticket.
   * @param {Object} worksheet - Hoja de SheetJS
   * @param {string} programmerName - Nombre del programador (para IDs únicos)
   * @returns {{ tickets: Object[], errors: string[], duplicatesRemoved: number }}
   */
  function parseSheet(worksheet, programmerName) {
    // Convertir a array de arrays (incluyendo encabezado)
    const raw = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '' });

    if (!raw || raw.length === 0) {
      return { tickets: [], errors: ['La hoja está vacía.'] };
    }

    // Primera fila = encabezados
    const headers = raw[0].map(h => String(h).trim());
    const { map, missing } = detectColumns(headers);

    if (missing.length > 0) {
      return {
        tickets: [],
        errors: [`Columnas faltantes: ${missing.join(', ')}. Encontradas: ${headers.join(', ')}`]
      };
    }

    const tickets = [];
    let ticketCounter = 0;

    // Procesar filas de datos (desde la 2ª)
    for (let i = 1; i < raw.length; i++) {
      const row = raw[i];

      // Saltar filas completamente vacías
      const allEmpty = row.every(cell => String(cell).trim() === '');
      if (allEmpty) continue;

      function normalizeTipo(v) {
        const s = String(v || '').trim().toLowerCase();
        if (!s) return 'Mejora/requerimiento';
        if (s.includes('mejora') || s.includes('requerimiento')) return 'Mejora/requerimiento';
        if (s.includes('averia') || s.includes('falla')) return 'Avería/Falla';
        return String(v).trim();
      }
      function normalizeStatus(v) {
        const s = String(v || '').trim().toLowerCase();
        if (!s) return 'No resuelto';
        if (s.includes('solventado') || s === 'solventado') return 'Solventado';
        if (s.includes('proceso')) return 'En proceso';
        if (s.includes('aplica')) return 'No Aplica';
        if (s.includes('informacion') || s.includes('información') || s.includes('adicional')) return 'Información Adicional';
        return 'No resuelto';
      }

      ticketCounter++;
      const rawNotes  = map.notes  !== undefined ? String(row[map.notes]  ?? '').trim() : '';
      const rawStatus = map.status !== undefined ? String(row[map.status] ?? '').trim() : '';
      // El estado "No resuelto" es el valor por defecto (sin modificación).
      const statusModified = rawStatus !== '' && normalizeStatus(rawStatus) !== 'No resuelto';
      const ticket = {
        id: `${programmerName}-${i}-${Date.now()}`,
        rowIndex: i,
        ticket:      String(row[map.ticket]      ?? '').trim(),
        description: String(row[map.description] ?? '').trim(),
        project:     String(row[map.project]     ?? '').trim(),
        tipo:        map.tipo  !== undefined ? normalizeTipo(row[map.tipo])    : 'Mejora/requerimiento',
        notes:       rawNotes,
        status:      map.status !== undefined ? normalizeStatus(row[map.status]) : 'No resuelto',
        _hasModified: rawNotes !== '' || statusModified,
      };

      tickets.push(ticket);
    }

    // Deduplicar tickets repetidos conservando la fila con modificaciones.
    const { tickets: deduped, removed } = dedupeTickets(tickets);

    return { tickets: deduped, errors: [], duplicatesRemoved: removed };
  }

  /**
   * Procesa un archivo .xlsx completo y retorna la estructura normalizada.
   * Función principal del módulo.
   * @param {File} file - Objeto File del input[type="file"]
   * @returns {Promise<{ data: Object|null, errors: Object }>}
   *   - data:   { programmers: { [nombre]: [tickets] }, loadedAt: string }
   *   - errors: { [nombreHoja]: string[] } — errores por hoja
   */
  async function parseExcel(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();

      reader.onload = (evt) => {
        try {
          const arrayBuffer = evt.target.result;
          const workbook = XLSX.read(arrayBuffer, { type: 'array' });

          // Validar que el workbook tenga al menos una hoja
          if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
            return reject(new Error('El archivo no contiene hojas de cálculo.'));
          }

          const programmers = {};
          const sheetErrors = {};
          let totalDuplicatesRemoved = 0;

          workbook.SheetNames.forEach(sheetName => {
            // Saltar hojas con nombres reservados o vacíos
            if (!sheetName || sheetName.trim() === '') return;

            const worksheet = workbook.Sheets[sheetName];
            if (!worksheet) return;

            const { tickets, errors, duplicatesRemoved } = parseSheet(worksheet, sheetName);
            totalDuplicatesRemoved += duplicatesRemoved || 0;

            if (errors.length > 0) {
              sheetErrors[sheetName] = errors;
            }

            // Incluir el programador aunque tenga 0 tickets (hoja válida pero vacía)
            programmers[sheetName] = tickets;
          });

          // Si TODAS las hojas tienen errores estructurales, rechazar
          const validSheets = Object.keys(programmers).filter(
            name => !sheetErrors[name]
          );

          if (validSheets.length === 0 && Object.keys(sheetErrors).length > 0) {
            return reject(new Error(
              'No se encontraron hojas válidas. Verifica el formato de columnas:\n' +
              Object.entries(sheetErrors)
                .map(([sheet, errs]) => `• ${sheet}: ${errs.join(' ')}`)
                .join('\n')
            ));
          }

          resolve({
            data: {
              programmers,
              loadedAt: new Date().toISOString(),
              duplicatesRemoved: totalDuplicatesRemoved,
            },
            errors: sheetErrors
          });

        } catch (err) {
          console.error('[Parser] Error procesando Excel:', err);
          reject(new Error('El archivo no es un Excel válido o está corrupto.'));
        }
      };

      reader.onerror = () => {
        reject(new Error('Error al leer el archivo. Asegúrate de que el archivo no esté abierto en otro programa.'));
      };

      // Leer como ArrayBuffer para SheetJS
      reader.readAsArrayBuffer(file);
    });
  }

  /**
   * Valida que el archivo seleccionado sea .xlsx o .xls antes de procesarlo.
   * @param {File} file
   * @returns {{ valid: boolean, error: string }}
   */
  function validateFile(file) {
    if (!file) {
      return { valid: false, error: 'No se seleccionó ningún archivo.' };
    }

    const allowedTypes = [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
      'application/vnd.ms-excel', // .xls
    ];
    const allowedExtensions = ['.xlsx', '.xls'];
    const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();

    if (!allowedTypes.includes(file.type) && !allowedExtensions.includes(ext)) {
      return {
        valid: false,
        error: `Tipo de archivo no permitido: "${file.name}". Solo se aceptan archivos .xlsx o .xls.`
      };
    }

    // Límite de 20 MB
    const MAX_SIZE = 20 * 1024 * 1024;
    if (file.size > MAX_SIZE) {
      return { valid: false, error: 'El archivo es demasiado grande. El límite es 20 MB.' };
    }

    return { valid: true, error: null };
  }

  // API pública del módulo
  return {
    parseExcel,
    validateFile,
  };

})();
