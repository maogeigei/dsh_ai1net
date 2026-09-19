> **English (primary, this file)** ｜ **[中文文档](installation.zh-CN.md)**

[← Back to README](../README.md)

# Installation

> The condensed version (requirements + one command + verification) is in [README → Installation](../README.md#installation).
> For an **AI agent** to execute, hand it [install.md](../install.md).

## Prerequisites

| Item | Requirement |
|---|---|
| OS | Linux (Debian/Ubuntu or RHEL family) + systemd + **root** |
| Node.js | **^22.19 or ≥24** (add `--install-node` to install it automatically when missing) |
| Domain | **Required for option 1** (per-user subdomains and HTTPS depend on it); you can still install without one ⇒ see option 2 |
| Ports | 80 / 443 (the script writes an nginx reverse proxy and reloads it; it also adapts when a panel's nginx already owns them) |

## Option 1: with a domain (production, recommended)

> Only this path has **full capability**: per-user subdomains, HTTPS, and mobile access.
>
> **Worked example**: the project's own deployment runs on **`ai1net.com`** as the main domain (with `*.ai1net.com` for per-user subdomains). Everything below uses `dsh.example.com` as a stand-in — substitute your own domain.

**Step 1 · Configure DNS** (two A records, both pointing at the server's public IP)

| Record | Value | Purpose |
|---|---|---|
| `A  dsh.example.com` | the server's public IP | Main domain: login / admin console / web desktop |
| `A  *.dsh.example.com` | the same IP | Per-user subdomains: `<username>.dsh.example.com` |

```sh
dig +short dsh.example.com        # should return your public IP
dig +short test.dsh.example.com   # wildcard — should return the same IP
```

**Step 2 · Prepare a wildcard certificate**

The script uses certbot with a **DNS-01 challenge (Cloudflare)** to issue a **wildcard certificate** for `dsh.example.com` + `*.dsh.example.com`, so you need a Cloudflare API token (permission `Zone → DNS → Edit`, **scoped to that zone only**):

```sh
apt-get install -y certbot python3-certbot-dns-cloudflare     # Debian / Ubuntu
dnf install -y certbot python3-certbot-dns-cloudflare         # RHEL family
```

> Not using Cloudflare? Skip automatic issuance and place your own certificate at `/etc/letsencrypt/live/dsh.example.com/{fullchain.pem,privkey.pem}` — the script references it directly.

**Step 3 · Run the deployment**

```sh
git clone https://github.com/maogeigei/dsh_ai1net.git
cd dsh_ai1net
sudo CF_API_TOKEN=xxx bash install.sh --domain dsh.example.com --email you@example.com
```

**Step 4 · What the script does**

Environment pre-check → install dependencies and build → install the DSH CLI → write `/etc/dsh_ai1net.env` (0600) → create the data root (0700) → issue the wildcard certificate → write the nginx reverse proxy (`dsh.example.com` + `*.dsh.example.com`) → write and start the systemd service → create the first administrator → health check.

**Step 5 · Verify**

| Check | Command | Expected |
|---|---|---|
| Service | `systemctl is-active dsh_ai1net` | `active` |
| Main domain | `curl -I http://dsh.example.com/` | `200` (or a 301 to https) |
| HTTPS | `curl -I https://dsh.example.com/` | Valid certificate, `200` |
| Subdomain, not logged in | `curl -I https://test.dsh.example.com/` | `401` (a subdomain only has a session after login) |

**Step 6 · Onboard the first user**

Log in to the admin console at `https://dsh.example.com/` → register an ordinary user in a second browser → approve them in the console → that user logs in to the desktop → upload a file / create a folder → "Start DSH in this folder".

## Option 2: without a domain (smoke-test the wiring / local evaluation)

```sh
git clone https://github.com/maogeigei/dsh_ai1net.git
cd dsh_ai1net
sudo bash install.sh                      # no domain: local port 3080 only
```

Opening `http://127.0.0.1:3080/` covers the full loop of login / approval / desktop / starting DSH (measured on a real machine on 2026-09-14: all of these paths returned `200`), but **the chat interface will not open**.

| Capability | Option 2: no domain (`BASE_DOMAIN` empty) | Option 1: main domain + wildcard certificate |
|---|---|---|
| Control plane / admin console / login and approval | ✅ works (`http://127.0.0.1:3080/`) | ✅ |
| Web desktop / files / keys / plugin and skill management | ✅ works | ✅ |
| The "Start DSH" action itself | ✅ returns a sub-path URL | ✅ returns a subdomain URL |
| **DSH chat interface** | ❌ **will not open** | ✅ works on a per-user subdomain |
| HTTPS (mobile included) | ❌ | ✅ requires a wildcard certificate |

⇒ If you only want to **smoke-test the wiring** (login / approval / desktop / start), you **do not need a domain**; use option 1 when you want the chat interface.

<details>
<summary>Common variations (click to expand)</summary>

```sh
sudo bash install.sh                      # no domain: local port 3080 only, to smoke-test the wiring
sudo bash install.sh --dry-run            # print the commands without applying anything
sudo bash install.sh --isolation soft     # skip OS-account hard isolation (auto-downgrades when useradd/setpriv is missing)
sudo bash install.sh --port-guard         # additionally enable the port guard
sudo bash install.sh --admin-user admin --admin-pass 'a-strong-password'
sudo bash install.sh --uninstall          # uninstall the service (keeps data by default)
sudo bash install.sh --uninstall --purge --yes   # delete the data too (irreversible)

# Issue a wildcard certificate through the Cloudflare DNS challenge (recommended: required for per-user subdomains)
CF_API_TOKEN=xxx sudo bash install.sh --domain dsh.example.com --email you@example.com
```

All options: `bash install.sh --help`.
</details>

## Walk through option 1 without owning a real domain

To rehearse the whole deployment flow without buying a domain, use the **wildcard DNS service** `nip.io` (`<anything>.<IP>.nip.io` resolves to that IP, free):

```sh
sudo bash install.sh --domain <your-public-IP>.nip.io --email you@example.com
# every user then becomes  <username>.<your-public-IP>.nip.io
```

**Steps 1–5 are then identical to option 1** (per-user subdomains included); the only thing you cannot get is a **wildcard HTTPS certificate** — `nip.io` offers no DNS API, so DNS-01 is impossible ⇒ everything runs over HTTP.

Measured on a real machine (2026-09-14, OpenCloudOS + BT-Panel): the main domain returned `200` with the platform workbench page ｜ an unauthenticated subdomain returned `401` ｜ login / approval / web desktop / control-plane API all worked.

> ⚠️ In HTTP mode the address returned by "Start DSH" is **hard-coded to `https://`** ⇒ change `https` to `http` in the address bar manually.

## Manual deployment (for development)

```sh
npm ci && npm run build                       # tsc → lib/

node lib/cli.js bootstrap-admin --username admin --password '<a-strong-password>' --db ./dev.local.db
node lib/cli.js --port 3080 --db ./dev.local.db
```

Open `http://127.0.0.1:3080/` → log in to the admin console as admin → register an ordinary user in a second browser → approve them in the console → that user logs in to the desktop, uploads a file / creates a folder → "Start DSH in this folder".

## About domains: when one is mandatory, and what to do without one

**The platform itself does not need a domain**; the **DSH chat interface needs "one exclusive host per user"**. There are two reasons, both stemming from how the DSH frontend and browser cookies work:

| Reason | Explanation |
|---|---|
| **DSH's SPA uses absolute paths** | Its `/assets/*` and `/api/*` requests go to the **host root**. Under a sub-path (`/u/<userId>/dsh/`) they inevitably 404 ⇒ hence "each DSH needs an exclusive host" |
| **Cookies cannot distinguish users on one host** | The session cookie (`sid`) is **host-scoped**; without subdomains all users share one host ⇒ **multiple users in the same browser evict each other's sessions**. One subdomain per user ⇒ cookies are naturally isolated |

> Note: the platform itself **can** tell users apart (by `userId` in a sub-path, by username in a subdomain) — it is the **browser cookie** that cannot.

**No domain of your own?** The `nip.io` section above **rehearses the flow**; because it cannot issue a wildcard certificate, it is **HTTP-only**. To get **HTTPS** you still need your own domain plus a DNS API (Cloudflare is built in).

⇒ Conclusion: HTTP is enough for local / intranet / demo use; **for public production, use option 1** (your own domain plus a wildcard certificate).

> ⚠️ **Known limitation in HTTP mode**: the chat address returned by "Start DSH" is currently **hard-coded to `https://`** (`https://<username>.<main-domain>/`) ⇒ over HTTP that link **will not open**.
> Workaround: change `https` to `http` in the address bar; for real use, configure the wildcard certificate and use HTTPS.
