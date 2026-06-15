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
    'n ticket':     'ticket',   // por si el carácter especial falla
    'no ticket':    'ticket',
    'nticket':      'ticket',
    'descripcion':  'description',
    'descripción':  'description',
    'proyecto':     'project',
    'notas':        'notes',
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
    const foundMap = {}; // { campoInterno: índice }

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
   * Convierte una hoja de SheetJS en un array de objetos ticket.
   * @param {Object} worksheet - Hoja de SheetJS
   * @param {string} programmerName - Nombre del programador (para IDs únicos)
   * @returns {{ tickets: Object[], errors: string[] }}
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

      ticketCounter++;
      const ticket = {
        // ID único generado internamente para persistencia
        id: `${programmerName}-${i}-${Date.now()}`,
        rowIndex: i,
        ticket:      String(row[map.ticket]      ?? '').trim(),
        description: String(row[map.description] ?? '').trim(),
        project:     String(row[map.project]     ?? '').trim(),
        notes:       String(row[map.notes]       ?? '').trim(),
        status:      'No resuelto', // Estado inicial por defecto
      };

      tickets.push(ticket);
    }

    return { tickets, errors: [] };
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

          workbook.SheetNames.forEach(sheetName => {
            // Saltar hojas con nombres reservados o vacíos
            if (!sheetName || sheetName.trim() === '') return;

            const worksheet = workbook.Sheets[sheetName];
            if (!worksheet) return;

            const { tickets, errors } = parseSheet(worksheet, sheetName);

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
