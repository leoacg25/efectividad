/**
 * attachments.js — Adjuntos de imágenes para notas/comentarios
 * =============================================================
 * Responsable de:
 *   - Convertir imágenes (pegadas, arrastradas o seleccionadas) a WebP
 *     comprimido para minimizar el espacio que ocupan.
 *   - Validar límites por imagen, por ticket y por programador.
 *   - Mostrar una vista previa (lightbox) y el badge de adjuntos.
 *
 * Los adjuntos se guardan dentro de cada ticket como:
 *   attachments: [{ id, name, type, dataUrl, width, height, bytes }]
 *
 * NOTA: WebM es un formato de VIDEO; el equivalente comprimido para
 * imágenes es WebP. Por eso se usa image/webp (con fallback a JPEG en
 * navegadores antiguos).
 */

const Attachments = (() => {

  // ----------------------------------------------------------------
  // LÍMITES
  // ----------------------------------------------------------------

  /** Máximo de imágenes por ticket. */
  const MAX_PER_TICKET = 4;
  /** Máximo de caracteres del dataURL de una sola imagen (~38 KB binarios). */
  const MAX_IMAGE_CHARS = 52000;
  /** Máximo de caracteres de imágenes por ticket (~157 KB binarios). */
  const MAX_TICKET_CHARS = 210000;
  /** Máximo estimado del documento de un programador en Firestore (~850 KB). */
  const MAX_PROGRAMMER_CHARS = 850000;

  /** Lado máximo (px) al que se redimensiona una imagen. */
  const MAX_DIMENSION = 1280;
  /** Calidad mínima aceptada antes de seguir reduciendo dimensiones. */
  const MIN_QUALITY = 0.55;

  let webpSupport = null;

  // ----------------------------------------------------------------
  // HELPERS
  // ----------------------------------------------------------------

  function supportsWebp() {
    if (webpSupport !== null) return webpSupport;
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      webpSupport = canvas.toDataURL('image/webp').indexOf('data:image/webp') === 0;
    } catch (_) {
      webpSupport = false;
    }
    return webpSupport;
  }

  /** Estima los bytes binarios a partir de la longitud de un dataURL. */
  function estimateBytes(dataUrl) {
    if (typeof dataUrl !== 'string') return 0;
    const comma = dataUrl.indexOf(',');
    const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : '';
    return Math.round((b64.length * 3) / 4);
  }

  /** Formatea bytes a un texto legible. */
  function formatBytes(bytes) {
    const n = Number(bytes) || 0;
    if (n <= 0) return '0 B';
    const units = ['B', 'KB', 'MB'];
    let value = n;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit++;
    }
    const decimals = unit === 0 || value >= 10 ? 0 : 1;
    return `${value.toFixed(decimals)} ${units[unit]}`;
  }

  /** Longitud del JSON serializado (para estimar el tamaño en Firestore). */
  function estimateChars(value) {
    try {
      return JSON.stringify(value).length;
    } catch (_) {
      return Infinity;
    }
  }

  function newId() {
    return 'att_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }

  function normalizeName(name, type) {
    const ext = type === 'image/jpeg' ? '.jpg' : '.webp';
    let base = String(name || 'imagen').trim() || 'imagen';
    base = base.replace(/[\\/:*?"<>|]+/g, '-');
    if (/\.(png|jpe?g|gif|bmp|webp|avif|heic|heif|tiff?)$/i.test(base)) {
      base = base.replace(/\.[^.]+$/, '');
    }
    if (!base) base = 'imagen';
    return (base.length > 60 ? base.slice(0, 60) : base) + ext;
  }

  // ----------------------------------------------------------------
  // PROCESAMIENTO DE IMÁGENES
  // ----------------------------------------------------------------

  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('No se pudo leer la imagen'));
      };
      img.src = url;
    });
  }

  function drawToDataUrl(img, width, height, type, quality) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    // JPEG no soporta transparencia: se rellena con blanco.
    if (type === 'image/jpeg') {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, width, height);
    }
    ctx.drawImage(img, 0, 0, width, height);
    return canvas.toDataURL(type, quality);
  }

  /**
   * Comprime un archivo de imagen hasta que quepa en MAX_IMAGE_CHARS.
   * @param {File|Blob} file
   * @returns {Promise<Object>} adjunto listo para guardarse
   */
  async function compress(file) {
    const img = await loadImage(file);
    const type = supportsWebp() ? 'image/webp' : 'image/jpeg';
    const originalW = img.naturalWidth || img.width || 1;
    const originalH = img.naturalHeight || img.height || 1;

    let maxDim = MAX_DIMENSION;
    let quality = 0.82;
    let dataUrl = '';
    let outW = originalW;
    let outH = originalH;

    for (let attempt = 0; attempt < 16; attempt++) {
      const scale = Math.min(1, maxDim / Math.max(originalW, originalH));
      outW = Math.max(1, Math.round(originalW * scale));
      outH = Math.max(1, Math.round(originalH * scale));
      dataUrl = drawToDataUrl(img, outW, outH, type, quality);
      if (dataUrl.length <= MAX_IMAGE_CHARS) break;

      if (quality > MIN_QUALITY) {
        quality = Math.max(MIN_QUALITY, quality - 0.1);
      } else if (maxDim > 320) {
        maxDim = Math.max(320, Math.round(maxDim * 0.8));
      } else {
        dataUrl = '';
        break;
      }
    }

    if (!dataUrl || dataUrl.length > MAX_IMAGE_CHARS) {
      throw new Error('la imagen es demasiado grande incluso después de comprimirla');
    }

    const resolvedType = dataUrl.slice(5, dataUrl.indexOf(';')) || type;
    return {
      id: newId(),
      name: normalizeName(file.name, resolvedType),
      type: resolvedType,
      dataUrl,
      width: outW,
      height: outH,
      bytes: estimateBytes(dataUrl),
    };
  }

  /**
   * Procesa una lista de archivos y devuelve los adjuntos válidos.
   * @param {FileList|File[]} fileList
   * @param {{ existing?: Array, max?: number }} options
   * @returns {Promise<{ added: Array, errors: string[], skipped: number }>}
   */
  async function processFiles(fileList, options = {}) {
    const existing = Array.isArray(options.existing) ? options.existing : [];
    const max = Number.isFinite(options.max) ? options.max : MAX_PER_TICKET;
    const files = Array.from(fileList || []);
    const result = { added: [], errors: [], skipped: 0 };

    let totalChars = existing.reduce((sum, a) => sum + (a && a.dataUrl ? a.dataUrl.length : 0), 0);

    for (const file of files) {
      if (!file) continue;
      if (file.type && !/^image\//i.test(file.type)) {
        result.errors.push(`"${file.name || 'archivo'}" no es una imagen válida.`);
        continue;
      }
      if (existing.length + result.added.length >= max) {
        result.skipped++;
        continue;
      }

      try {
        const attachment = await compress(file);
        if (totalChars + attachment.dataUrl.length > MAX_TICKET_CHARS) {
          result.errors.push(`No hay espacio suficiente para "${attachment.name}" en este ticket.`);
          continue;
        }
        totalChars += attachment.dataUrl.length;
        result.added.push(attachment);
      } catch (err) {
        result.errors.push(`${file.name || 'Imagen'}: ${err.message}`);
      }
    }

    return result;
  }

  // ----------------------------------------------------------------
  // SANITIZACIÓN
  // ----------------------------------------------------------------

  /**
   * Normaliza los adjuntos leídos de Firestore/localStorage.
   * No descarta adjuntos existentes por cantidad, solo por formato inválido.
   * @param {Array} list
   * @returns {Array}
   */
  function sanitize(list) {
    if (!Array.isArray(list)) return [];
    return list
      .filter(a => a && typeof a.dataUrl === 'string'
        && /^data:image\/(webp|jpeg|jpg|png)/i.test(a.dataUrl)
        && a.dataUrl.length <= MAX_TICKET_CHARS)
      .map(a => {
        const dataUrl = a.dataUrl;
        const comma = dataUrl.indexOf(';');
        const detected = comma > 5 ? dataUrl.slice(5, comma) : 'image/webp';
        return {
          id: a.id ? String(a.id) : newId(),
          name: a.name ? String(a.name) : 'imagen',
          type: typeof a.type === 'string' && a.type ? a.type : detected,
          dataUrl,
          width: Number(a.width) || 0,
          height: Number(a.height) || 0,
          bytes: Number(a.bytes) || estimateBytes(dataUrl),
        };
      });
  }

  // ----------------------------------------------------------------
  // BADGE PARA LA TABLA
  // ----------------------------------------------------------------

  /**
   * Devuelve el HTML del badge "clip + cantidad" para la celda de notas.
   * @param {Array} list
   * @returns {string}
   */
  function renderBadge(list) {
    const count = Array.isArray(list)
      ? list.filter(a => a && typeof a.dataUrl === 'string').length
      : 0;
    if (!count) return '';
    const label = count === 1 ? '1 imagen adjunta' : `${count} imágenes adjuntas`;
    return `<span class="notes-attach-badge" title="${label}" aria-label="${label}">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" width="12" height="12" aria-hidden="true">
        <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/>
      </svg>${count}</span>`;
  }

  // ----------------------------------------------------------------
  // LIGHTBOX DE VISTA PREVIA
  // ----------------------------------------------------------------

  let previewReady = false;

  function initPreview() {
    if (previewReady) return;
    const overlay = document.getElementById('image-lightbox');
    if (!overlay) return;
    previewReady = true;

    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) closePreview();
    });

    document.getElementById('image-lightbox-close')?.addEventListener('click', closePreview);

    // Captura para que Esc cierre solo el lightbox y no el modal de notas.
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !overlay.classList.contains('hidden')) {
        e.stopPropagation();
        closePreview();
      }
    }, true);
  }

  /**
   * Abre la vista previa de un adjunto.
   * @param {{name:string,dataUrl:string,width:number,height:number,bytes:number}} att
   */
  function openPreview(att) {
    if (!att || typeof att.dataUrl !== 'string') return;
    initPreview();
    const overlay = document.getElementById('image-lightbox');
    const img = document.getElementById('image-lightbox-img');
    const caption = document.getElementById('image-lightbox-caption');
    const download = document.getElementById('image-lightbox-download');
    if (!overlay || !img) return;

    img.src = att.dataUrl;
    img.alt = att.name || 'Imagen adjunta';

    const dims = att.width && att.height ? ` · ${att.width}×${att.height}` : '';
    if (caption) caption.textContent = `${att.name || 'Imagen'}${dims} · ${formatBytes(att.bytes)}`;

    if (download) {
      download.href = att.dataUrl;
      download.download = att.name || 'imagen.webp';
    }

    overlay.classList.remove('hidden');
    overlay.classList.add('active');
  }

  function closePreview() {
    const overlay = document.getElementById('image-lightbox');
    const img = document.getElementById('image-lightbox-img');
    if (!overlay) return;
    overlay.classList.add('hidden');
    overlay.classList.remove('active');
    if (img) img.removeAttribute('src');
  }

  // ----------------------------------------------------------------
  // API PÚBLICA
  // ----------------------------------------------------------------

  return {
    MAX_PER_TICKET,
    MAX_IMAGE_CHARS,
    MAX_TICKET_CHARS,
    MAX_PROGRAMMER_CHARS,
    processFiles,
    sanitize,
    estimateBytes,
    estimateChars,
    formatBytes,
    renderBadge,
    openPreview,
    closePreview,
  };

})();
