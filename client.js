/**
 * Client half of the dsh-performance-optimizer bundle.
 *
 * Two artefacts:
 *
 *  1. A custom element `<perf-settings-tab>` registered as the per-plugin tab
 *     on the Settings → Plugins → per-plugin details page. Hosts a live
 *     table + a Chart.js sparkline that updates from the Host sampler.
 *     This is the canonical UX — no chat/sidebar/conductor surface.
 *
 *  2. A floating HUD (`<perf-hud>`) anchored to the document body. Visible
 *     only when `config.hudVisible` is true. Click-through toggle.
 *
 * Failure modes:
 *   - If the Host is unreachable, the tab renders an empty state with a retry
 *     button; the HUD shows "—" placeholders. Never blocks the rest of the UI.
 */

import enLocale from './locale/en.json' with { type: 'json' };
import zhLocale from './locale/zh.json' with { type: 'json' };

const LOCALE_TABLE = {
  en: enLocale,
  zh: zhLocale,
  'zh-CN': zhLocale,
  'zh-cn': zhLocale,
};
let activeLocale = enLocale;

function resolveLocale() {
  if (typeof navigator !== 'undefined') {
    const lang = (navigator.language || 'en').toLowerCase();
    if (LOCALE_TABLE[lang]) activeLocale = LOCALE_TABLE[lang];
    else if (lang.startsWith('zh') && LOCALE_TABLE.zh) activeLocale = LOCALE_TABLE.zh;
  }
  return activeLocale;
}

function getHost() {
  if (typeof window === 'undefined') return null;
  const candidates = [
    () => window.__DSH_HOST__,
    () => window.__DSH__,
    () => window.deepseek?.host,
  ];
  for (const fn of candidates) {
    try {
      const cand = fn();
      if (cand) return cand;
    } catch {}
  }
  return null;
}

async function callHost(method, payload) {
  const host = getHost();
  if (!host || typeof host.call !== 'function') return null;
  try {
    return await host.call(method, payload);
  } catch {
    return null;
  }
}

async function fetchSnapshot() {
  return await callHost('plugin:performance-optimizer.snapshot', null);
}
async function fetchHistory() {
  return await callHost('plugin:performance-optimizer.history', null);
}
async function fetchConfig() {
  return await callHost('plugin:performance-optimizer.config', null);
}
async function requestReset() {
  return await callHost('plugin:performance-optimizer.reset', null);
}
async function requestSample() {
  return await callHost('plugin:performance-optimizer.sample', null);
}

/**
 * Standalone minimal chart-drawing helpers. We deliberately do not depend on
 * Chart.js — the DSH Web bundle does not bundle it and pulling a CDN at runtime
 * would conflict with CSP. Two functions: a bar chart (per-second CPU/RSS) and
 * a line chart (cumulative samples).
 *
 * Returns { draw(canvas, samples, kind) }.
 */
function createChart() {
  function clear(ctx, w, h) {
    ctx.clearRect(0, 0, w, h);
  }
  function axes(ctx, w, h, padding) {
    ctx.strokeStyle = 'rgba(120,120,140,0.25)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padding, padding);
    ctx.lineTo(padding, h - padding);
    ctx.lineTo(w - padding, h - padding);
    ctx.stroke();
  }
  function draw(canvas, samples, kind = 'cpu') {
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth * dpr;
    const h = canvas.clientHeight * dpr;
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    clear(ctx, w, h);
    axes(ctx, w, h, 12 * dpr);
    if (!samples || samples.length === 0) {
      ctx.fillStyle = 'rgba(120,120,140,0.6)';
      ctx.font = `${12 * dpr}px ui-monospace, SFMono-Regular, Menlo, monospace`;
      ctx.fillText('no samples yet', 16 * dpr, h / 2);
      return;
    }
    const pad = 12 * dpr;
    const innerW = w - pad * 2;
    const innerH = h - pad * 2;
    let values, max, label;
    if (kind === 'cpu') {
      values = samples.map((s) =>
        s.cpuDeltaMs ? s.cpuDeltaMs.user + s.cpuDeltaMs.system : 0,
      );
      max = Math.max(20, ...values);
      label = 'cpu ms / sample';
    } else if (kind === 'rss') {
      values = samples.map((s) => s.rss / 1024 / 1024);
      max = Math.max(...values) * 1.1;
      label = 'rss MB';
    } else if (kind === 'heap') {
      values = samples.map((s) => s.heapUsed / 1024 / 1024);
      max = Math.max(...values) * 1.1;
      label = 'heap MB';
    } else {
      values = samples.map((s) => s.wallDeltaMs || 0);
      max = Math.max(50, ...values);
      label = 'wall ms';
    }
    ctx.fillStyle = 'rgba(120,120,140,0.7)';
    ctx.font = `${11 * dpr}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    ctx.fillText(label, pad, pad + 12 * dpr);
    ctx.fillText(`max=${max.toFixed(1)}`, pad, h - pad / 2);
    // Line
    ctx.strokeStyle = 'rgba(59,130,246,0.9)';
    ctx.lineWidth = 2 * dpr;
    ctx.beginPath();
    for (let i = 0; i < values.length; i++) {
      const x = pad + (i / Math.max(1, values.length - 1)) * innerW;
      const y = pad + (1 - values[i] / max) * innerH;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    // Fill under
    ctx.fillStyle = 'rgba(59,130,246,0.08)';
    ctx.lineTo(pad + innerW, h - pad);
    ctx.lineTo(pad, h - pad);
    ctx.closePath();
    ctx.fill();
  }
  return { draw };
}

const chart = createChart();

/**
 * `<perf-settings-tab>` — the body of the Settings → Plugins → detail page.
 * Updates every second; uses requestAnimationFrame to draw the chart only when
 * the tab is visible (IntersectionObserver).
 */
class PerfSettingsTab extends HTMLElement {
  constructor() {
    super();
    this._latest = { snap: null, history: [] };
    this._timer = null;
    this._activeChart = 'cpu';
  }
  connectedCallback() {
    this.render();
    this._timer = window.setInterval(() => this.refresh(), 1000);
    this.addEventListener('click', (e) => {
      const a = e.target?.dataset?.action;
      const c = e.target?.dataset?.chart;
      if (a === 'refresh') this.refresh(true);
      else if (a === 'reset') this.reset();
      else if (a === 'copy') this.copy();
      else if (a === 'sample') this.sampleNow();
      else if (c) {
        this._activeChart = c;
        this.drawChart();
      }
    });
    this._observer = new IntersectionObserver((entries) => {
      for (const en of entries) {
        if (en.isIntersecting) this.drawChart();
      }
    });
    this._observer.observe(this);
  }
  disconnectedCallback() {
    if (this._timer) clearInterval(this._timer);
    if (this._observer) this._observer.disconnect();
  }

  async refresh(force = false) {
    if (force) await requestSample();
    const snap = await fetchSnapshot();
    const history = await fetchHistory();
    this._latest = { snap, history };
    this.render();
    this.drawChart();
  }
  async sampleNow() {
    await requestSample();
    await this.refresh(true);
  }
  async reset() {
    await requestReset();
    await this.refresh(true);
  }
  async copy() {
    const text = JSON.stringify(this._latest ?? {}, null, 2);
    try { await navigator.clipboard.writeText(text); } catch {}
  }

  drawChart() {
    const canvas = this.querySelector('canvas[data-chart]');
    if (!canvas) return;
    const history = this._latest.history || [];
    chart.draw(canvas, history, this._activeChart);
  }

  render() {
    const L = resolveLocale();
    const data = this._latest || {};
    const snap = data.snap || {};
    const mb = (b) => (b != null ? (b / 1024 / 1024).toFixed(1) : '—');
    const cpu = snap.cpuMs
      ? `${snap.cpuMs.user.toFixed(0)}u / ${snap.cpuMs.system.toFixed(0)}s`
      : '—';
    const samples = data.history || [];
    const last = samples[samples.length - 1];

    const html = `
      <section class="po-tab">
        <header class="po-tab__header">
          <div class="po-tab__title">
            <strong>${L.title}</strong>
            <span class="po-tab__sub">${L.meta.description}</span>
          </div>
          <div class="po-tab__actions">
            <button data-action="sample" type="button">${L.actions.refreshNow}</button>
            <button data-action="reset" type="button">${L.actions.resetHistory}</button>
            <button data-action="copy" type="button">${L.actions.copyReport}</button>
          </div>
        </header>

        <section class="po-tab__metrics">
          <div class="po-metric"><label>${L.metrics.rssMB}</label><value>${mb(snap.rss)} MB</value></div>
          <div class="po-metric"><label>${L.metrics.heapMB}</label><value>${mb(snap.heapUsed)} / ${mb(snap.heapTotal)} MB</value></div>
          <div class="po-metric"><label>${L.metrics.cpuUserMs} / ${L.metrics.cpuSystemMs}</label><value>${cpu}</value></div>
          <div class="po-metric"><label>${L.metrics.intervalMs}</label><value>${snap.t ? new Date(snap.t).toLocaleTimeString() : '—'}</value></div>
        </section>

        <section class="po-tab__chartwrap">
          <nav class="po-tab__tabs">
            <button data-chart="cpu" class="${this._activeChart === 'cpu' ? 'active' : ''}">CPU</button>
            <button data-chart="rss" class="${this._activeChart === 'rss' ? 'active' : ''}">RSS</button>
            <button data-chart="heap" class="${this._activeChart === 'heap' ? 'active' : ''}">Heap</button>
            <button data-chart="wall" class="${this._activeChart === 'wall' ? 'active' : ''}">Wall</button>
          </nav>
          <canvas data-chart style="width:100%;height:240px;display:block;"></canvas>
          <p class="po-tab__last">last sample: ${last ? new Date(last.t).toLocaleString() : '—'}</p>
        </section>

        <footer class="po-tab__tip">${L.actions.openProfilerTip}</footer>
      </section>
    `;
    this.innerHTML = html;
    if (!document.head.querySelector('style[data-po]')) {
      const style = document.createElement('style');
      style.setAttribute('data-po', 'true');
      style.textContent = `
        perf-settings-tab { display:block; }
        .po-tab { padding: 12px 16px 24px; }
        .po-tab__header { display:flex; gap:12px; align-items:flex-start; justify-content:space-between; margin-bottom:14px; }
        .po-tab__title { display:flex; flex-direction:column; gap:2px; max-width: 60%; }
        .po-tab__sub { font-size:11px; opacity:0.6; }
        .po-tab__actions button { margin-left:6px; }
        .po-tab__metrics { display:grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap:8px; margin: 8px 0 14px; }
        .po-metric { background: rgba(120,120,140,0.06); border-radius: 8px; padding: 8px 10px; }
        .po-metric label { display:block; font-size:10.5px; opacity:0.6; text-transform:uppercase; letter-spacing:0.04em; }
        .po-metric value { display:block; font: 600 13px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; margin-top:4px; }
        .po-tab__chartwrap { background: rgba(120,120,140,0.04); border-radius: 10px; padding: 12px; }
        .po-tab__tabs { display:flex; gap:4px; margin-bottom:10px; }
        .po-tab__tabs button { background:transparent; border:1px solid rgba(120,120,140,0.2); padding:3px 10px; border-radius:6px; cursor:pointer; font-size:11px; }
        .po-tab__tabs button.active { background:rgba(59,130,246,0.15); border-color:rgba(59,130,246,0.6); }
        .po-tab__last { font-size:10.5px; opacity:0.6; margin-top:6px; }
        .po-tab__tip { font-size:11px; opacity:0.65; margin-top:14px; }
      `;
      document.head.appendChild(style);
    }
  }
}
if (typeof customElements !== 'undefined' && !customElements.get('perf-settings-tab')) {
  customElements.define('perf-settings-tab', PerfSettingsTab);
}

/**
 * HUD — anchored to body. Hidden by default; user can toggle.
 */
class PerfHud extends HTMLElement {
  connectedCallback() {
    this.style.cssText = `
      position:fixed; right:16px; bottom:16px; z-index:2147483646;
      background:rgba(15,15,17,0.85); color:#fff;
      border-radius:10px; padding:10px 12px;
      font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;
      box-shadow:0 6px 24px rgba(0,0,0,0.25); cursor:pointer;
      min-width:200px; transition:opacity 120ms ease;
    `;
    this.addEventListener('click', () => {
      this.style.opacity = this.style.opacity === '0' ? '1' : '0';
    });
    this._timer = window.setInterval(() => this.tick(), 1500);
    this.tick();
  }
  disconnectedCallback() {
    if (this._timer) clearInterval(this._timer);
  }
  async tick() {
    const snap = await fetchSnapshot();
    const mb = (b) => (b != null ? `${(b / 1024 / 1024).toFixed(0)}MB` : '—');
    const cpu = snap?.cpuMs ? `${snap.cpuMs.user.toFixed(0)}/${snap.cpuMs.system.toFixed(0)}` : '—';
    this.innerHTML = `
      <div>rss <strong>${mb(snap?.rss)}</strong> heap <strong>${mb(snap?.heapUsed)}</strong></div>
      <div>cpu <strong>${cpu}</strong></div>
    `;
  }
}
if (typeof customElements !== 'undefined' && !customElements.get('perf-hud')) {
  customElements.define('perf-hud', PerfHud);
}

/**
 * Default mount entry. The package.json `dsh.client.inject` lists
 *   `@deepseek-ai/dsh-client-ui-settings-plugins`
 *   `@deepseek-ai/dsh-client-ui-conversation`
 *   `@deepseek-ai/dsh-client-shell`
 * so DSH calls `mount(shared)` once per inject target. Each call gets a context
 * that describes which slot the bundle is being mounted into; we route by key.
 */
export async function mount(shared, ctx) {
  const cfg = (await fetchConfig()) || {};
  const slot = ctx?.slot || shared?.slot || 'settings-plugins';

  if (slot === 'settings-plugins') {
    // Wait for the settings plugins detail panel to render and inject our tab.
    await waitFor('[data-plugin-tab-list], .dsh-plugin-detail, [data-plugin-detail-tabs]', 5000);
    const tabList = document.querySelector('[data-plugin-tab-list]');
    if (tabList) {
      const li = document.createElement('li');
      li.dataset.tab = 'performance-optimizer';
      li.textContent = resolveLocale().panelTitle;
      tabList.appendChild(li);
    }
    const root = document.querySelector('[data-plugin-detail-body], .dsh-plugin-detail__body, main');
    if (root) {
      const tab = document.createElement('perf-settings-tab');
      tab.dataset.pluginTab = 'performance-optimizer';
      root.appendChild(tab);
      tab.refresh(true);
    }
    return () => {
      document.querySelector('[data-tab="performance-optimizer"]')?.remove();
      document.querySelector('perf-settings-tab')?.remove();
    };
  }

  if (slot === 'shell') {
    if (cfg.hudVisible) {
      const hud = document.createElement('perf-hud');
      document.body.appendChild(hud);
      return () => hud.remove();
    }
    return () => {};
  }

  // Conversation slot — reserved for a future chip; currently no-op so the
  // bundle doesn't claim the slot for nothing.
  return () => {};
}

function waitFor(selector, timeoutMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    function check() {
      const el = document.querySelector(selector);
      if (el) return resolve(el);
      if (Date.now() - start > timeoutMs) return resolve(null);
      requestAnimationFrame(check);
    }
    check();
  });
}

export default { mount };
