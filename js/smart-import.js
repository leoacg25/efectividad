/**
 * smart-import.js — Módulo de Carga Inteligente
 * ==============================================
 * Responsable de:
 *   - Leer archivos .xlsx, .xls, .xlsm, .csv, .pdf, .docx y .doc (mejor esfuerzo)
 *   - Detectar automáticamente la fila de encabezado y mapear las columnas
 *     al modelo de tickets (sinónimos: "# Mantis" → ticket, "Estatus" → estado, etc.)
 *   - Detectar el nombre del programador (celda "Desarrollador: ...", nombre de hoja o archivo)
 *   - Mostrar una previsualización editable antes de importar:
 *     mapeo de columnas por selectores, fila de encabezado y desarrollador
 *   - Asignar "Despacho N" consecutivo a filas sin número de ticket (opción conmutable)
 *
 * Flujo público:
 *   const data = await SmartImport.open(file);
 *     → data: { programmers: { [nombre]: [tickets] }, loadedAt, duplicatesRemoved }
 *     → null si el usuario cancela la previsualización
 */

const SmartImport = (() => {

  // ----------------------------------------------------------------
  // CONFIGURACIÓN
  // ----------------------------------------------------------------

  const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20 MB
  const ALLOWED_EXTENSIONS = ['.xlsx', '.xls', '.xlsm', '.csv', '.pdf', '.docx', '.doc'];

  /** Campos internos del modelo de tickets y su etiqueta para la UI. */
  const FIELDS = [
    { key: 'ticket',      label: 'N° Ticket' },
    { key: 'description', label: 'Descripción' },
    { key: 'project',     label: 'Proyecto' },
    { key: 'tipo',        label: 'Tipo' },
    { key: 'status',      label: 'Estado' },
    { key: 'notes',       label: 'Notas' },
  ];

  /**
   * Sinónimos de encabezados por campo.
   *  - strong: palabras clave inequívocas (peso alto).
   *  - weak:   ambiguas ('n°', 'id', '#'): solo ganan si no hay candidato fuerte.
   */
  const COLUMN_SYNONYMS = {
    ticket: {
      strong: ['ticket', 'mantis', 'caso', 'incidencia', 'issue', 'requerimiento', 'solicitud'],
      weak:   ['no', 'nro', 'num', 'numero', 'id', '#', 'codigo'],
    },
    description: {
      strong: ['descripcion', 'actividad', 'tarea', 'trabajo realizado', 'detalle', 'resumen', 'asunto'],
      weak:   ['titulo', 'nombre'],
    },
    project: {
      strong: ['proyecto', 'modulo', 'aplicativo', 'sistema'],
      weak:   ['area'],
    },
    tipo: {
      strong: ['tipo de ticket', 'tipodeticket', 'tipo', 'categoria', 'clasificacion'],
      weak:   [],
    },
    status: {
      strong: ['estatus', 'estado', 'status', 'situacion'],
      weak:   [],
    },
    notes: {
      strong: ['observacion', 'observaciones', 'nota', 'notas', 'comentario', 'comentarios', 'referencia'],
      weak:   [],
    },
  };

  /** Encabezados que se ignoran expresamente (nunca mapean a un campo). */
  const IGNORE_HEADERS = ['realizado', 'realizada', 'verificado', 'check'];

  /** Marcadores de "sin número de ticket" en la celda. */
  const NO_TICKET_VALUES = ['', '-', '—', '–', '--', 'n/a', 'na', 'sin ticket', 'sin numero', 'no aplica', '?', '.'];

  /** Patrones para detectar el desarrollador en celdas sobre el encabezado. */
  const DEV_PATTERNS = [
    /desarrollador\s*[:\-–]?\s*(.{2,60})$/,
    /programador\s*[:\-–]?\s*(.{2,60})$/,
    /responsable\s*[:\-–]?\s*(.{2,60})$/,
    /analista\s*[:\-–]?\s*(.{2,60})$/,
    /preparado\s+por\s*[:\-–]?\s*(.{2,60})$/,
    /elaborado\s+por\s*[:\-–]?\s*(.{2,60})$/,
  ];

  /** Nombres de hoja genéricos: no sirven como nombre de programador. */
  const GENERIC_SHEET_NAMES = [
    'sheet', 'sheet1', 'hoja', 'hoja 1', 'hoja1', 'datos', 'data', 'tabla', 'tabla 1',
    'tabla1', 'plantilla', 'sheet 1', 'worksheet', 'grid', 'consulta',
  ];

  // Librerías externas cargadas bajo demanda (solo si el archivo lo requiere)
  const PDFJS_URL    = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
  const PDFJS_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  const JSZIP_URL    = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';

  const _scriptCache = {};

  // ----------------------------------------------------------------
  // UTILIDADES
  // ----------------------------------------------------------------

  /**
   * Normaliza un texto de encabezado: minúsculas, sin tildes, sin '°',
   * sin símbolos de prefijo (#, :) y con espacios colapsados.
   * @param {*} raw
   * @returns {string}
   */
  function normHeader(raw) {
    return String(raw ?? '')
      .toLowerCase()
      .trim()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/°/g, 'o')
      .replace(/^[\s#:.·|]+/, '')
      .replace(/[\s#:.·|]+$/, '')
      .replace(/\s+/g, ' ');
  }

  /** Escape de HTML para previsualizaciones. */
  function esc(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /** Nombre base del archivo sin extensión. */
  function fileBaseName(fileName) {
    return String(fileName || 'archivo')
      .replace(/\.[^.]+$/, '')
      .replace(/[_]+/g, ' ')
      .trim() || 'Programador';
  }

  /** Extensión en minúsculas de un nombre de archivo. */
  function fileExt(fileName) {
    const m = String(fileName || '').match(/(\.[^.]+)$/);
    return m ? m[1].toLowerCase() : '';
  }

  /**
   * Carga un script externo una sola vez (bajo demanda).
   * @param {string} url
   * @returns {Promise<void>}
   */
  function loadScriptOnce(url) {
    if (_scriptCache[url]) return _scriptCache[url];
    _scriptCache[url] = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = url;
      s.onload = () => resolve();
      s.onerror = () => {
        delete _scriptCache[url];
        reject(new Error(`No se pudo cargar la librería: ${url}`));
      };
      document.head.appendChild(s);
    });
    return _scriptCache[url];
  }

  // ----------------------------------------------------------------
  // DETECCIÓN: ENCABEZADO, COLUMNAS Y DESARROLLADOR
  // ----------------------------------------------------------------

  /**
   * Puntúa qué tan bien un encabezado de columna representa un campo interno.
   * @param {string} field - Clave del campo ('ticket', 'description', ...)
   * @param {string} headerNorm - Encabezado ya normalizado
   * @returns {number} 0 = sin relación
   */
  function headerScore(field, headerNorm) {
    const syn = COLUMN_SYNONYMS[field];
    const h = String(headerNorm || '').trim();
    if (!h) return 0;
    if (syn.strong.includes(h)) return 6;
    if (syn.weak.includes(h)) return 3;
    for (const w of syn.strong) {
      if (h.includes(w)) return 5;
      if (w.length >= 5 && w.startsWith(h) && h.length >= 4) return 4; // ej: 'descrip' ≈ 'descripcion'
    }
    for (const w of syn.weak) {
      if (h.includes(w)) return 2;
    }
    return 0;
  }

  /**
   * Detecta la fila de encabezado dentro de las primeras ~30 filas.
   * Gana la fila con más columnas que mapeen a campos conocidos.
   * @param {string[][]} grid
   * @returns {number} Índice (0-based) de la fila de encabezado
   */
  function detectHeaderRow(grid) {
    const limit = Math.min(grid.length, 30);
    let bestIdx = 0;
    let bestScore = -1;

    for (let i = 0; i < limit; i++) {
      const row = grid[i] || [];
      let score = 0;
      const fields = new Set();
      let nonEmpty = 0;

      row.forEach(cell => {
        const h = normHeader(cell);
        if (!h) return;
        nonEmpty++;
        FIELDS.forEach(f => {
          const s = headerScore(f.key, h);
          if (s > 0) { score += s; fields.add(f.key); }
        });
      });

      // Un encabezado necesita al menos 2 columnas reconocibles y celdas suficientes
      if (nonEmpty >= 2 && fields.size >= 2 && score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    return bestIdx;
  }

  /**
   * ¿Los valores de la columna son un contador correlativo 1, 2, 3...?
   * (columna de orden tipo "N°"): no debe usarse como número de ticket.
   * @param {string[][]} grid
   * @param {number} col
   * @param {number} fromRow
   * @returns {boolean}
   */
  function looksLikeCounter(grid, col, fromRow) {
    const values = [];
    for (let i = fromRow; i < grid.length && values.length < 40; i++) {
      const v = String((grid[i] || [])[col] ?? '').trim();
      if (v !== '') values.push(v);
    }
    if (values.length < 5) return false;
    let okCount = 0;
    let expected = 1;
    for (const v of values) {
      if (/^\d+$/.test(v) && Number(v) === expected) okCount++;
      else expected = Number(v) || expected; // tolera reinicios de sección
      expected++;
    }
    return okCount >= values.length * 0.9;
  }

  /**
   * Mapea columnas del grid a campos internos usando la fila de encabezado.
   * Asignación voraz: cada columna va a su campo con mayor puntaje.
   * @param {string[][]} grid
   * @param {number} headerRow - Índice (0-based) de la fila de encabezado
   * @returns {{ map: Object.<string, number>, headers: string[] }} map: campo → índice de columna
   */
  function mapColumns(grid, headerRow) {
    const headers = (grid[headerRow] || []).map(h => String(h ?? '').trim());
    const width = grid.reduce((m, r) => Math.max(m, (r || []).length), headers.length);

    const candidates = [];
    for (let c = 0; c < width; c++) {
      const h = normHeader(headers[c]);
      if (!h) continue;
      // Columnas expresamente ignoradas (ej: "Realizado")
      if (IGNORE_HEADERS.some(w => h === w || h.includes(w))) continue;

      FIELDS.forEach(f => {
        let s = headerScore(f.key, h);
        // Penalizar contadores ('N°' 1,2,3...) como ticket: solo último recurso
        if (f.key === 'ticket' && s > 0 && looksLikeCounter(grid, c, headerRow + 1)) {
          s = 1;
        }
        if (s > 0) candidates.push({ field: f.key, col: c, score: s });
      });
    }

    candidates.sort((a, b) => b.score - a.score || a.col - b.col);
    const map = {};
    const usedCols = new Set();
    candidates.forEach(c => {
      if (map[c.field] === undefined && !usedCols.has(c.col)) {
        map[c.field] = c.col;
        usedCols.add(c.col);
      }
    });
    return { map, headers };
  }

  /**
   * Detecta el nombre del programador: celda "Desarrollador: X" sobre el
   * encabezado → nombre de hoja (si no es genérico) → nombre del archivo.
   * @param {string[][]} grid
   * @param {number} headerRow
   * @param {string} sheetName
   * @param {string} fileName
   * @returns {string}
   */
  function detectDeveloper(grid, headerRow, sheetName, fileName) {
    const limit = Math.min(Math.max(headerRow, 0), grid.length);
    for (let i = 0; i < limit; i++) {
      for (const cell of (grid[i] || [])) {
        const t = String(cell ?? '').trim();
        if (!t || t.length > 120) continue;
        const low = t.toLowerCase();
        for (const re of DEV_PATTERNS) {
          const m = low.match(re);
          if (m) {
            const name = m[1].trim()
              .replace(/\s*\(.*\)\s*$/, '') // quitar aclaraciones entre paréntesis
              .replace(/["“”]/g, '')
              .trim();
            if (name.length >= 2 && name.length <= 60) {
              // Capitalizar cada palabra para uniformidad
              return name.toLowerCase().replace(/(^|\s)\S/g, ch => ch.toUpperCase());
            }
          }
        }
      }
    }
    const sheet = String(sheetName || '').trim();
    if (sheet && !GENERIC_SHEET_NAMES.includes(normHeader(sheet))) return sheet;
    return fileBaseName(fileName);
  }

  // ----------------------------------------------------------------
  // EXTRACCIÓN DE FILAS → TICKETS
  // ----------------------------------------------------------------

  /** Valor mapeado de una fila según el mapa campo→columna. */
  function pick(row, map, field) {
    const c = map[field];
    if (c === undefined) return '';
    return String((row || [])[c] ?? '').trim();
  }

  /** ¿La fila es igual al encabezado? (encabezados repetidos en PDF multipágina) */
  function rowMatchesHeader(row, headerRow) {
    const a = (row || []).map(c => normHeader(c)).filter(Boolean).join('•');
    const b = (headerRow || []).map(c => normHeader(c)).filter(Boolean).join('•');
    return a.length > 0 && a === b;
  }

  /**
   * ¿El valor es un marcador de "sin número de ticket"? ('', '-', 'N/A', ...)
   * @param {string} v
   * @returns {boolean}
   */
  function isNoTicket(v) {
    const s = String(v ?? '').trim().toLowerCase();
    return NO_TICKET_VALUES.includes(s);
  }

  /**
   * Construye los tickets de una hoja según su estado de configuración.
   * @param {Object} sheet - { grid, headerRow, map, despacho }
   * @returns {{ tickets: Object[], despachoCount: number, duplicatesRemoved: number }}
   */
  function buildTickets(sheet) {
    const { grid, headerRow, map, despacho } = sheet;
    const headerRowCells = grid[headerRow] || [];
    const collected = [];
    let emptyStreak = 0;

    for (let i = headerRow + 1; i < grid.length; i++) {
      const row = grid[i] || [];
      const nonEmpty = row.filter(c => String(c ?? '').trim() !== '');

      // Fin de la tabla: 3+ filas vacías consecutivas
      if (nonEmpty.length === 0) {
        emptyStreak++;
        if (emptyStreak >= 3) break;
        continue;
      }
      emptyStreak = 0;

      const ticket = pick(row, map, 'ticket');
      const description = pick(row, map, 'description');

      // Nota al pie / celda fusionada: una sola celda con texto largo y sin
      // ticket ni descripción mapeados → fin de los datos
      if (nonEmpty.length === 1) {
        const text = String(nonEmpty[0]).trim();
        if (!ticket && !description && text.length >= 60) break;
        if (!ticket && !description) continue; // etiqueta de sección corta
      }

      if (rowMatchesHeader(row, headerRowCells)) continue;

      // La fila debe aportar al menos descripción o ticket
      if (!description && !ticket) continue;

      collected.push({
        rowNumber: i + 1, // fila real de la hoja (1-based)
        ticket,
        description,
        project:   pick(row, map, 'project'),
        tipoRaw:   pick(row, map, 'tipo'),
        notes:     pick(row, map, 'notes'),
        statusRaw: pick(row, map, 'status'),
      });
    }

    // Seguridad extra contra notas al pie al final de la tabla (típico en PDF):
    // filas sin ticket, sin estado y con descripciones muy largas
    let trimmed = 0;
    while (
      collected.length > 0 && trimmed < 3 &&
      !collected[collected.length - 1].ticket &&
      !collected[collected.length - 1].statusRaw &&
      collected[collected.length - 1].description.replace(/\s/g, '').length >= 150
    ) {
      collected.pop();
      trimmed++;
    }

    // Numeración "Despacho N" para filas sin número de ticket
    let despachoCounter = 0;
    const rows = collected.map(c => {
      let finalTicket = c.ticket;
      if (isNoTicket(c.ticket)) {
        if (despacho && c.description) {
          despachoCounter++;
          finalTicket = `Despacho ${despachoCounter}`;
        } else {
          finalTicket = '';
        }
      }

      const status = map.status !== undefined ? Parser.normalizeStatus(c.statusRaw) : 'No resuelto';
      const statusModified = c.statusRaw !== '' && status !== 'No resuelto';

      return {
        id: `smart-${c.rowNumber}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        rowIndex: c.rowNumber,
        ticket:      finalTicket,
        description: c.description,
        project:     c.project,
        tipo:        map.tipo !== undefined ? Parser.normalizeTipo(c.tipoRaw) : 'Mejora/requerimiento',
        notes:       c.notes,
        status,
        _hasModified: c.notes !== '' || statusModified,
      };
    });

    // Deduplicar por número de ticket (mismas reglas que el importador clásico)
    const { tickets, removed } = Parser.dedupeTickets(rows);
    return { tickets, despachoCount: despachoCounter, duplicatesRemoved: removed };
  }

  // ----------------------------------------------------------------
  // LECTURA DE ARCHIVOS → GRIDS (filas × columnas de texto)
  // ----------------------------------------------------------------

  /** Convierte un workbook de SheetJS en grids por hoja. */
  function workbookToGrids(workbook) {
    const grids = [];
    (workbook.SheetNames || []).forEach(name => {
      if (!name || !name.trim()) return;
      const ws = workbook.Sheets[name];
      if (!ws) return;
      const grid = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', blankrows: true, raw: false });
      // Normalizar filas a arrays densos de strings
      const width = grid.reduce((m, r) => Math.max(m, (r || []).length), 0);
      const clean = grid.map(r => {
        const row = new Array(width).fill('');
        (r || []).forEach((c, i) => { row[i] = c == null ? '' : String(c); });
        return row;
      });
      grids.push({ name, grid: clean });
    });
    return grids;
  }

  /** Lee un archivo de Excel (.xlsx/.xls/.xlsm) como grids por hoja. */
  async function readExcel(file) {
    const buf = await file.arrayBuffer();
    const workbook = XLSX.read(buf, { type: 'array' });
    if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
      throw new Error('El archivo no contiene hojas de cálculo.');
    }
    return workbookToGrids(workbook);
  }

  /** Lee un CSV detectando codificación (UTF-8 con BOM o Windows-1252). */
  async function readCsv(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let text;
    if (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
      text = new TextDecoder('utf-8').decode(bytes.subarray(3));
    } else {
      text = new TextDecoder('utf-8').decode(bytes);
      if (text.includes('\uFFFD')) text = new TextDecoder('windows-1252').decode(bytes);
    }
    const workbook = XLSX.read(text, { type: 'string', raw: false });
    return workbookToGrids(workbook);
  }

  // ------------------------- PDF -------------------------

  /**
   * Reconstruye una tabla a partir de los ítems de texto de una página PDF.
   * 1) Agrupa ítems en líneas por coordenada Y.
   * 2) Detecta columnas (anclas X) desde la línea de encabezado detectada.
   * 3) Separa filas por saltos verticales + heurística de línea de continuación.
   * @param {Array} items - ítems de page.getTextContent()
   * @returns {string[][]}
   */
  function pdfItemsToGrid(items) {
    const entries = items
      .filter(it => it && it.str && String(it.str).trim() !== '')
      .map(it => ({ str: String(it.str), x: it.transform[4], y: it.transform[5] }))
      .sort((a, b) => b.y - a.y || a.x - b.x);

    if (entries.length === 0) return [];

    // --- 1) Líneas: clusterizar por Y con tolerancia ---
    const LINE_TOL = 2.5;
    const lines = [];
    entries.forEach(e => {
      const last = lines[lines.length - 1];
      if (last && Math.abs(last.y - e.y) <= LINE_TOL) {
        last.items.push(e);
        last.y = (last.y * (last.items.length - 1) + e.y) / last.items.length; // promedio móvil
      } else {
        lines.push({ y: e.y, items: [e] });
      }
    });
    lines.forEach(l => l.items.sort((a, b) => a.x - b.x));

    // --- 2) Anclas de columna: cluster global de posiciones X ---
    const anchors = clusterPositions(lines.flatMap(l => l.items.map(it => it.x)), 10);

    // --- 3) Separadores de fila: brechas verticales grandes ---
    const gaps = [];
    for (let i = 1; i < lines.length; i++) gaps.push(lines[i - 1].y - lines[i].y);
    const sorted = [...gaps].sort((a, b) => a - b);
    const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
    const threshold = Math.max(median * 1.75, median + 3);

    // --- 4) Armar filas (una línea de continuación se une a la fila previa) ---
    const rows = [];
    lines.forEach((line, idx) => {
      const gap = idx > 0 ? gaps[idx - 1] : Infinity; // primera línea siempre inicia fila
      const isNewRow =
        gap === Infinity ||
        gap > threshold ||
        (gaps.filter(g => g > threshold).length === 0 && gaps.length > 0); // tabla uniforme: cada línea es una fila

      const cells = lineToCells(line, anchors);

      if (isNewRow || rows.length === 0) {
        rows.push(cells);
      } else {
        // Posible línea de continuación (celda con texto envuelto):
        // se une si toca columnas ya pobladas de la fila anterior
        const prev = rows[rows.length - 1];
        const populatedPrev = prev.map((c, i) => (String(c).trim() !== '' ? i : -1)).filter(i => i >= 0);
        const populatedThis = cells.map((c, i) => (String(c).trim() !== '' ? i : -1)).filter(i => i >= 0);
        const leftmost = populatedThis.length ? populatedThis[0] : 0;
        const continuation =
          (leftmost > 0 || populatedThis.length === 1) &&
          populatedThis.every(c => populatedPrev.includes(c));
        if (continuation) {
          populatedThis.forEach(c => {
            prev[c] = prev[c] ? `${prev[c]} ${cells[c]}`.trim() : cells[c];
          });
        } else {
          rows.push(cells);
        }
      }
    });

    // Si todas las líneas se separaron (tabla uniforme), la heurística de
    // continuación ya se aplicó arriba; descartar filas totalmente vacías.
    return rows.map(r => r.map(c => String(c ?? '').trim()));
  }

  /** Divide una línea en celdas asignando cada ítem a la ancla X más cercana. */
  function lineToCells(line, anchors) {
    const cells = new Array(anchors.length).fill('');
    line.items.forEach(it => {
      let best = 0;
      let bestDist = Infinity;
      anchors.forEach((a, i) => {
        const d = Math.abs(it.x - a);
        if (d < bestDist) { bestDist = d; best = i; }
      });
      cells[best] = cells[best] ? `${cells[best]} ${it.str}` : it.str;
    });
    return cells;
  }

  /** Agrupa posiciones cercanas (tolerancia en unidades de usuario). */
  function clusterPositions(values, tol) {
    const sorted = [...values].sort((a, b) => a - b);
    const clusters = [];
    sorted.forEach(v => {
      const last = clusters[clusters.length - 1];
      if (last && v - last[last.length - 1] <= tol) last.push(v);
      else clusters.push([v]);
    });
    return clusters.map(c => c[Math.floor(c.length / 2)]);
  }

  /** Lee un PDF: reconstruye la tabla de cada página en un grid combinado. */
  async function readPdf(file) {
    await loadScriptOnce(PDFJS_URL);
    if (typeof pdfjsLib === 'undefined') {
      throw new Error('No se pudo cargar el lector de PDF (verifica tu conexión).');
    }
    pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;

    const buf = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buf }).promise;

    const combined = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const content = await page.getTextContent();
      const grid = pdfItemsToGrid(content.items);
      // Encabezados repetidos en cada página: se filtran luego en la extracción
      grid.forEach(r => combined.push(r));
    }
    if (combined.length === 0) {
      throw new Error('El PDF no contiene texto extraíble (puede ser un escaneo/imagen).');
    }
    return [{ name: fileBaseName(file.name), grid: combined }];
  }

  // ------------------------- DOCX -------------------------

  /** Decodifica entidades XML en texto plano. */
  function decodeXmlEntities(s) {
    return String(s)
      .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&');
  }

  /**
   * Extrae bloques balanceados <tag>...</tag> (soporta anidados).
   * @param {string} xml
   * @param {string} tag - ej: 'w:tbl'
   * @returns {string[]} contenido completo de cada bloque
   */
  function extractBlocks(xml, tag) {
    const blocks = [];
    const openRe = new RegExp(`<${tag}(?=[\\s>])`, 'g');
    const anyRe = new RegExp(`</${tag}>|<${tag}(?=[\\s>])`, 'g');
    let m;
    while ((m = openRe.exec(xml))) {
      const start = m.index;
      anyRe.lastIndex = openRe.lastIndex;
      let depth = 1;
      let end = -1;
      let cm;
      while (depth > 0 && (cm = anyRe.exec(xml))) {
        if (cm[0].startsWith('</')) { depth--; if (depth === 0) end = anyRe.lastIndex; }
        else depth++;
      }
      if (end > 0) {
        blocks.push(xml.slice(start, end));
        openRe.lastIndex = end;
      }
    }
    return blocks;
  }

  /** Extrae el texto plano de un fragmento XML de Word. */
  function wordText(xmlFragment) {
    const noNested = xmlFragment.replace(/<w:tbl[\s>][\s\S]*?<\/w:tbl>/g, ' ');
    const texts = noNested.match(/<w:t[^>]*>([^<]*)<\/w:t>/g) || [];
    return texts.map(t => decodeXmlEntities(t.replace(/^<w:t[^>]*>/, '').replace(/<\/w:t>$/, '')))
      .join('')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** Lee un .docx (Word): extrae tablas o, si no hay, párrafos como filas. */
  async function readDocx(file) {
    await loadScriptOnce(JSZIP_URL);
    if (typeof JSZip === 'undefined') {
      throw new Error('No se pudo cargar el lector de Word (verifica tu conexión).');
    }
    const zip = await JSZip.loadAsync(await file.arrayBuffer());
    const docFile = zip.file('word/document.xml');
    if (!docFile) throw new Error('El .docx no contiene documento (word/document.xml).');
    const xml = await docFile.async('string');

    const grids = [];
    extractBlocks(xml, 'w:tbl').forEach((tblXml, i) => {
      const rows = extractBlocks(tblXml, 'w:tr').map(trXml =>
        extractBlocks(trXml, 'w:tc').map(tcXml => wordText(tcXml))
      );
      if (rows.length > 0) {
        const width = rows.reduce((m, r) => Math.max(m, r.length), 0);
        grids.push({
          name: `Tabla ${i + 1}`,
          grid: rows.map(r => { const row = [...r]; while (row.length < width) row.push(''); return row; }),
        });
      }
    });

    if (grids.length === 0) {
      // Sin tablas: tratar cada párrafo como fila de una sola columna
      const paras = extractBlocks(xml, 'w:p').map(wordText).filter(t => t !== '');
      if (paras.length === 0) throw new Error('El .docx no contiene texto ni tablas.');
      grids.push({ name: fileBaseName(file.name), grid: paras.map(t => [t]) });
    }
    return grids;
  }

  // ------------------------- DOC (formato antiguo) -------------------------

  /**
   * Lee un .doc antiguo (binario OLE). Extracción heurística de texto:
   * se prueban decodificaciones UTF-16LE y Windows-1252 y se elige la que
   * produzca más texto legible. Las tablas de Word separan celdas con \x07
   * y filas con saltos de línea.
   * @returns {{ grids: Array, warning: string|null }}
   */
  async function readDoc(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());

    const tryDecode = (encoding) => {
      const decoded = new TextDecoder(encoding).decode(bytes);
      // Conservar corridas de texto legible (letras, números, puntuación común)
      const runs = decoded
        .split(/[^\u0020-\u007E\u00A0-\u024F\u0007\t\r\n]+/)
        .map(r => r.trim())
        .filter(r => r.replace(/[\s\x07\t\r\n]/g, '').length >= 4);
      const score = runs.reduce((s, r) => s + (r.match(/[A-Za-zÁÉÍÓÚÑáéíóúñ]{3,}/g) || []).length, 0);
      return { runs, score };
    };

    const cand16 = tryDecode('utf-16le');
    const cand1252 = tryDecode('windows-1252');
    const best = cand16.score >= cand1252.score ? cand16 : cand1252;

    if (best.runs.length === 0) {
      throw new Error('No se pudo leer el .doc. Conviértelo a .docx o .xlsx e inténtalo de nuevo.');
    }

    // Unir corridas en líneas; \x07 = fin de celda (tabla), \r/\n = fin de fila
    const lines = best.runs
      .join('\n')
      .split(/[\r\n]+/)
      .map(l => l.replace(/\x07/g, '\t').trim())
      .filter(l => l !== '');

    const grids = [];
    let current = null;
    lines.forEach(line => {
      const cells = line.split(/\t+/).map(c => c.trim()).filter(c => c !== '');
      if (cells.length === 0) return;
      if (cells.length >= 2) {
        if (!current) { current = []; grids.push({ name: 'Tabla', grid: current }); }
        current.push(cells);
      } else if (current) {
        current.push(cells); // línea suelta dentro de la tabla
      }
    });

    if (grids.length === 0) {
      grids.push({ name: fileBaseName(file.name), grid: lines.map(l => [l]) });
    }

    return {
      grids,
      warning: 'El formato .doc antiguo se lee de forma aproximada. Revisa la previsualización antes de importar.',
    };
  }

  // ----------------------------------------------------------------
  // VALIDACIÓN
  // ----------------------------------------------------------------

  /**
   * Valida tipo y tamaño del archivo antes de procesarlo.
   * @param {File} file
   * @returns {{ valid: boolean, error: string|null, format: string|null }}
   */
  function validateFile(file) {
    if (!file) return { valid: false, error: 'No se seleccionó ningún archivo.', format: null };
    const ext = fileExt(file.name);
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      return {
        valid: false,
        error: `Tipo de archivo no permitido: "${file.name}". Se aceptan: ${ALLOWED_EXTENSIONS.join(', ')}.`,
        format: ext,
      };
    }
    if (file.size > MAX_FILE_SIZE) {
      return { valid: false, error: 'El archivo es demasiado grande. El límite es 20 MB.', format: ext };
    }
    return { valid: true, error: null, format: ext };
  }

  // ----------------------------------------------------------------
  // LECTURA + DETECCIÓN
  // ----------------------------------------------------------------

  /**
   * Lee el archivo y detecta hojas/tablas, encabezado, mapeo y desarrollador.
   * @param {File} file
   * @returns {Promise<{ sheets: Object[], fileName: string, format: string, warning: string|null }>}
   */
  async function read(file) {
    const { valid, error, format } = validateFile(file);
    if (!valid) throw new Error(error);

    let grids;
    let warning = null;

    if (format === '.xlsx' || format === '.xls' || format === '.xlsm') {
      grids = await readExcel(file);
    } else if (format === '.csv') {
      grids = await readCsv(file);
    } else if (format === '.pdf') {
      grids = await readPdf(file);
    } else if (format === '.docx') {
      grids = await readDocx(file);
    } else if (format === '.doc') {
      const res = await readDoc(file);
      grids = res.grids;
      warning = res.warning;
    } else {
      throw new Error(`Formato no soportado: ${format}`);
    }

    if (!grids || grids.length === 0) {
      throw new Error('No se encontraron tablas ni filas en el archivo.');
    }

    // Descartar hojas completamente vacías
    const useful = grids.filter(g => (g.grid || []).some(r => (r || []).some(c => String(c).trim() !== '')));
    if (useful.length === 0) {
      throw new Error('El archivo no contiene filas con datos.');
    }

    const sheets = useful.map(g => {
      const headerRow = detectHeaderRow(g.grid);
      const { map, headers } = mapColumns(g.grid, headerRow);
      // Tabla de una sola columna sin encabezado reconocible → descripción
      const singleCol = (g.grid[headerRow] || []).filter(c => String(c).trim() !== '').length <= 1
        && g.grid.reduce((m, r) => Math.max(m, (r || []).length), 0) === 1;
      if (singleCol && map.description === undefined && (g.grid[headerRow] || []).length >= 1) {
        map.description = 0;
      }
      const sheet = {
        name: g.name,
        grid: g.grid,
        headerRow,
        headers,
        map,
        developer: detectDeveloper(g.grid, headerRow, g.name, file.name),
        despacho: true,
        tickets: [],
        despachoCount: 0,
        duplicatesRemoved: 0,
        selected: true,
      };
      recomputeSheet(sheet);
      return sheet;
    });

    return { sheets, fileName: file.name, format, warning };
  }

  /** Recalcula los tickets de una hoja según su configuración actual. */
  function recomputeSheet(sheet) {
    const { tickets, despachoCount, duplicatesRemoved } = buildTickets(sheet);
    sheet.tickets = tickets;
    sheet.despachoCount = despachoCount;
    sheet.duplicatesRemoved = duplicatesRemoved;
  }

  // ----------------------------------------------------------------
  // MODAL DE PREVISUALIZACIÓN
  // ----------------------------------------------------------------

  const PREVIEW_ROWS = 40;

  let _session = null; // estado del modal abierto

  /**
   * Lee el archivo, muestra la previsualización y espera la confirmación.
   * @param {File} file
   * @returns {Promise<{ programmers: Object, loadedAt: string, duplicatesRemoved: number }|null>}
   */
  async function open(file) {
    const parsed = await read(file);
    // Ocultar el overlay de carga antes de mostrar el modal interactivo
    if (typeof UI !== 'undefined') UI.setLoading(false);
    return await preview(parsed);
  }

  /**
   * Muestra el modal de previsualización sobre un archivo ya leído.
   * @param {{ sheets: Object[], fileName: string, format: string, warning: string|null }} parsed
   * @returns {Promise<{ programmers: Object, loadedAt: string, duplicatesRemoved: number }|null>}
   */
  function preview(parsed) {
    return new Promise((resolve) => {
      _session = {
        parsed,
        activeSheet: 0,
        resolve,
      };

      const modal = document.getElementById('smart-import-modal');
      if (!modal) { resolve(null); return; }

      document.getElementById('smart-import-file').textContent =
        `${parsed.fileName} · ${parsed.format.replace('.', '').toUpperCase()}`;

      modal.classList.remove('hidden');
      modal.classList.add('active');
      render();

      document.getElementById('smart-import-close')?.addEventListener('click', closeHandler);
      document.getElementById('smart-import-cancel')?.addEventListener('click', closeHandler);
      document.getElementById('smart-import-confirm')?.addEventListener('click', confirmHandler);
      document.getElementById('smart-import-body')?.addEventListener('change', changeHandler);
      document.getElementById('smart-import-body')?.addEventListener('click', tabClickHandler);
      document.addEventListener('keydown', keydownHandler);
    });
  }

  function closeHandler() { finish(null); }

  function keydownHandler(e) {
    if (e.key === 'Escape') finish(null);
  }

  function confirmHandler() {
    if (!_session) return;
    const programmers = {};
    let duplicatesRemoved = 0;

    _session.parsed.sheets.forEach(s => {
      if (!s.tickets || s.tickets.length === 0) return;
      const dev = (String(s.developer || '').trim() || s.name || 'Programador').trim();
      programmers[dev] = [...(programmers[dev] || []), ...s.tickets];
      duplicatesRemoved += s.duplicatesRemoved || 0;
    });

    const names = Object.keys(programmers);
    if (names.length === 0) return; // nada seleccionable: el botón está deshabilitado

    finish({
      programmers,
      loadedAt: new Date().toISOString(),
      duplicatesRemoved,
    });
  }

  function finish(result) {
    if (!_session) return;
    const modal = document.getElementById('smart-import-modal');
    modal?.classList.add('hidden');
    modal?.classList.remove('active');
    document.getElementById('smart-import-close')?.removeEventListener('click', closeHandler);
    document.getElementById('smart-import-cancel')?.removeEventListener('click', closeHandler);
    document.getElementById('smart-import-confirm')?.removeEventListener('click', confirmHandler);
    document.getElementById('smart-import-body')?.removeEventListener('change', changeHandler);
    document.getElementById('smart-import-body')?.removeEventListener('click', tabClickHandler);
    document.removeEventListener('keydown', keydownHandler);
    const resolve = _session.resolve;
    _session = null;
    resolve(result);
  }

  /** Click en las pestañas de hoja. */
  function tabClickHandler(e) {
    const btn = e.target.closest('[data-sheet-idx]');
    if (!btn || !_session) return;
    _session.activeSheet = Number(btn.dataset.sheetIdx);
    render();
  }

  /** Cambios en los controles del cuerpo del modal. */
  function changeHandler(e) {
    if (!_session) return;
    const t = e.target;
    const sheet = _session.parsed.sheets[_session.activeSheet];
    if (!sheet) return;

    if (t.name === 'smart-dev') {
      sheet.developer = t.value;
      updateSummary(); // solo resumen: no re-render (evita perder el foco)
      return;
    }
    if (t.name === 'smart-header-row') {
      sheet.headerRow = Number(t.value) || 0;
      const { map, headers } = mapColumns(sheet.grid, sheet.headerRow);
      sheet.map = map;
      sheet.headers = headers;
      recomputeSheet(sheet);
      render();
      return;
    }
    if (t.name && t.name.startsWith('smart-col-')) {
      const col = Number(t.name.replace('smart-col-', ''));
      const field = t.value;
      // Quitar el campo de otra columna que lo tuviera y asignarlo aquí
      if (field === '') {
        const was = Object.entries(sheet.map).find(([, c]) => c === col);
        if (was) delete sheet.map[was[0]];
      } else {
        delete sheet.map[field];
        sheet.map[field] = col;
      }
      recomputeSheet(sheet);
      render();
      return;
    }
    if (t.name === 'smart-despacho') {
      sheet.despacho = t.checked;
      recomputeSheet(sheet);
      render();
    }
  }

  /** Render completo del cuerpo del modal. */
  function render() {
    if (!_session) return;
    const { sheets, warning } = _session.parsed;
    const body = document.getElementById('smart-import-body');
    const sheet = sheets[_session.activeSheet] || sheets[0];
    if (!sheet) return;

    const totalTickets = sheets.reduce((s, x) => s + (x.tickets?.length || 0), 0);
    const noTicketTotal = sheets.reduce((s, x) => s + (x.despachoCount || 0), 0);

    let html = '';

    // Pestañas de hojas
    if (sheets.length > 1) {
      html += `<div class="smart-import__sheets" role="tablist">`;
      sheets.forEach((s, i) => {
        html += `
          <button type="button" class="smart-import__tab ${i === _session.activeSheet ? 'smart-import__tab--active' : ''}"
                  data-sheet-idx="${i}" role="tab">
            ${esc(s.name)} <span class="smart-import__tab-count">${s.tickets?.length || 0}</span>
          </button>`;
      });
      html += `</div>`;
    }

    // Controles
    const headerOptions = sheet.grid.slice(0, Math.min(sheet.grid.length, 30)).map((r, i) => {
      const preview = r.filter(c => String(c).trim() !== '').slice(0, 4).join(' · ').slice(0, 60);
      return `<option value="${i}" ${i === sheet.headerRow ? 'selected' : ''}>Fila ${i + 1}${preview ? ' — ' + esc(preview) : ' — (vacía)'}</option>`;
    }).join('');

    html += `
      <div class="smart-import__controls">
        <div class="form-group">
          <label class="form-label">Programador / Hoja</label>
          <input type="text" class="form-input" name="smart-dev" value="${esc(sheet.developer)}"
                 placeholder="Nombre del programador" />
        </div>
        <div class="form-group">
          <label class="form-label">Fila de encabezado</label>
          <select class="form-input smart-import__select" name="smart-header-row">${headerOptions}</select>
        </div>
      </div>`;

    // Mapeo de columnas
    const width = sheet.grid.reduce((m, r) => Math.max(m, (r || []).length), 0);
    const colOptions = (sel) =>
      `<option value="" ${sel === null ? 'selected' : ''}>Ignorar</option>` +
      FIELDS.map(f => `<option value="${f.key}" ${sel === f.key ? 'selected' : ''}>${f.label}</option>`).join('');

    const reverseMap = {}; // col → field
    Object.entries(sheet.map).forEach(([f, c]) => { reverseMap[c] = f; });

    html += `<div class="smart-import__mapping"><span class="form-label">Mapeo de columnas</span><div class="smart-import__mapping-grid">`;
    for (let c = 0; c < width; c++) {
      const headerText = (sheet.headers[c] || '').trim() || `(Columna ${c + 1})`;
      const sel = reverseMap[c] !== undefined ? reverseMap[c] : null;
      html += `
        <div class="smart-import__col" title="${esc(headerText)}">
          <span class="smart-import__col-name">${esc(headerText.slice(0, 28))}${headerText.length > 28 ? '…' : ''}</span>
          <select class="form-input smart-import__select" name="smart-col-${c}">${colOptions(sel)}</select>
        </div>`;
    }
    html += `</div></div>`;

    // Toggle Despacho
    html += `
      <label class="smart-import__toggle">
        <input type="checkbox" name="smart-despacho" ${sheet.despacho ? 'checked' : ''} />
        <span>Asignar <strong>«Despacho N»</strong> a filas sin número de ticket
          <em>(${sheet.despachoCount} fila${sheet.despachoCount === 1 ? '' : 's'})</em></span>
      </label>`;

    // Tabla de previsualización
    const rows = sheet.tickets || [];
    html += `<div class="smart-import__table-wrap">`;
    if (rows.length === 0) {
      html += `<div class="smart-import__empty">
        No se detectaron filas de datos en esta hoja.<br/>
        Ajusta la <strong>fila de encabezado</strong> o el <strong>mapeo de columnas</strong>.
      </div>`;
    } else {
      html += `
        <table class="data-table smart-import__table">
          <thead>
            <tr>
              <th>#</th><th>N° Ticket</th><th>Descripción</th><th>Proyecto</th>
              <th>Tipo</th><th>Estado</th><th>Notas</th>
            </tr>
          </thead>
          <tbody>`;
      rows.slice(0, PREVIEW_ROWS).forEach((t, i) => {
        html += `
          <tr>
            <td class="smart-import__rownum">${i + 1}</td>
            <td class="smart-import__ticket">${esc(t.ticket)}</td>
            <td class="smart-import__desc" title="${esc(t.description)}">${esc(t.description)}</td>
            <td>${esc(t.project)}</td>
            <td>${esc(t.tipo)}</td>
            <td>${esc(t.status)}</td>
            <td class="smart-import__notes">${esc(t.notes)}</td>
          </tr>`;
      });
      html += `</tbody></table>`;
      if (rows.length > PREVIEW_ROWS) {
        html += `<p class="smart-import__more">+ ${rows.length - PREVIEW_ROWS} fila${rows.length - PREVIEW_ROWS === 1 ? '' : 's'} más (se importarán igual)</p>`;
      }
    }
    html += `</div>`;

    if (warning) {
      html += `<div class="alert alert--error smart-import__warning" role="alert">${esc(warning)}</div>`;
    }

    body.innerHTML = html;
    updateSummary();

    const confirmBtn = document.getElementById('smart-import-confirm');
    if (confirmBtn) {
      confirmBtn.disabled = totalTickets === 0;
      confirmBtn.textContent = totalTickets > 0 ? `Importar ${totalTickets} ticket${totalTickets === 1 ? '' : 's'}` : 'Importar';
    }
  }

  /** Actualiza el resumen del pie y el estado del botón Confirmar. */
  function updateSummary() {
    if (!_session) return;
    const { sheets } = _session.parsed;
    const totalTickets = sheets.reduce((s, x) => s + (x.tickets?.length || 0), 0);
    const noTicketTotal = sheets.reduce((s, x) => s + (x.despachoCount || 0), 0);
    const devs = new Set(sheets.filter(s => s.tickets?.length).map(s => (s.developer || '').trim()));

    const el = document.getElementById('smart-import-summary');
    if (el) {
      if (totalTickets === 0) {
        el.textContent = 'Sin tickets detectados';
      } else {
        let txt = `${totalTickets} ticket${totalTickets === 1 ? '' : 's'} · ${devs.size} programador${devs.size === 1 ? '' : 'es'}`;
        if (noTicketTotal > 0) txt += ` · ${noTicketTotal} como «Despacho»`;
        el.textContent = txt;
      }
    }
    const confirmBtn = document.getElementById('smart-import-confirm');
    if (confirmBtn) {
      confirmBtn.disabled = totalTickets === 0;
      confirmBtn.textContent = totalTickets > 0 ? `Importar ${totalTickets} ticket${totalTickets === 1 ? '' : 's'}` : 'Importar';
    }
  }

  // ----------------------------------------------------------------
  // API PÚBLICA
  // ----------------------------------------------------------------

  return {
    open,        // leer + previsualizar + confirmar
    read,        // leer y detectar (sin modal)
    preview,     // previsualizar un parseo previo
    validateFile,
    // Internos expuestos para pruebas automatizadas (scripts/test-smart-import.mjs)
    _internal: {
      normHeader,
      headerScore,
      detectHeaderRow,
      mapColumns,
      detectDeveloper,
      buildTickets,
      pdfItemsToGrid,
      extractBlocks,
      wordText,
      isNoTicket,
      workbookToGrids,
      COLUMN_SYNONYMS,
      FIELDS,
    },
  };

})();
