/**
 * dashboard.js — Módulo del Dashboard y Gráficas
 * ================================================
 * Responsable de:
 *   - Calcular métricas de efectividad de cada programador
 *   - Renderizar los KPI cards globales
 *   - Crear y actualizar las gráficas con Chart.js
 *   - Renderizar la tabla de ranking
 *   - Actualizar la barra lateral con los programadores
 */

const Dashboard = (() => {

  // Referencias a instancias de Chart.js para poder destruirlas antes de recrear
  let barChartInstance = null;
  let doughnutChartInstance = null;

  // ----------------------------------------------------------------
  // HELPERS
  // ----------------------------------------------------------------

  /**
   * Calcula todas las métricas de efectividad para un array de tickets.
   * @param {Array} tickets
   * @returns {{ total: number, solved: number, noAplica: number, inProgress: number, unsolved: number, pct: number }}
   */
  function calcStats(tickets) {
    const total = tickets.length;
    const solved = tickets.filter(t => t.status === 'Solventado').length;
    const noAplica = tickets.filter(t => t.status === 'No Aplica').length;
    const inProgress = tickets.filter(t => t.status === 'En proceso').length;
    const unsolved = tickets.filter(t => t.status === 'No resuelto').length;
    const pct = total > 0 ? Math.round(((solved + noAplica) / total) * 100) : 0;
    return { total, solved, noAplica, inProgress, unsolved, pct };
  }

  /**
   * Retorna clases CSS y colores según el porcentaje de efectividad.
   * @param {number} pct
   * @returns {{ cssClass: string, colorRgb: string, fillClass: string }}
   */
  function effectivenessTheme(pct) {
    if (pct >= 75) return { cssClass: 'eff--high', colorRgb: '16,185,129',   fillClass: 'fill--high' };
    if (pct >= 40) return { cssClass: 'eff--mid',  colorRgb: '245,158,11',   fillClass: 'fill--mid' };
    return             { cssClass: 'eff--low',  colorRgb: '239,68,68',    fillClass: 'fill--low' };
  }

  /**
   * Genera un color suave y único por índice para las gráficas.
   * @param {number} i - Índice del programador
   * @param {number} total - Total de programadores
   * @param {number} alpha - Opacidad (0-1)
   * @returns {string} rgba string
   */
  function chartColor(i, total, alpha = 0.8) {
    const hue = Math.round((i / total) * 360);
    return `hsla(${hue}, 70%, 65%, ${alpha})`;
  }

  // ----------------------------------------------------------------
  // KPI CARDS
  // ----------------------------------------------------------------

  /**
   * Renderiza los KPI cards en el dashboard principal.
   * @param {Object} programmers - { [nombre]: [tickets] }
   */
  function renderKPICards(programmers) {
    const container = document.getElementById('kpi-grid');
    if (!container) return;

    const allTickets = Object.values(programmers).flat();
    const globalStats = calcStats(allTickets);
    const numProgrammers = Object.keys(programmers).length;

    // Encontrar el programador con mayor efectividad
    const ranking = Object.entries(programmers)
      .map(([name, tickets]) => ({ name, ...calcStats(tickets) }))
      .sort((a, b) => b.pct - a.pct);

    const topDev = ranking[0] || null;
    const theme = effectivenessTheme(globalStats.pct);

    const kpis = [
      {
        label: 'Efectividad Global',
        value: `${globalStats.pct}%`,
        icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                 <path d="M22 12h-4l-3 9L9 3l-3 9H2"/>
               </svg>`,
        iconBg: 'rgba(99,102,241,.15)',
        iconColor: '#6366f1',
        accent: `rgb(${theme.colorRgb})`,
        delay: '0s',
      },
      {
        label: 'Total de Tickets',
        value: allTickets.length,
        icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                 <rect x="3" y="3" width="18" height="18" rx="3"/>
                 <path d="M8 12h8M8 8h8M8 16h5"/>
               </svg>`,
        iconBg: 'rgba(168,85,247,.15)',
        iconColor: '#a855f7',
        accent: '#a855f7',
        delay: '.05s',
      },
      {
        label: 'Solventados',
        value: globalStats.solved,
        icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                 <path d="M20 6L9 17l-5-5"/>
               </svg>`,
        iconBg: 'rgba(16,185,129,.15)',
        iconColor: '#10b981',
        accent: '#10b981',
        delay: '.1s',
      },
      {
        label: 'No Aplica',
        value: globalStats.noAplica,
        icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                 <circle cx="12" cy="12" r="9"/><path d="M8 12h8"/>
               </svg>`,
        iconBg: 'rgba(168,85,247,.15)',
        iconColor: '#a855f7',
        accent: '#a855f7',
        delay: '.13s',
      },
      {
        label: 'En Proceso',
        value: globalStats.inProgress,
        icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                 <circle cx="12" cy="12" r="9"/>
                 <path d="M12 7v5l3 3"/>
               </svg>`,
        iconBg: 'rgba(245,158,11,.15)',
        iconColor: '#f59e0b',
        accent: '#f59e0b',
        delay: '.15s',
      },
      {
        label: 'No Resueltos',
        value: globalStats.unsolved,
        icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                 <circle cx="12" cy="12" r="9"/>
                 <path d="M12 8v4M12 16h.01"/>
               </svg>`,
        iconBg: 'rgba(239,68,68,.12)',
        iconColor: '#ef4444',
        accent: '#ef4444',
        delay: '.2s',
      },
      {
        label: 'Programadores',
        value: numProgrammers,
        icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                 <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/>
                 <circle cx="9" cy="7" r="4"/>
                 <path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/>
               </svg>`,
        iconBg: 'rgba(34,211,238,.12)',
        iconColor: '#22d3ee',
        accent: '#22d3ee',
        delay: '.25s',
      },
    ];

    container.innerHTML = kpis.map(k => `
      <div class="kpi-card" style="animation-delay:${k.delay}">
        <div class="kpi-card__icon" style="background:${k.iconBg}; color:${k.iconColor}">
          ${k.icon}
        </div>
        <div class="kpi-card__value" style="color:${k.accent}">${k.value}</div>
        <div class="kpi-card__label">${k.label}</div>
      </div>
    `).join('');
  }

  // ----------------------------------------------------------------
  // GRÁFICAS CHART.JS
  // ----------------------------------------------------------------

  /**
   * Renderiza la gráfica de barras de efectividad por programador.
   * @param {Object} programmers
   */
  function renderBarChart(programmers) {
    const canvas = document.getElementById('chart-bar');
    if (!canvas) return;

    // Destruir instancia previa si existe
    if (barChartInstance) {
      barChartInstance.destroy();
      barChartInstance = null;
    }

    const names = Object.keys(programmers);
    const stats = names.map(name => calcStats(programmers[name]));
    const total = names.length;

    const bgColors     = names.map((_, i) => chartColor(i, total, 0.75));
    const borderColors = names.map((_, i) => chartColor(i, total, 1.0));

    const ctx = canvas.getContext('2d');
    barChartInstance = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: names,
        datasets: [
          {
            label: 'Efectividad (%)',
            data: stats.map(s => s.pct),
            backgroundColor: bgColors,
            borderColor: borderColors,
            borderWidth: 2,
            borderRadius: 8,
            borderSkipped: false,
          },
          {
            label: 'Solventados',
            data: stats.map(s => s.solved),
            backgroundColor: 'rgba(16,185,129,.3)',
            borderColor: 'rgba(16,185,129,.8)',
            borderWidth: 1.5,
            borderRadius: 6,
            borderSkipped: false,
            hidden: true, // Opcional, activar desde la leyenda
          },
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            display: true,
            labels: {
              color: '#8892a4',
              font: { family: 'Inter', size: 11 },
              boxWidth: 12,
              padding: 16,
            }
          },
          tooltip: {
            backgroundColor: '#1c2035',
            borderColor: '#252a3d',
            borderWidth: 1,
            titleColor: '#f1f5f9',
            bodyColor: '#8892a4',
            callbacks: {
              afterLabel: (ctx) => {
                const i = ctx.dataIndex;
                const s = stats[i];
                return [
                  `Total: ${s.total} tickets`,
                  `Solventados: ${s.solved}`,
                  `En proceso: ${s.inProgress}`,
                  `No resueltos: ${s.unsolved}`,
                ];
              }
            }
          },
        },
        scales: {
          x: {
            grid: { color: 'rgba(37,42,61,.5)', lineWidth: 1 },
            ticks: { color: '#8892a4', font: { family: 'Inter', size: 11 } },
          },
          y: {
            grid: { color: 'rgba(37,42,61,.5)', lineWidth: 1 },
            ticks: {
              color: '#8892a4',
              font: { family: 'Inter', size: 11 },
              callback: v => `${v}%`,
            },
            min: 0,
            max: 100,
          },
        },
        animation: {
          duration: 800,
          easing: 'easeInOutQuart',
        },
      }
    });
  }

  /**
   * Renderiza la gráfica doughnut de efectividad global.
   * @param {Object} programmers
   */
  function renderDoughnutChart(programmers) {
    const canvas = document.getElementById('chart-doughnut');
    if (!canvas) return;

    if (doughnutChartInstance) {
      doughnutChartInstance.destroy();
      doughnutChartInstance = null;
    }

    const allTickets = Object.values(programmers).flat();
    const stats = calcStats(allTickets);

    const ctx = canvas.getContext('2d');
    doughnutChartInstance = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: ['Solventados', 'No Aplica', 'En Proceso', 'No Resueltos'],
        datasets: [{
          data: [stats.solved, stats.noAplica, stats.inProgress, stats.unsolved],
          backgroundColor: [
            'rgba(16,185,129,.8)',
            'rgba(168,85,247,.8)',
            'rgba(245,158,11,.8)',
            'rgba(239,68,68,.75)',
          ],
          borderColor: [
            'rgb(16,185,129)',
            'rgb(168,85,247)',
            'rgb(245,158,11)',
            'rgb(239,68,68)',
          ],
          borderWidth: 2,
          hoverOffset: 8,
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '68%',
        plugins: {
          legend: {
            position: 'bottom',
            labels: {
              color: '#8892a4',
              font: { family: 'Inter', size: 10 },
              boxWidth: 10,
              padding: 10,
            }
          },
          tooltip: {
            backgroundColor: '#1c2035',
            borderColor: '#252a3d',
            borderWidth: 1,
            titleColor: '#f1f5f9',
            bodyColor: '#8892a4',
            callbacks: {
              label: (ctx) => ` ${ctx.label}: ${ctx.parsed} tickets`
            }
          }
        },
        animation: { duration: 900, easing: 'easeInOutQuart' },
      }
    });

    // Actualizar label central
    const label = document.getElementById('doughnut-label');
    if (label) {
      const theme = effectivenessTheme(stats.pct);
      label.innerHTML = `Efectividad global: <strong class="${theme.cssClass}">${stats.pct}%</strong>`;
    }
  }

  // ----------------------------------------------------------------
  // TABLA DE RANKING
  // ----------------------------------------------------------------

  /**
   * Renderiza la tabla de ranking en el dashboard.
   * @param {Object} programmers
   * @param {Function} onViewProgrammer - Callback al hacer click en "Ver detalle"
   */
  function renderRankingTable(programmers, onViewProgrammer) {
    const tbody = document.getElementById('ranking-tbody');
    if (!tbody) return;

    const ranking = Object.entries(programmers)
      .map(([name, tickets]) => ({ name, ...calcStats(tickets) }))
      .sort((a, b) => b.pct - a.pct);

    if (ranking.length === 0) {
      tbody.innerHTML = `<tr><td colspan="9">
        <div class="empty-state">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/>
          </svg>
          <p>No hay datos disponibles</p>
        </div>
      </td></tr>`;
      return;
    }

    tbody.innerHTML = ranking.map((r, i) => {
      const rank = i + 1;
      const theme = effectivenessTheme(r.pct);
      const rankClass = rank <= 3 ? `rank-badge--${rank}` : 'rank-badge--n';

      return `
        <tr>
          <td><span class="rank-badge ${rankClass}">${rank}</span></td>
          <td>
            <div style="display:flex;align-items:center;gap:10px">
              <div style="
                width:32px;height:32px;border-radius:8px;
                background:linear-gradient(135deg,hsl(${(rank*47)%360},60%,55%),hsl(${(rank*47+60)%360},70%,60%));
                display:flex;align-items:center;justify-content:center;
                font-size:13px;font-weight:700;color:white;flex-shrink:0;">
                ${r.name.charAt(0).toUpperCase()}
              </div>
              <span style="font-weight:500">${r.name}</span>
            </div>
          </td>
          <td style="font-weight:600">${r.total}</td>
          <td style="color:#10b981;font-weight:600">${r.solved}</td>
          <td style="color:#a855f7;font-weight:600">${r.noAplica}</td>
          <td style="color:#f59e0b;font-weight:600">${r.inProgress}</td>
          <td style="color:#ef4444;font-weight:600">${r.unsolved}</td>
          <td>
            <div class="progress-bar">
              <div class="progress-bar__track">
                <div class="progress-bar__fill ${theme.fillClass}" style="width:${r.pct}%"></div>
              </div>
              <span class="progress-bar__label ${theme.cssClass}">${r.pct}%</span>
            </div>
          </td>
          <td>
            <button
              class="btn btn--ghost btn--sm"
              onclick="App.navigateToProgrammer('${r.name.replace(/'/g, "\\'")}')"
              aria-label="Ver detalle de ${r.name}">
              Ver detalle →
            </button>
          </td>
        </tr>
      `;
    }).join('');
  }

  // ----------------------------------------------------------------
  // SIDEBAR — Programadores
  // ----------------------------------------------------------------

  /**
   * Renderiza la lista de programadores en la barra lateral.
   * @param {Object} programmers
   * @param {Function} onNavigate - Callback al hacer click en un programador
   */
  function renderSidebarProgrammers(programmers, onNavigate) {
    const container = document.getElementById('nav-programmers');
    if (!container) return;

    const ranking = Object.entries(programmers)
      .map(([name, tickets]) => ({ name, ...calcStats(tickets) }))
      .sort((a, b) => b.pct - a.pct);

    container.innerHTML = ranking.map(r => {
      const theme = effectivenessTheme(r.pct);
      return `
        <button class="nav-item" data-programmer="${r.name}" onclick="App.navigateToProgrammer('${r.name.replace(/'/g, "\\'")}')">
          <div style="
            width:20px;height:20px;border-radius:5px;
            background:linear-gradient(135deg,#6366f1,#a855f7);
            display:flex;align-items:center;justify-content:center;
            font-size:10px;font-weight:700;color:white;flex-shrink:0;">
            ${r.name.charAt(0).toUpperCase()}
          </div>
          <span style="flex:1;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
            ${r.name}
          </span>
          <span class="effectiveness-badge ${theme.cssClass}" style="background:rgba(${theme.colorRgb.split(',').join(',')},0.15)">
            ${r.pct}%
          </span>
        </button>
      `;
    }).join('');
  }

  /**
   * Función principal: renderiza todo el dashboard.
   * @param {Object} programmers
   * @param {Function} onViewProgrammer - Callback para navegar a la vista individual
   */
  function render(programmers, onViewProgrammer) {
    renderKPICards(programmers);
    renderBarChart(programmers);
    renderDoughnutChart(programmers);
    renderRankingTable(programmers, onViewProgrammer);
    renderSidebarProgrammers(programmers, onViewProgrammer);
  }

  /**
   * Retorna la instancia del gráfico de barras (para exportar al PDF).
   * @returns {HTMLCanvasElement|null}
   */
  function getBarChartCanvas() {
    return document.getElementById('chart-bar');
  }

  // Exportar stats para uso externo
  return {
    render,
    calcStats,
    effectivenessTheme,
    renderSidebarProgrammers,
    renderRankingTable,
    getBarChartCanvas,
  };

})();
