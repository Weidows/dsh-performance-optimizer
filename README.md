# dsh-performance-optimizer

DSH bundle that exposes **host-wide and per-event-loop performance metrics** so the user (via a Settings tab) and the agent (via a native tool and a stdio MCP server) can reason about scroll lag, memory drift, and tool loops.

The bundle is intentionally minimal — it samples Node `process.memoryUsage()` / `process.cpuUsage()` once per second, keeps a 60-sample rolling buffer, and exposes it through three surfaces:

| surface                | consumer                  | mechanism                                                                                |
| ---------------------- | ------------------------- | ---------------------------------------------------------------------------------------- |
| Settings → Plugins tab | user                      | `client.js` mounts `<perf-settings-tab>` into the per-plugin detail page; live table + Canvas2D chart with CPU / RSS / Heap / Wall tabs. |
| Floating HUD           | user (opt-in)             | `client.js` mounts `<perf-hud>` into the document body when `hudVisible: true`.        |
| Native tool            | agent (in-session)        | `ctx.tools.register('performance_report')` returns a fresh JSON report on demand.       |

## Files

| file                | role                                                                                                                                |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `index.js`          | Host half. Owns the sampler, the `performanceOptimizer` Cordis service, and the `performance_report` tool. |
| `client.js`         | Web GUI half. Two custom elements (`<perf-settings-tab>`, `<perf-hud>`); routes by `ctx.slot`. Calls back into the Host via the runtime bridge. |
| `cordis.patch.yml`  | Loader patch: one insert — the bundle itself.                                                                                |
| `locale/en.json`    | English copy.                                                                                                                       |
| `locale/zh.json`    | 简体/中文 copy.                                                                                                                     |
| `icon.svg`          | Bundle icon.                                                                                                                        |

## Install

```bash
# from a clone
npx @deepseek-ai/dsh plugin --profile web add /absolute/path/to/dsh-performance-optimizer

# from a tarball
npx @deepseek-ai/dsh plugin --profile web add ./dsh-performance-optimizer-0.1.0.tgz

# from npm (once published)
npx @deepseek-ai/dsh plugin --profile web add @local/dsh-performance-optimizer
```

Restart the Web profile and open <http://127.0.0.1:3080/settings/plugins>.

```bash
npx @deepseek-ai/dsh web
```

To remove:

```bash
npx @deepseek-ai/dsh plugin --profile web remove @local/dsh-performance-optimizer
```

## What it measures

| sample field | source                                                | what it answers                                                                |
| ------------ | ----------------------------------------------------- | ------------------------------------------------------------------------------- |
| `t` / `tHr`  | `Date.now()` + `process.hrtime.bigint()`              | When was this sample taken (clock / monotonic, never trust the wall for ordering). |
| `rss`        | `process.memoryUsage().rss`                           | Has the Host process grown? Did `release`/manual GC help?                       |
| `heapUsed`   | `process.memoryUsage().heapUsed`                      | V8 heap pressure (RSS includes native).                                          |
| `heapTotal`  | `process.memoryUsage().heapTotal`                     | Did V8 grow the heap (hint of churn).                                            |
| `external`   | `process.memoryUsage().external`                      | Native buffers / modules.                                                       |
| `cpuMs`      | `process.cpuUsage()`                                  | Cumulative user/system CPU time (ms).                                           |
| `cpuDeltaMs` | delta against previous sample                         | CPU burn between two ticks; correlates with sampler tick & loop work.            |
| `wallDeltaMs`| `now - lastCpu.takenAt`                               | Sampler timer drift — catches stalled timers caused by event-loop saturation.   |
| `uptimeMs`   | `process.uptime() * 1000`                             | Host uptime.                                                                    |

History is the last `historySize` samples (default 60). Sampling interval is `sampleIntervalMs` (default 1000 ms). When MCP is enabled, the most recent report is also written to a JSON file under the bundle's plugin directory every tick so the stdio MCP server can read it without holding a reference into the Host process.

## How it talks to DSH

The Host half uses only Cordis accessors declared in `inject`:

- `tools` — registers `performance_report`. Every MCP tool call routed through DSH eventually surfaces through `tools.register`, so this is the canonical agent interface regardless of whether `@deepseek-ai/dsh-mcp-client` is also mounted.
- `pluginContext` — composition helper; lets the patch layer attach additional reads.

The Client half is mounted once per `dsh.client.inject` target. The `package.json` lists three:

- `@deepseek-ai/dsh-client-ui-settings-plugins` — registers the per-plugin detail tab. This is the canonical user surface.
- `@deepseek-ai/dsh-client-shell` — registers the HUD.
- `@deepseek-ai/dsh-client-ui-conversation` — reserved for a future chip; currently no-op.

It looks up the runtime bridge via `window.__DSH_HOST__` / `window.__DSH__` / `window.deepseek.host` (whichever is present) and calls `plugin:performance-optimizer.snapshot | .history | .config | .sample | .reset`. If the bridge is missing, the tab renders an empty state and the HUD shows `—` — neither blocks the rest of the UI.

## Tool surface (native)

```json
{
  "name": "performance_report",
  "arguments": {},
  "result": {
    "kind": "json",
    "value": {
      "intervalMs": 1000,
      "sampleCount": 42,
      "latest": { "t": "2026-10-20T11:39:42.000Z", "rss": 314572800, "heapUsed": 134217728, "cpuMs": { "user": 1234.5, "system": 67.8 }, "...": "..." },
      "history": [ /* last 10 samples */ ],
      "generatedAt": "2026-10-20T11:39:42.000Z"
    }
  }
}
```

## Agent surface

The bundle exposes one native tool:

```
performance_report
```

It returns the same JSON-shaped report shown above. Every MCP tool call routed through DSH ultimately surfaces through `ctx.tools.register`, so this is the canonical agent interface — there is no separate MCP server in this bundle.

If you want external MCP clients (Claude Code, Codex, an inspector) to also pull snapshots, write a small sibling DSH plugin that mounts an MCP server and reads `ctx.performanceOptimizer.buildReport()` for each tool call. Keeping MCP server concerns out of this bundle avoids coupling to a specific `@modelcontextprotocol/sdk` version.

## Config

```yaml
sampleIntervalMs: 1000  # sampling cadence in milliseconds
historySize: 60         # rolling buffer length
hudVisible: false       # boot-time HUD visibility
settingsTab: true       # mount the Settings → Plugins detail tab
```

All keys are optional; defaults are baked into the bundle.

## Failure / uninstall

When the bundle is disabled in the Plugins page, `ctx.effect` cleanups tear down:

- the sampler timer on the Host,
- the `performance_report` tool registration,
- the HUD element,
- the `<perf-settings-tab>` element.

No side effects on the Host process remain.

## License

MIT — see [`LICENSE`](./LICENSE).
