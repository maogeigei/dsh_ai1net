> **English (primary, this file)** ｜ **[中文文档](README.zh-CN.md)**

[← Back to the repository README](../../README.md)

# Interactive diagrams

Twelve self-contained HTML diagrams describing this platform — six subjects, each in English and Chinese. Every one is a single file with no external requests: open it in a browser and it works offline, including theme switching, pan and zoom, search, focus, and PNG/SVG/JPEG export.

They were produced with **[Archify](https://github.com/tt-a1i/archify)** (MIT) — a renderer that compiles a typed JSON specification into a validated, self-contained SVG/HTML artifact.

## Architecture

| Diagram | What it shows |
|---|---|
| **[architecture.html](architecture.html)** | The single-machine deployment: request path, per-user isolation, and the guards and governance around it |
| **[cluster-architecture.html](cluster-architecture.html)** | How cluster mode splits the same deployment across hosts, and what ownership by lease changes |
| **[overlay-architecture.html](overlay-architecture.html)** | How nodes behind NAT reach each other: one outbound connection per node, a loopback-only relay, an optional direct path, and where identity and addresses come from |

## Behaviour

| Diagram | Type | What it shows |
|---|---|---|
| **[instance-wake.html](instance-wake.html)** | sequence | What happens when a user returns to an instance that was reclaimed while idle |
| **[instance-lifecycle.html](instance-lifecycle.html)** | lifecycle | The states an instance moves through, and how a crash is repaired in place |
| **[plugin-admission.html](plugin-admission.html)** | workflow | How a plugin gets from submission to a user's enabled list, where it is stopped, and how a plugin that fails the pre-check is adapted and re-submitted |

Each diagram has a Chinese edition alongside it, suffixed `.zh-CN.html`.

> The hand-drawn SVG diagrams in the parent folder (`diagrams/*.svg`) are unchanged and still used by the README for inline display. These HTML diagrams are their interactive counterparts, not replacements.

## Opening them

Open the file directly in any modern browser — there is no build step and nothing to install.

## Regenerating or editing them

The specification behind each diagram is in [`sources/`](sources/). The JSON is the editable source; the HTML is a compiled artifact, so edit the JSON rather than the HTML.

```bash
# from a checkout of tt-a1i/archify
node bin/archify.mjs validate architecture sources/architecture.architecture.json --quality showcase --json
node bin/archify.mjs deliver  architecture sources/architecture.architecture.json architecture.html --quality showcase
```

`validate` reports a composition receipt; `deliver` re-renders, re-checks and only then replaces the output atomically. Every diagram here was delivered at the `showcase` quality profile with **9/9 checks passing and zero errors or warnings**.

## A note on the authored canvas

Each diagram sets an explicit `meta.viewBox`. The renderer otherwise sizes its canvas from the content, and for the taller subjects that produced a canvas narrow enough that the viewer scaled it **up** past 1:1 — which pushed the page past the viewport height at desktop sizes. Authoring a wider canvas keeps the scale at or below 1 and fits the page to the first screen. The window is real, not unlimited: make the canvas too wide and node text falls below the readability floor, so canvas width and card length have to be balanced.

> The diagrams describe the platform's own architecture in general terms. They are drawings, not a deployment manifest — see [manual/architecture.md](../../manual/architecture.md) for the authoritative description.
