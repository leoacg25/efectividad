/**
 * exporter.js — Módulo de Exportación CSV y PDF
 * ===============================================
 * Responsable de:
 *   - Exportar tabla de tickets a formato CSV (individual y global)
 *   - Generar reportes PDF individuales con diseño corporativo usando jsPDF + AutoTable
 *   - Generar reporte PDF consolidado con ranking y captura del gráfico
 */

const Exporter = (() => {

  // ----------------------------------------------------------------
  // HELPERS
  // ----------------------------------------------------------------

  /**
   * Escapa un valor para CSV (entre comillas si contiene comas, saltos, comillas).
   * @param {*} val
   * @returns {string}
   */
  function escapeCsv(val) {
    const str = String(val ?? '');
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  }

  /**
   * Dispara la descarga de un archivo en el navegador.
   * @param {string} content - Contenido del archivo
   * @param {string} filename - Nombre del archivo a descargar
   * @param {string} mimeType - Tipo MIME
   */
  function triggerDownload(content, filename, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /**
   * Formatea una fecha para usar en nombres de archivo y encabezados.
   * @param {Date} date
   * @returns {{ full: string, file: string }}
   */
  function formatDate(date = new Date()) {
    const pad = n => String(n).padStart(2, '0');
    const full = `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    const file = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
    return { full, file };
  }

  /**
   * Calcula efectividad de un array de tickets.
   * @param {Array} tickets
   * @returns {{ total: number, solved: number, noAplica: number, infoAdicional: number, inProgress: number, unsolved: number, pct: number }}
   */
  function calcStats(tickets) {
    const averias = tickets.filter(t => t.tipo === 'Avería/Falla').length;
    const total = tickets.length;
    const solved = tickets.filter(t => t.status === 'Solventado').length;
    const noAplica = tickets.filter(t => t.status === 'No Aplica').length;
    const infoAdicional = tickets.filter(t => t.status === 'Información Adicional').length;
    const inProgress = tickets.filter(t => t.status === 'En proceso').length;
    const unsolved = tickets.filter(t => t.status === 'No resuelto').length;
    const excluded = noAplica + infoAdicional;
    const effectiveTotal = total - excluded;
    const pct = effectiveTotal > 0 ? Math.round((solved / effectiveTotal) * 100) : 0;
    return { total, solved, noAplica, infoAdicional, inProgress, unsolved, pct, effectiveTotal, averias };
  }

  /**
   * Retorna el color de efectividad según el porcentaje.
   * @param {number} pct
   * @returns {number[]} RGB array para jsPDF
   */
  function effectivenessColor(pct) {
    if (pct >= 75) return [16, 185, 129];  // Verde
    if (pct >= 40) return [245, 158, 11];  // Amarillo
    return [239, 68, 68];                   // Rojo
  }

  // ----------------------------------------------------------------
  // IMÁGENES ADJUNTAS PARA PDF
  // ----------------------------------------------------------------

  /**
   * Carga una imagen desde un dataURL.
   * @param {string} dataUrl
   * @returns {Promise<HTMLImageElement>}
   */
  function loadImageElement(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('No se pudo leer la imagen adjunta'));
      img.src = dataUrl;
    });
  }

  /**
   * Convierte un adjunto a JPEG (máx. 1000 px) para incrustarlo en el PDF
   * con un tamaño razonable.
   * @param {{dataUrl:string, name?:string}} attachment
   * @returns {Promise<{dataUrl:string, format:string, width:number, height:number, name:string}>}
   */
  async function prepareImageForPdf(attachment) {
    const img = await loadImageElement(attachment.dataUrl);
    const srcW = img.naturalWidth || img.width || 1;
    const srcH = img.naturalHeight || img.height || 1;
    const maxDim = 1000;
    const scale = Math.min(1, maxDim / Math.max(srcW, srcH));
    const width = Math.max(1, Math.round(srcW * scale));
    const height = Math.max(1, Math.round(srcH * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0, width, height);

    return {
      dataUrl: canvas.toDataURL('image/jpeg', 0.82),
      format: 'JPEG',
      width,
      height,
      name: attachment.name || 'imagen.jpg',
    };
  }

  /**
   * Devuelve los adjuntos válidos de un ticket.
   * @param {Object} ticket
   * @returns {Array}
   */
  function getTicketImages(ticket) {
    const list = ticket && Array.isArray(ticket.attachments) ? ticket.attachments : [];
    return list.filter(a => a && typeof a.dataUrl === 'string'
      && /^data:image\/(webp|jpeg|jpg|png)/i.test(a.dataUrl));
  }

  /**
   * Prepara las imágenes de todos los tickets que tengan adjuntos.
   * @param {Array} tickets
   * @returns {Promise<Array<{ticket:Object, images:Array}>>}
   */
  async function prepareAttachmentGroups(tickets) {
    const groups = [];
    for (const ticket of tickets || []) {
      const images = getTicketImages(ticket);
      if (!images.length) continue;

      const prepared = [];
      for (const attachment of images) {
        try {
          prepared.push(await prepareImageForPdf(attachment));
        } catch (err) {
          console.warn('[Exporter] No se pudo preparar una imagen adjunta:', err);
        }
      }
      if (prepared.length) groups.push({ ticket, images: prepared });
    }
    return groups;
  }

  /**
   * Dibuja la sección de anexos con las imágenes adjuntas.
   * @param {jsPDF} doc
   * @param {Array<{ticket:Object, images:Array}>} groups
   * @param {number} startY
   * @returns {number} cursor Y final
   */
  function drawAttachmentsAnnex(doc, groups, startY) {
    const margin = 14;
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const contentW = pageWidth - margin * 2;
    const cols = 2;
    const gap = 5;
    const cellW = (contentW - gap) / cols;
    const imageBoxH = 52;
    const captionH = 7;
    const rowH = imageBoxH + captionH;
    const bottomLimit = pageHeight - 20;
    let y = startY;

    const addContinuationPage = () => {
      doc.addPage();
      y = drawPdfHeader(doc, 'Anexos — Imágenes adjuntas (continuación)', '');
    };

    groups.forEach(group => {
      // Encabezado del ticket + al menos una fila de imágenes
      if (y + 12 + rowH > bottomLimit) addContinuationPage();

      doc.setFillColor(99, 102, 241);
      doc.roundedRect(margin, y, contentW, 9, 2, 2, 'F');
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(9);
      doc.setTextColor(255, 255, 255);

      const ticketLabel = `Ticket ${group.ticket.ticket || '—'}`;
      const desc = group.ticket.description ? `  ·  ${group.ticket.description}` : '';
      const heading = doc.splitTextToSize(ticketLabel + desc, contentW - 6)[0] || ticketLabel;
      doc.text(heading, margin + 3, y + 6);
      y += 12;

      group.images.forEach((image, index) => {
        const col = index % cols;
        if (col === 0 && y + rowH > bottomLimit) addContinuationPage();

        const cellX = margin + col * (cellW + gap);
        const fit = Math.min(cellW / image.width, imageBoxH / image.height);
        const drawW = Math.max(1, image.width * fit);
        const drawH = Math.max(1, image.height * fit);
        const imgX = cellX + (cellW - drawW) / 2;
        const imgY = y + (imageBoxH - drawH) / 2;

        try {
          doc.addImage(image.dataUrl, image.format, imgX, imgY, drawW, drawH);
          doc.setDrawColor(210, 210, 225);
          doc.setLineWidth(0.3);
          doc.rect(imgX, imgY, drawW, drawH);
        } catch (err) {
          console.warn('[Exporter] No se pudo incrustar una imagen en el PDF:', err);
          doc.setFont('helvetica', 'normal');
          doc.setFontSize(8);
          doc.setTextColor(200, 60, 60);
          doc.text('No se pudo incrustar la imagen', cellX + 2, y + imageBoxH / 2);
        }

        doc.setFont('helvetica', 'normal');
        doc.setFontSize(7);
        doc.setTextColor(100, 100, 120);
        const caption = doc.splitTextToSize(image.name || 'imagen', cellW)[0] || 'imagen';
        doc.text(caption, cellX + 1, y + imageBoxH + 4.5);

        if (col === cols - 1 || index === group.images.length - 1) {
          y += rowH;
        }
      });

      y += 4;
    });

    return y;
  }

  // ----------------------------------------------------------------
  // ENCABEZADO PDF CORPORATIVO
  // ----------------------------------------------------------------

  /**
   * Dibuja el encabezado corporativo del PDF.
   * @param {jsPDF} doc
   * @param {string} title
   * @param {string} subtitle
   */
  function drawPdfHeader(doc, title, subtitle) {
    const { full: dateStr } = formatDate();
    const pageWidth = doc.internal.pageSize.getWidth();

    // Franja de color superior
    doc.setFillColor(99, 102, 241);
    doc.rect(0, 0, pageWidth, 28, 'F');

    // Acento secundario
    doc.setFillColor(168, 85, 247);
    doc.rect(pageWidth - 60, 0, 60, 28, 'F');

    // Título principal
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(16);
    doc.setTextColor(255, 255, 255);
    doc.text('EffectiveDev — Dashboard de Programadores', 14, 11);

    // Fecha
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(210, 210, 255);
    doc.text(`Generado: ${dateStr}`, 14, 19);

    // Subtítulo debajo del encabezado
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(14);
    doc.setTextColor(30, 30, 50);
    doc.text(title, 14, 40);

    if (subtitle) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(10);
      doc.setTextColor(100, 100, 120);
      doc.text(subtitle, 14, 48);
    }

    return subtitle ? 55 : 47; // Retorna el cursor Y después del encabezado
  }

  /**
   * Dibuja el pie de página en todas las páginas.
   * @param {jsPDF} doc
   */
  function drawPdfFooter(doc) {
    const pageCount = doc.internal.getNumberOfPages();
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();

    for (let i = 1; i <= pageCount; i++) {
      doc.setPage(i);
      doc.setDrawColor(200, 200, 210);
      doc.setLineWidth(0.3);
      doc.line(14, pageHeight - 15, pageWidth - 14, pageHeight - 15);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      doc.setTextColor(160, 160, 180);
      doc.text('Reporte generado por EffectiveDev', 14, pageHeight - 8);
      doc.text(`Página ${i} de ${pageCount}`, pageWidth - 14, pageHeight - 8, { align: 'right' });
    }
  }

  // ----------------------------------------------------------------
  // CSV INDIVIDUAL
  // ----------------------------------------------------------------

  /**
   * Exporta los tickets de un programador a CSV.
   * @param {string} programmerName
   * @param {Array} tickets
   */
  function exportCSVIndividual(programmerName, tickets) {
    const { file: dateStr } = formatDate();
    const stats = calcStats(tickets);

    const rows = [
      // Metadatos
      [`Programador`, programmerName],
      [`Efectividad`, `${stats.pct}%`],
      [`Total tickets`, stats.total],
      [`Solventados`, stats.solved],
      [`No Aplica`, stats.noAplica],
      [`Info. Adicional`, stats.infoAdicional],
      [`En proceso`, stats.inProgress],
      [`No resueltos`, stats.unsolved],
      [], // Fila vacía separadora
      // Encabezados de tabla
      ['N° Ticket', 'Descripción', 'Proyecto', 'Tipo', 'Notas', 'Estado'],
      // Datos
      ...tickets.map(t => [t.ticket, t.description, t.project, t.tipo || '', t.notes, t.status]),
    ];

    const csv = rows.map(row => row.map(escapeCsv).join(',')).join('\r\n');
    const content = '\uFEFF' + csv; // BOM para compatibilidad con Excel
    triggerDownload(content, `reporte_${programmerName.replace(/\s+/g, '_')}_${dateStr}.csv`, 'text/csv;charset=utf-8;');
  }

  // ----------------------------------------------------------------
  // CSV CONSOLIDADO
  // ----------------------------------------------------------------

  /**
   * Exporta el resumen global de todos los programadores a CSV.
   * @param {Object} programmers - { [nombre]: [tickets] }
   */
  function exportCSVConsolidated(programmers) {
    const { file: dateStr } = formatDate();

    // Calcular ranking
    const ranking = Object.entries(programmers)
      .map(([name, tickets]) => ({ name, ...calcStats(tickets) }))
      .sort((a, b) => b.pct - a.pct);

    const rows = [
      ['Reporte Consolidado — Dashboard de Efectividad de Programadores'],
      [],
      ['#', 'Programador', 'Tickets', 'Averías', 'Solventados', 'No Aplica', 'Info. Adicional', 'En Proceso', 'No Resueltos', 'Efectividad (%)'],
      ...ranking.map((r, i) => [i + 1, r.name, r.total, r.averias, r.solved, r.noAplica, r.infoAdicional, r.inProgress, r.unsolved, r.pct]),
    ];

    const csv = rows.map(row => row.map(escapeCsv).join(',')).join('\r\n');
    const content = '\uFEFF' + csv;
    triggerDownload(content, `reporte_consolidado_${dateStr}.csv`, 'text/csv;charset=utf-8;');
  }

  // ----------------------------------------------------------------
  // PDF INDIVIDUAL
  // ----------------------------------------------------------------

  /**
   * Exporta un reporte PDF individual de un programador.
   * Incluye un anexo con las imágenes adjuntas a las notas de cada ticket.
   * @param {string} programmerName
   * @param {Array} tickets
   * @returns {Promise<void>}
   */
  async function exportPDFIndividual(programmerName, tickets) {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const stats = calcStats(tickets);
    const effColor = effectivenessColor(stats.pct);

    // Preparar imágenes adjuntas antes de construir el documento (requiere decodificarlas)
    const attachmentGroups = await prepareAttachmentGroups(tickets);
    const imageCount = attachmentGroups.reduce((sum, group) => sum + group.images.length, 0);

    // Encabezado
    let cursorY = drawPdfHeader(doc, `Reporte Individual: ${programmerName}`, `Efectividad: ${stats.pct}%`);

    // Tarjetas de KPI
    const kpiData = [
      { label: 'Tickets', value: stats.total, color: [99, 102, 241] },
      { label: 'Averías',       value: stats.averias,    color: [239, 68, 68] },
      { label: 'Solventados',   value: stats.solved,     color: [16, 185, 129] },
      { label: 'No Aplica',     value: stats.noAplica,   color: [168, 85, 247] },
      { label: 'Info. Adic.',   value: stats.infoAdicional, color: [80, 190, 230] },
      { label: 'En Proceso',    value: stats.inProgress, color: [245, 158, 11] },
      { label: 'No Resueltos',  value: stats.unsolved,   color: [239, 68, 68] },
    ];

    const cardW = 23;
    const cardH = 22;
    const margin = 14;
    const gap = 3;
    let x = margin;
    const pageWidth = doc.internal.pageSize.getWidth();

    kpiData.forEach((kpi, i) => {
      doc.setFillColor(...kpi.color);
      doc.roundedRect(x, cursorY, cardW, cardH, 3, 3, 'F');
      doc.setFillColor(255, 255, 255);
      doc.setFillColor(...kpi.color.map(c => Math.min(255, c + 40)));

      doc.setFont('helvetica', 'bold');
      doc.setFontSize(18);
      doc.setTextColor(255, 255, 255);
      doc.text(String(kpi.value), x + cardW / 2, cursorY + 12, { align: 'center' });

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7);
      doc.setTextColor(220, 220, 255);
      doc.text(kpi.label, x + cardW / 2, cursorY + 19, { align: 'center' });

      x += cardW + gap;
    });

    cursorY += cardH + 12;

    // Barra de efectividad
    doc.setFillColor(235, 235, 245);
    doc.roundedRect(margin, cursorY, pageWidth - margin * 2, 8, 2, 2, 'F');
    const barWidth = (pageWidth - margin * 2) * (stats.pct / 100);
    doc.setFillColor(...effColor);
    doc.roundedRect(margin, cursorY, barWidth, 8, 2, 2, 'F');

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.setTextColor(...effColor);
    doc.text(`${stats.pct}% de efectividad`, margin + barWidth / 2, cursorY + 5.5, { align: 'center' });

    cursorY += 16;

    // Tabla de tickets
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(30, 30, 50);
    doc.text('Detalle de Tickets', margin, cursorY);
    cursorY += 5;

    const tableData = tickets.map(t => [
      t.ticket || '—',
      t.description || '—',
      t.project || '—',
      t.tipo || '—',
      t.notes || '—',
      t.status,
    ]);

    /**
     * Color de celda según estado del ticket.
     */
    doc.autoTable({
      startY: cursorY,
      head: [['N° Ticket', 'Descripción', 'Proyecto', 'Tipo', 'Notas', 'Estado']],
      body: tableData,
      theme: 'grid',
      margin: { left: margin, right: margin },
      styles: {
        font: 'helvetica',
        fontSize: 8.5,
        cellPadding: 3,
        textColor: [30, 30, 50],
        lineColor: [220, 220, 235],
        lineWidth: 0.3,
      },
      headStyles: {
        fillColor: [99, 102, 241],
        textColor: [255, 255, 255],
        fontStyle: 'bold',
        fontSize: 9,
      },
      alternateRowStyles: {
        fillColor: [248, 248, 255],
      },
      columnStyles: {
        0: { cellWidth: 20, fontStyle: 'bold' },
        1: { cellWidth: 55 },
        2: { cellWidth: 28 },
        3: { cellWidth: 28, halign: 'center' },
        4: { cellWidth: 35 },
        5: { cellWidth: 22, halign: 'center' },
      },
      /**
       * Colorear la celda de Estado según el valor.
       */
      didParseCell: (hookData) => {
        if (hookData.section === 'body' && hookData.column.index === 5) {
          const status = hookData.cell.raw;
          if (status === 'Solventado') {
            hookData.cell.styles.textColor = [16, 185, 129];
            hookData.cell.styles.fontStyle = 'bold';
          } else if (status === 'En proceso') {
            hookData.cell.styles.textColor = [245, 158, 11];
            hookData.cell.styles.fontStyle = 'bold';
          } else if (status === 'No Aplica') {
            hookData.cell.styles.textColor = [168, 85, 247];
            hookData.cell.styles.fontStyle = 'bold';
          } else if (status === 'Informaci\u00f3n Adicional') {
            hookData.cell.styles.textColor = [80, 190, 230];
            hookData.cell.styles.fontStyle = 'bold';
          } else {
            hookData.cell.styles.textColor = [239, 68, 68];
          }
        }
      }
    });

    const tableEndY = (doc.lastAutoTable && doc.lastAutoTable.finalY) || cursorY;

    // Nota sobre las imágenes adjuntas
    if (imageCount > 0) {
      const noteY = Math.min(tableEndY + 7, doc.internal.pageSize.getHeight() - 24);
      doc.setFont('helvetica', 'italic');
      doc.setFontSize(8);
      doc.setTextColor(110, 110, 130);
      doc.text(
        `${imageCount} imagen(es) adjunta(s) a las notas se incluyen en el Anexo de imágenes.`,
        margin,
        noteY
      );
    }

    // Anexo de imágenes adjuntas
    if (imageCount > 0) {
      doc.addPage();
      const annexY = drawPdfHeader(
        doc,
        'Anexo — Imágenes adjuntas',
        `${programmerName} · ${imageCount} imagen(es) · ${attachmentGroups.length} ticket(s)`
      );
      drawAttachmentsAnnex(doc, attachmentGroups, annexY);
    }

    drawPdfFooter(doc);

    const { file: dateStr } = formatDate();
    doc.save(`reporte_${programmerName.replace(/\s+/g, '_')}_${dateStr}.pdf`);
  }

  // ----------------------------------------------------------------
  // PDF CONSOLIDADO
  // ----------------------------------------------------------------

  /**
   * Exporta el reporte PDF consolidado con ranking y captura del chart.
   * @param {Object} programmers - { [nombre]: [tickets] }
   * @param {HTMLCanvasElement|null} chartCanvas - Canvas del Chart.js para capturar
   */
  function exportPDFConsolidated(programmers, chartCanvas) {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const pageWidth = doc.internal.pageSize.getWidth();
    const margin = 14;

    // Calcular stats globales
    const allTickets = Object.values(programmers).flat();
    const globalStats = calcStats(allTickets);

    // Calcular ranking
    const ranking = Object.entries(programmers)
      .map(([name, tickets]) => ({ name, ...calcStats(tickets) }))
      .sort((a, b) => b.pct - a.pct);

    // Encabezado
    let cursorY = drawPdfHeader(
      doc,
      'Reporte Consolidado',
      `Efectividad Global: ${globalStats.pct}% · ${Object.keys(programmers).length} programadores · ${allTickets.length} tickets`
    );

    // --- KPI Global ---
    const kpiData = [
      { label: 'Tickets',  value: globalStats.total,      color: [99, 102, 241] },
      { label: 'Averías',        value: globalStats.averias,    color: [239, 68, 68] },
      { label: 'Solventados',    value: globalStats.solved,     color: [16, 185, 129] },
      { label: 'No Aplica',      value: globalStats.noAplica,   color: [168, 85, 247] },
      { label: 'Info. Adic.',    value: globalStats.infoAdicional, color: [80, 190, 230] },
      { label: 'En Proceso',     value: globalStats.inProgress, color: [245, 158, 11] },
      { label: 'No Resueltos',   value: globalStats.unsolved,   color: [239, 68, 68] },
      { label: 'Programadores',  value: Object.keys(programmers).length, color: [34, 211, 238] },
    ];

    const cardW = (pageWidth - margin * 2 - (kpiData.length - 1) * 3) / kpiData.length;
    let x = margin;
    const cardH = 20;

    kpiData.forEach((kpi) => {
      doc.setFillColor(...kpi.color);
      doc.roundedRect(x, cursorY, cardW, cardH, 3, 3, 'F');

      doc.setFont('helvetica', 'bold');
      doc.setFontSize(16);
      doc.setTextColor(255, 255, 255);
      doc.text(String(kpi.value), x + cardW / 2, cursorY + 11, { align: 'center' });

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(6.5);
      doc.setTextColor(220, 220, 255);
      doc.text(kpi.label, x + cardW / 2, cursorY + 17, { align: 'center' });

      x += cardW + 3;
    });

    cursorY += cardH + 12;

    // --- Captura del Chart.js (si disponible) ---
    if (chartCanvas) {
      try {
        const imgData = chartCanvas.toDataURL('image/png');
        const imgW = pageWidth - margin * 2;
        const imgH = imgW * 0.45; // Proporción de la gráfica
        doc.addImage(imgData, 'PNG', margin, cursorY, imgW, imgH);
        cursorY += imgH + 10;
      } catch (e) {
        console.warn('[Exporter] No se pudo capturar el gráfico:', e);
        cursorY += 5;
      }
    }

    // --- Título de ranking ---
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.setTextColor(30, 30, 50);
    doc.text('Ranking de Efectividad', margin, cursorY);
    cursorY += 6;

    // --- Tabla de ranking ---
    const tableData = ranking.map((r, i) => [
      i + 1,
      r.name,
      r.total,
      r.averias,
      r.solved,
      r.noAplica,
      r.infoAdicional,
      r.inProgress,
      r.unsolved,
      `${r.pct}%`,
    ]);

    doc.autoTable({
      startY: cursorY,
      head: [['#', 'Programador', 'Tickets', 'Averías', 'Solventados', 'No Aplica', 'Info. Adic.', 'En Proceso', 'No Resueltos', 'Efectividad']],
      body: tableData,
      theme: 'striped',
      margin: { left: margin, right: margin },
      styles: {
        font: 'helvetica',
        fontSize: 9,
        cellPadding: 3.5,
        textColor: [30, 30, 50],
        lineColor: [220, 220, 235],
        lineWidth: 0.3,
      },
      headStyles: {
        fillColor: [99, 102, 241],
        textColor: [255, 255, 255],
        fontStyle: 'bold',
        fontSize: 9.5,
      },
      alternateRowStyles: {
        fillColor: [248, 248, 255],
      },
      columnStyles: {
        0: { cellWidth: 10, halign: 'center', fontStyle: 'bold' },
        1: { cellWidth: 42 },
        2: { cellWidth: 16, halign: 'center' },
        3: { cellWidth: 14, halign: 'center' },
        4: { cellWidth: 18, halign: 'center' },
        5: { cellWidth: 16, halign: 'center' },
        6: { cellWidth: 14, halign: 'center' },
        7: { cellWidth: 16, halign: 'center' },
        8: { cellWidth: 16, halign: 'center' },
        9: { cellWidth: 18, halign: 'center', fontStyle: 'bold' },
      },
      didParseCell: (hookData) => {
        if (hookData.section === 'body' && hookData.column.index === 9) {
          const pct = parseInt(hookData.cell.raw);
          const color = effectivenessColor(pct);
          hookData.cell.styles.textColor = color;
          hookData.cell.styles.fontStyle = 'bold';
        }
        // Medalla de ranking
        if (hookData.section === 'body' && hookData.column.index === 0) {
          const rank = hookData.cell.raw;
          if (rank === 1) hookData.cell.styles.textColor = [245, 158, 11];
          else if (rank === 2) hookData.cell.styles.textColor = [148, 163, 184];
          else if (rank === 3) hookData.cell.styles.textColor = [205, 120, 60];
        }
      }
    });

    drawPdfFooter(doc);

    const { file: dateStr } = formatDate();
    doc.save(`reporte_consolidado_${dateStr}.pdf`);
  }

  // ----------------------------------------------------------------
  // CSV GLOBAL DE PRUEBAS (por rol)
  // ----------------------------------------------------------------

  /**
   * Exporta CSV con efectividad calculada según el rol de cada programador.
   * @param {Object} programmers - { [nombre]: [tickets] }
   * @param {Object} profiles - { [nombre]: 'desarrollador' | 'lider' | 'evaluacion' }
   */
  function exportCSVPruebas(programmers, profiles) {
    const { file: dateStr } = formatDate();
    const roles = profiles || {};

    const entries = Object.entries(programmers);
    const devStats = {};
    for (const [name, tickets] of entries) {
      devStats[name] = calcStats(tickets);
    }

    // --- Clasificar por rol ---
    const devs = entries.filter(([name]) => !roles[name] || roles[name] === 'desarrollador');
    const leaders = entries.filter(([name]) => roles[name] === 'lider').map(([n]) => n);
    const evaluacion = entries.filter(([name]) => roles[name] === 'evaluacion').map(([n]) => n);

    // --- Calcular promedio de desarrolladores ---
    const devPcts = devs.map(([name]) => {
      const s = devStats[name];
      return s.effectiveTotal > 0 ? (s.solved / s.effectiveTotal) * 100 : 0;
    });
    const avgDevPct = devPcts.length > 0
      ? devPcts.reduce((a, b) => a + b, 0) / devPcts.length
      : 0;

    // --- Desarrolladores ordenados por efectividad descendente ---
    const sortedDevs = devs
      .map(([name]) => name)
      .sort((a, b) => devStats[b].pct - devStats[a].pct);

    // ================================================================
    // CREAR LIBRO XLSX CON MÚLTIPLES HOJAS
    // ================================================================
    const wb = XLSX.utils.book_new();

    // ----------------------------------------------------------------
    // HOJA 1: RESUMEN
    // ----------------------------------------------------------------
    const resumenData = [
      ['Reporte de Efectividad — CSV Global de Pruebas'],
      [],
      ['Desarrollador', 'Actividades Cumplidas', 'Fórmula Aplicada', 'Efectividad'],
    ];

    for (const name of sortedDevs) {
      const s = devStats[name];
      const cumplidas = `${s.solved}/${s.effectiveTotal}`;
      const pctDecimal = s.effectiveTotal > 0 ? (s.solved / s.effectiveTotal) * 100 : 0;
      resumenData.push([
        name,
        cumplidas,
        '(Actividades Cumplidas / Actividades Planificadas) * 100',
        `${pctDecimal.toFixed(2)}%`,
      ]);
    }

    for (const name of leaders) {
      resumenData.push([
        name,
        'Promedio',
        'Sumatoria efectividad del equipo / Cantidad de desarrolladores',
        `${avgDevPct.toFixed(2)}%`,
      ]);
    }

    for (const name of evaluacion) {
      resumenData.push([
        name,
        'Promedio',
        'Hereda promedio general del equipo de desarrollo',
        `${avgDevPct.toFixed(2)}%`,
      ]);
    }

    const wsResumen = XLSX.utils.aoa_to_sheet(resumenData);
    XLSX.utils.book_append_sheet(wb, wsResumen, 'Resumen');

    // ----------------------------------------------------------------
    // HOJAS POR DESARROLLADOR
    // ----------------------------------------------------------------
    const statusLabels = {
      'Solventado': 'Solventado',
      'En proceso': 'En Proceso',
      'No resuelto': 'No Resuelto',
      'No Aplica': 'No Aplica',
      'Información Adicional': 'Info. Adicional',
    };

    // Solo desarrolladores tienen hoja individual (excluir líder y evaluación)
    const devNames = new Set(devs.map(([n]) => n));
    for (const [name, tickets] of entries) {
      if (!devNames.has(name)) continue;
      const s = devStats[name];
      const pctDecimal = s.effectiveTotal > 0 ? (s.solved / s.effectiveTotal) * 100 : 0;

      const sheetData = [
        [`Programador: ${name}`],
        [`Efectividad: ${pctDecimal.toFixed(2)}%`],
        [`Total Tickets: ${s.total}`],
        [`Solventados: ${s.solved}  |  No Aplica: ${s.noAplica}  |  Info. Adicional: ${s.infoAdicional}  |  En Proceso: ${s.inProgress}  |  No Resueltos: ${s.unsolved}`],
        [],
        ['N° Ticket', 'Descripción', 'Proyecto', 'Tipo', 'Notas', 'Estado'],
        ...tickets.map(t => [t.ticket, t.description, t.project, t.tipo || '', t.notes, statusLabels[t.status] || t.status]),
      ];

      const ws = XLSX.utils.aoa_to_sheet(sheetData);

      ws['!cols'] = [
        { wch: 14 },
        { wch: 40 },
        { wch: 20 },
        { wch: 22 },
        { wch: 30 },
        { wch: 18 },
      ];

      const sheetName = name.length > 31 ? name.substring(0, 31) : name;
      XLSX.utils.book_append_sheet(wb, ws, sheetName);
    }

    // --- Generar y descargar XLSX ---
    const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    const blob = new Blob([wbout], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `reporte_pruebas_${dateStr}.xlsx`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ----------------------------------------------------------------
  // EXCEL INDIVIDUAL (planilla reimportable por programador)
  // ----------------------------------------------------------------

  /**
   * Exporta los tickets de un programador a un Excel con una sola hoja,
   * reutilizando las mismas columnas que acepta la importación para que
   * el archivo sea directamente reimportable.
   * @param {string} programmerName
   * @param {Array} tickets
   */
  function exportExcelIndividual(programmerName, tickets) {
    const { file: dateStr } = formatDate();
    const headers = ['N° Ticket', 'Descripción', 'Proyecto', 'Tipo', 'Notas', 'Estado'];
    const rows = tickets.map(t => [
      t.ticket,
      t.description,
      t.project,
      t.tipo || '',
      t.notes,
      t.status,
    ]);

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
    ws['!cols'] = [{ wch: 12 }, { wch: 40 }, { wch: 20 }, { wch: 18 }, { wch: 30 }, { wch: 20 }];
    const sheetName = (programmerName || 'Programador').slice(0, 31);
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
    XLSX.writeFile(wb, `planilla_${programmerName.replace(/\s+/g, '_')}_${dateStr}.xlsx`);
  }

  // API pública del módulo
  return {
    exportCSVIndividual,
    exportCSVConsolidated,
    exportCSVPruebas,
    exportExcelIndividual,
    exportPDFIndividual,
    exportPDFConsolidated,
  };

})();
