> **English (primary, this file)** ｜ **[中文文档](install.zh-CN.md)**

I want you to install dsh_ai1net for me. Execute all steps autonomously.

OBJECTIVE: Install **DSH AI1NET** on a Linux machine (hosting DeepSeek Harness for multiple users) so that the control-plane service is healthy and reachable.

DONE WHEN: `systemctl is-active dsh_ai1net` prints `active` and `curl -fsS -o /dev/null -w '%{http_code}' http://127.0.0.1:${PORT:-3080}/` prints `200`.

## TODO

- [ ] Step 0: verify the environment (**stop if it does not match — do not guess**)
- [ ] Step 1: get the code
- [ ] Step 2: choose a deployment mode (ask the user the one question: is there a domain?)
- [ ] Step 3: rehearse with `--dry-run`
- [ ] Step 4: run the real installation
- [ ] Step 5: verify
- [ ] Step 6: hand the access details to the user

## Step 0: verify the environment

```sh
uname -s; id -u; command -v systemctl; command -v nginx || echo NO_NGINX; node -v || echo NO_NODE
```

**Verify:** the output must show `Linux`, `id -u` equal to `0`, and a path for `systemctl`, all at once.

**If any of those fails ⇒ stop, paste the output back to the user verbatim, and offer the matching exit below. Do not rework the environment yourself:**

| Situation | What to offer the user |
|---|---|
| Windows / macOS personal computer | Install Ubuntu inside **WSL2** first (in an administrator PowerShell run `wsl --install`; then inside Ubuntu set `/etc/wsl.conf` to `[boot]` plus `systemd=true`, run `wsl --shutdown` and re-enter), then **come back to Step 1 of this file** |
| Not root | Re-run as root, or prefix the commands with `sudo` |
| No nginx | **Not a blocker**: add `--no-nginx` in Step 4 and use `http://127.0.0.1:<port>/` |
| No node | **Not a blocker**: add `--install-node` in Step 4 |

## Step 1: get the code

```sh
git clone https://github.com/maogeigei/dsh_ai1net.git && cd dsh_ai1net
```

**Verify:** `test -f install.sh` exits with code 0.

## Step 2: choose a deployment mode

**Ask the user one question** (the only question you must ask): **do you have a domain of your own?**

- **Yes** ⇒ record `DOMAIN=<the domain they gave>`. **First confirm DNS is in place**: two A records — `<domain>` and `*.<domain>` — both pointing at this machine's public IP.
  Optionally, with a Cloudflare API token (permission `Zone → DNS → Edit`, scoped to that zone) in `CF_API_TOKEN`, a **wildcard certificate** is issued automatically (which is what enables HTTPS).
- **No** ⇒ use `<this machine's public IP>.nip.io` as the domain (free wildcard resolution, **HTTP only**); or skip the domain entirely (local port 3080 only).

**Verify:** with a domain, both `dig +short "$DOMAIN"` and `dig +short "test.$DOMAIN"` return this machine's public IP.

## Step 3: rehearse

```sh
sudo bash install.sh --dry-run ${DOMAIN:+--domain "$DOMAIN"} ${EMAIL:+--email "$EMAIL"} --yes
```

**Verify:** the output is a series of `[dry-run] …` lines and the exit code is 0; `--dry-run` **only prints and writes nothing**, so no "done"-style message should appear.

## Step 4: run the real installation

```sh
sudo ${CF_API_TOKEN:+"CF_API_TOKEN=$CF_API_TOKEN"} bash install.sh \
  ${DOMAIN:+--domain "$DOMAIN"} ${EMAIL:+--email "$EMAIL"} \
  ${NO_NGINX:+--no-nginx} --install-node --yes
```

(Replace `${NO_NGINX:+--no-nginx}` according to what Step 0 determined; leave it out when it is not needed.)

**Verify:** exit code 0. At the end the script prints the **first administrator's username and password** — when `--admin-pass` was not passed it is generated randomly and **printed only this once**, so record it immediately and hand it to the user.

## Step 5: verify

```sh
systemctl is-active dsh_ai1net
curl -s -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:${PORT:-3080}/"
```

**Verify:** `active` and `200` respectively. With a domain, add these two:

```sh
curl -s -o /dev/null -w '%{http_code}\n' "http://$DOMAIN/"          # expect 200
curl -s -o /dev/null -w '%{http_code}\n' "http://admin.$DOMAIN/"    # expect 401 (not logged in — normal)
```

## Step 6: hand it over

Report exactly these three things, nothing more:

1. **Access URL**: with a domain ⇒ `http://$DOMAIN/`; otherwise ⇒ `http://127.0.0.1:${PORT:-3080}/`
2. **The administrator credentials** (the pair printed in Step 4)
3. **New users can only "self-register → an admin approves them in the console"** (the platform has no API for an admin to create accounts directly)

EXECUTE NOW: Start with Step 0. Mark TODO items complete as you go. Stop when `systemctl is-active dsh_ai1net` prints `active` and `curl -fsS -o /dev/null -w '%{http_code}' http://127.0.0.1:${PORT:-3080}/` prints `200`.

---

## Optional: what you can do once it is installed

Log in as admin → approve users in the console → a user enters the web desktop, uploads files and creates folders → "Start DSH in this folder".
**The DSH chat interface requires a per-user subdomain** (DSH's SPA uses absolute paths, so a sub-path cannot load it); without a domain everything else works and only the chat interface will not open.

## Optional: uninstall

```sh
sudo bash install.sh --uninstall --yes              # keep the data
sudo bash install.sh --uninstall --purge --yes      # delete the data too (irreversible)
```

## Optional: check these three first when something fails

| Symptom | Look at |
|---|---|
| The service will not start | `journalctl -u dsh_ai1net -n 50` |
| The domain does not open | `nginx -t`; the script writes into `/etc/nginx/conf.d/` or a panel (BT-Panel) vhost directory |
| Installed but cannot log in | The administrator must be **created before the service starts**; if it was lost, stop the service and run `node lib/cli.js bootstrap-admin` (a running service holds the SQLite lock) |

Full documentation: [README.md](README.md).
