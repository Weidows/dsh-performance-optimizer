/**
 * Host half of the dsh-performance-optimizer bundle.
 *
 * Responsibilities:
 *  1. Own a single process-wide sampler that snapshots Node `process.memoryUsage()`,
 *     `process.cpuUsage()`, and `process.hrtime` every `sampleIntervalMs` ms.
 *  2. Retain a bounded rolling history (default 60 samples).
 *  3. Expose the sampler through Cordis so the bundled Client / Settings tab /
 *     future in-process consumers can read the latest snapshot or the full
 *     history without coupling.
 *  4. Register one native agent-facing tool (`performance_report`) so the model
 *     can request a structured sample in any conversation. This is the agent
 *     interface — every MCP tool call routed through DSH ultimately surfaces
 *     through `ctx.tools.register`, so the canonical agent path is here.
 *
 * Everything is registered inside `apply()` so the Plugin unload / context disposal
 * effects cascade automatically. No process-wide state escapes the effect.
 *
 * Why no MCP server here? DSH's MCP integration has multiple SDK shapes
 * (@modelcontextprotocol/sdk v1 vs v2, node vs server) and binding the bundle
 * to a specific module path would couple it to a DSH version we don't control.
 * The native tool covers every agent path; an MCP server can be added later
 * as a sibling plugin that talks to this one through `ctx.performanceOptimizer`.
 */

const SAMPLER_DEFAULTS = Object.freeze({
  sampleIntervalMs: 1000,
  historySize: 60,
  hudVisible: false,
  settingsTab: true,
});

function withDefaults(config = {}) {
  return { ...SAMPLER_DEFAULTS, ...(config || {}) };
}

function safeNumber(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

/**
 * One Host-side sampler. The sampler is the only writer of `samples` and the
 * snapshot helper is the only reader; no other plugin should reach into it.
 */
function createSampler(config) {
  const { sampleIntervalMs, historySize } = config;
  const samples = [];
  let lastCpu = null;
  let timer = null;
  let started = false;

  function record(now) {
    const mem = process.memoryUsage();
    const cpu = process.cpuUsage();
    let cpuDelta = null;
    let wallDeltaMs = null;
    if (lastCpu) {
      cpuDelta = {
        user: safeNumber((cpu.user - lastCpu.user) / 1e3, 0),
        system: safeNumber((cpu.system - lastCpu.system) / 1e3, 0),
      };
      wallDeltaMs = safeNumber((now - lastCpu.takenAt) / 1e6, 0);
    }
    lastCpu = { user: cpu.user, system: cpu.system, takenAt: now };

    const nowHr = process.hrtime.bigint();

    return {
      t: new Date().toISOString(),
      tHr: nowHr.toString(),
      rss: mem.rss,
      heapTotal: mem.heapTotal,
      heapUsed: mem.heapUsed,
      external: mem.external,
      arrayBuffers: mem.arrayBuffers,
      cpuMs: { user: safeNumber(cpu.user / 1e3, 0), system: safeNumber(cpu.system / 1e3, 0) },
      cpuDeltaMs: cpuDelta,
      wallDeltaMs,
      uptimeMs: safeNumber(process.uptime() * 1000, 0),
    };
  }

  function pushSample() {
    if (!started) return;
    const now = Date.now();
    const sample = record(now);
    samples.push(sample);
    while (samples.length > historySize) samples.shift();
  }

  function start() {
    if (started) return;
    started = true;
    lastCpu = null;
    pushSample();
    timer = setInterval(pushSample, Math.max(100, sampleIntervalMs));
    if (typeof timer.unref === 'function') timer.unref();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    started = false;
  }

  return {
    start,
    stop,
    sample: () => {
      pushSample();
      return samples[samples.length - 1] || null;
    },
    snapshot: () => samples[samples.length - 1] || null,
    history: () => samples.slice(),
    reset: () => {
      samples.length = 0;
      lastCpu = null;
      pushSample();
    },
    config: { sampleIntervalMs, historySize },
  };
}

/**
 * Build a one-row, JSON-shaped report from the sampler. The shape is intentionally
 * stable so the Settings tab, future MCP server siblings, and the agent tool
 * all consume the same structure.
 */
function buildReport(sampler) {
  const snap = sampler.snapshot();
  const history = sampler.history();
  const recent = history.slice(-10);
  return {
    intervalMs: sampler.config.sampleIntervalMs,
    sampleCount: history.length,
    latest: snap,
    history: recent,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * The Host half. The Settings tab reads through `ctx.performanceOptimizer`;
 * the agent tool calls `buildReport()` directly. The MCP server is a
 * deliberately out-of-scope concern — see the file header.
 */
export const inject = ['tools', 'pluginContext'];

export function apply(ctx, rawConfig) {
  const config = withDefaults(rawConfig);

  const sampler = createSampler(config);
  ctx.effect(() => {
    sampler.start();
    return () => sampler.stop();
  });

  // Public service surface — read-only views plus reset. Anything else
  // (Settings tab, MCP sibling, agent tool) reads through this.
  ctx.performanceOptimizer = {
    snapshot: () => sampler.snapshot(),
    history: () => sampler.history(),
    config: () => sampler.config,
    sample: () => sampler.sample(),
    reset: () => sampler.reset(),
    buildReport: () => buildReport(sampler),
  };

  // Agent-facing tool — native registration. This is the canonical agent
  // interface regardless of whether any MCP client is mounted elsewhere.
  const tools = ctx.tools;
  if (tools && typeof tools.register === 'function') {
    const dispose = tools.register({
      name: 'performance_report',
      title: 'Performance Optimizer — host report',
      description:
        'Return a fresh performance snapshot from the running Host: rss, heap, cpu (user/system), sample count, last-10 history. Use when investigating scroll lag, memory drift, or tool-loop storms.',
      schema: { type: 'object', properties: {}, additionalProperties: false },
      async execute() {
        return { kind: 'json', value: buildReport(sampler) };
      },
    });
    ctx.effect(() => () => dispose && dispose());
  }
}
