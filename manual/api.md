> **English (primary, this file)** ｜ **[中文文档](api.zh-CN.md)**

[← Back to README](../README.md)

# Control-plane API

The web desktop and the admin surface share one HTTP API (Fastify with session-cookie authentication). Below are the **groups and their permissions**; full endpoint definitions live in `src/web/routes/*.ts`.

| Group | Permission |
|---|---|
| Auth / sessions · per-user keys | Logged-in user |
| Web desktop / files · instance lifecycle | Logged-in user (their own only; file operations stay inside the path fence) |
| Skills · plugins | Shared skill layer and plugin candidate pool = admin; personal skills and plugin enable/disable = the user |
| Users and approval · official-catalogue allowlist · read-only ops | Admin |
| Custom domains | The user / an admin |
