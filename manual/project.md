> **English (primary, this file)** ｜ **[中文文档](project.zh-CN.md)**

[← Back to README](../README.md)

# Development, contributing, versions, who does what

## Development

```sh
npm install          # pnpm or npm; Node ^22.19 || >=24
npm run typecheck    # tsc --noEmit
npm run verify       # build + static verification scripts  ← run before committing
```

**Rules for changes**: change `src/` and `web/` only — `lib/` is build output and edits there are overwritten; run `npm run verify` before committing; key decisions are written as pure functions, so change them together with their assertions; comments explain *why* — when the behaviour changes, the comment changes with it.

## Contributing

Issues and pull requests are welcome.

- **Bug** — include reproduction steps, error messages and your environment (OS / Node / DSH versions)
- **Suggestion** — describe the use case and the outcome you expect
- **PR** — make sure `npm run typecheck && npm run verify` passes first
- Commit messages are best prefixed with `feat:` / `fix:` / `chore:`

## Versions

Version numbers follow [semantic versioning](https://semver.org/) (`MAJOR.MINOR.PATCH`).
The release history — every version with its list of changes — lives on the homepage:
**[README → Version history](../README.md#version-history)**.

## How this project is built

**Human planning and key judgment; implementation by AI** — model **DeepSeek V4 / V4.1 flash**.

| Stage | Who |
|---|---|
| Direction, scope, architecture decisions, review and acceptance | Human |
| Code, verification scripts, documentation, porting examples | AI |

### Working with an AI that has no memory

A session carries everything it has ever read or run, and every later turn has to carry it again. Two mechanics keep that from becoming the bottleneck: one bounds what goes in, the other decides when to start fresh.

**Keeping the context clean.** One batch of work once pushed a session past a quarter of a million tokens, and every turn after that carried the weight. What contains it: bulk work runs as a **script** rather than a long series of individual calls; oversized command output is intercepted and truncated before it lands; the same file is not re-read turn after turn; and context is treated as a budget with a ceiling. The priority order matters — **the number of calls inside one turn dominates**, then the water level, then the fixed prompt overhead. Bounding output without reducing the call count does not help much.

**Session continuation.** When a session approaches its ceiling, the work continues in a fresh one instead of degrading in place. A **state document** — what was done, what remains, the next step — carries it forward; replaying the transcript would only recreate the problem. A continuation **must not cost more than it saves**: a fresh session that opens by running dozens of tools has gained nothing. And **only work the AI can decide alone may start automatically** — if a decision is still waiting on the human, no continuation is opened.

### The working documents

Building this project left behind a large body of documents — research, plans, projections, forensics and retrospectives. They are the concrete output of "human plans and makes the key calls, AI implements".

Below is the full set of **plan and adjustment records**: **132 documents**, grouped by theme. Names are **post-redaction** — host identifiers, private domains, other business lines, third-party product names and internal reference numbers have been removed or reworded. **The documents themselves are not in this repository.**

<details>
<summary>The full set — 132 documents</summary>

```
plan and adjustment records/
  README                     index of the set
  proof-of-concept notes     kept in a separate subdirectory

  Access and permissions (13)
    01 launch token carried automatically
    02 security hardening: permission boundary and data store
    03 unified key under administrator control
    04 user deletion
    05 login straight into a session, and plugin-ising capabilities: feasibility
    06 login straight into the session window
    07 red line: never auto-fetch the latest upstream version
    08 resident instance ceiling and one active session
    09 hiding model settings from ordinary users: role-based profile patch
    10 read-only deployment of shared skills
    11 skill management surface: shared and personal, API and pages
    12 third-party cloud API integration: survey and first phase
    134 registration: human verification and email code

  Sessions and instance self-healing (14)
    13 fixing a cold-start race that returned 404
    14 auditing and hardening the exposure of sensitive information
    15 fixing expiry that did not redirect to login; reviewing what is visible
    16 navigation settled: three decisions for the skill and plugin surface
    17 checking what the workspace picker exposes
    18 directory picker narrowed to the user's own directory
    19 full review of plans and code
    20 crash self-healing: verifying the current state and hardening it
    21 diagnosing session sluggishness
    22 migrating the service domain
    23 checking the AI capability and permission limits inside an instance
    24 automatic recovery from 401 on the instance side
    25 fixing a crash loop and adding a not-running fallback
    26 upstream upgrade coupling points and a regression list

  Plugins, skills and runtime (19)
    27 assessing platform support for a business-workbench plugin
    28 user data clean-up policy
    29 source of the official allow-list plugins
    30 cleaning up orphan instances left by the orchestrator
    31 plugin page: two tabs and description-led visuals
    32 forensics on a business plugin session; checking sandbox permissions
    33 instance permission default moved to full access
    34 liveness probing on enable, and per-plugin isolation
    35 a clean-up script deleting a platform package
    36 rolling the capability section out to ordinary users
    39 narrowing what an instance exposes and blocking host access
    40 fixing the shared-skill layer mount
    41 hardening skill upload; enabling and disabling user skills
    42 a shared Python runtime; re-checking session forensics
    43 platform-owned files polluting a user workspace, and owner self-repair
    44 freezing the base runtime version
    45 prompting existing sessions to start a new one
    46 shared command-line tools inside an instance
    47 runtime environment page

  Management surface and interaction (15)
    49 feedback and self-healing on first visit after an instance was reclaimed
    50 inject script for session-expiry self-healing
    51 transparent replay of 401 after an instance was reclaimed
    52 a new user's instance would not start
    53 documentation quality review and a slimming plan
    54 documentation information architecture and a machine-readable index
    55 forensics on the latest session and items to improve
    56 in-instance assistant and a file download endpoint
    57 user-management entry in settings; installation for everyone
    58 instance memory optimisation and lowering the quota
    59 reconnection feedback: a start-up animation
    60 renaming a settings section
    61 plugin page: taller official list and bottom spacing
    62 making the plugin catalogue cache visible, with a refetch button
    138 shared model granted per user

  Stability and compatibility (16)
    64 integrating a third-party search provider
    65 coupling plugin enable/disable with the web provider configuration
    66 a false positive on a business plugin, and explicit trust
    67 redoing the capability-management section to the UI spec
    68 root-owned files from the candidate pool, fixed at the root
    69 concurrency governance: routine commits and a server-side lock
    70 an incompatible third-party search plugin causing a crash loop
    71 compatibility pre-check at import and upload
    72 waking and reconnecting automatically on returning to the page
    73 making the lock actually block: wording fixes and hook enforcement
    74 instance memory: lowering the heap limit and adding threshold alerts
    75 two new evaluation axes for plugins: hosting friendliness and resource cost
    76 adapting a third-party spreadsheet plugin: unix socket and same-origin proxy
    77 self-check and in-place recovery on returning, made visible
    78 crash circuit breaker: cool-down and alerting
    129 log collection and inspection: option C

  Platformisation and experience (27)
    79 two platform defects in plugin enable/disable
    80 architecture and feature review: refactoring while keeping behaviour
    81 target architecture and naming conventions: the refactoring outline
    82 making the management surface native to the platform
    83 aligning the login and register pages to the UI spec; show-password
    84 unifying the instance memory quota; removing a false reading
    85 letting users configure their own model keys: two key layers
    86 cross-user instance management; two renames
    87 model settings: user-supplied providers and a shared toggle
    88 detecting the built-in install path; fixing a silent failure
    89 in-conversation file preview using the recommended library
    90 upstream upgrade from 0.1.2-rc.1 to 0.1.5-rc.1
    91 model settings mirroring the official interaction
    92 filtering the recommended plugin list by upstream version
    93 settling compatibility checks: umbrella version and prerelease semantics
    94 instance memory basis settled
    95 HTML shell caching, fixing the root cause of a plugin load failure
    96 decoupling the instance quota from plugin toggles
    97 adding ETag and 304 short-circuiting to the plugin bundler
    98 fixing at the root: cleaning up a stale auth cookie on write-back
    99 why self-decision failed, and strengthening a stop hook
    100 merging in-instance personal skills into the capability group
    101 capability management: rename, tabs and three-line cards
    102 moving language switching into user settings; removing preferences
    135 retiring the old domain
    137 brand mark rework
    139 brand name settled

  Network capability (24)
    103 client installation and mesh interconnection: feasibility
    104 mesh network: global architecture retrospective
    105 mesh network: backbone layer
    106 mesh network: hundred-node projection, v2
    107 mesh network: thousand-node, all-scenario projection
    108 mesh network: game case study
    109 mesh network: research on game traffic and group-chat limits
    110 mesh network: group chat, backup, migration and confidentiality
    111 mesh network: addenda and reference options
    112 mesh network: nine bottlenecks and how to land them
    113 mesh network: transport trade-offs — open ports versus a self-built relay
    114 mesh network: use cases and remaining gaps
    115 mesh network: plugin versus core change, an architecture call
    116 mesh network: working through each problem
    117 mesh network: parameter table and observation basis
    118 splitting the rendezvous relay: forensics and a change plan
    119 clustering: manager and worker
    120 cross-node migration and node bootstrapping
    121 code layering paradigm and iteration risk
    122 moving user data and rebuilding shared state
    123 planning method distilled from the mesh line
    124 audit of non-informative content in the documents
    133 overlay: low-entropy block governance — domain separation and non-determinism
    136 control plane unions multiple relays

  Client form factor (4)
    125 session continuation: retrospective and fixes
    126 session continuation conventions
    127 client-side deployment
    128 desktop client development plan
```

</details>

Alongside them is a further body of **process artefacts**: release and export reports, push and execution checklists, test-environment deployment and health records, cross-repository correspondence, and the export and verification tooling (link checking, EN/ZH structure parity, release-process checks, pre-upload audit, full static verification, type checking) — plus decision evidence deliberately kept back from publication.
