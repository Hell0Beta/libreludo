# Deploying LibreLudo on a Tailnet

Phase 4 of [`phone-controllers.md`](./phone-controllers.md). This is the supported way to run the
relay: a Tailscale sidecar terminates HTTPS and proxies to the app container, which listens on
loopback only.

**Why HTTPS is not optional.** The phone controller rolls the dice by shaking the device, and
`DeviceMotionEvent` is only exposed in a [secure context]. Plain `http://<lan-ip>:3000` — the
obvious way to get a phone onto a dev server — is not one, so shake can never be tested that way.
`tailscale serve` gives every device on the tailnet a real certificate for a real hostname, which
is a secure context with no certificate warnings to click through.

[secure context]: https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts

---

## 1. Prerequisites in the Tailscale admin console

All three are required. The failure mode of each is listed because none of them produce an
obvious error message at the point of use.

| # | Setting | Where | If it is missing |
| --- | --- | --- | --- |
| 1 | **MagicDNS** | DNS tab | The node gets no FQDN, so containerboot substitutes `${TS_CERT_DOMAIN}` with an **empty string**. `tailscale serve` then has no host to attach the HTTPS listener to and silently never comes up. The app container keeps working; `https://…` just does not answer. |
| 2 | **HTTPS certificates** | DNS tab → *Enable HTTPS* | tailscaled cannot obtain a certificate. `serve` fails to provision TLS and the container logs `getting cert: …` — the site is unreachable over HTTPS, and the browser reports a connection failure rather than a certificate warning. |
| 3 | **An auth key** | Settings → Keys → *Generate auth key* | The `tailscale` container starts and then loops on "auth key not provided": the machine never joins the tailnet, so nothing answers. A **reusable** key is the right choice — the sidecar re-authenticates on every cold start. An ephemeral key works too, but the node is deregistered whenever the container is down. |

Also confirm the tailnet's ACLs let the phone and the PC reach a node with the tag/permissions the
auth key issues. A key with a restrictive tag can register the node and still be unreachable.

## 2. Configure and start

```sh
cp .env.example .env      # put the auth key in it (it is gitignored)
docker compose up -d --build
docker compose logs -f tailscale
```

Then browse from any device on the tailnet — phone included — to:

```
https://libreludo.<your-tailnet>.ts.net
```

`libreludo` is `hostname:` in [`../docker-compose.yml`](../docker-compose.yml); the tailnet part
is yours. `tailscale status` lists the exact FQDN if you would rather copy it.

Expect the first load to take a few seconds while the certificate is issued.

## 3. How the pieces fit

```
   phone / PC  ──HTTPS 443──▶  tailscale container  ──HTTP 127.0.0.1:3000──▶  app container
   (tailnet)                    (serves TLS, proxies)                        (node server/index.js)
                                          │
                                both share ONE network namespace
                                 (network_mode: "service:tailscale")
```

- `tailscale/serve.json` is the `serve` config containerboot applies. It contains the literal
  string `${TS_CERT_DOMAIN}`, which containerboot replaces with the node's own FQDN before
  handing the JSON to tailscaled. See the note below on why the placeholder is fine.
- `app` has **no `ports:` mapping** and must not get one. It joins the sidecar's network
  namespace, so its `127.0.0.1:3000` is what the proxy dials. Publishing a port would bind the
  relay on the host and make it reachable off-tailnet.
- The server keeps its `127.0.0.1` default bind (`server/index.js`). That default is load-bearing
  here, not incidental.
- `ts-state` holds the node identity. Deleting it deregisters the machine, and the node may not
  be able to reclaim its name immediately; keep the volume.

## 4. Operating it

```sh
docker compose logs -f app          # relay + sweeper logs
docker compose restart app          # redeploy after a code change (see below)
docker compose down                 # keeps ts-state
docker compose down -v              # DESTROYS the node identity
```

Rebuilding after a code change:

```sh
docker compose up -d --build app
```

Rooms live in the relay process's memory, so restarting `app` drops every room. Phones recover by
themselves — a controller asks to reclaim its seat, gets `NO_SUCH_ROOM`, clears the stored
`seatToken`, and returns to the picker (see `protocol.md` §9). Players mid-game lose the room and
must rejoin; that is the cost of a redeploy, not a bug.

## 5. When HTTPS does not come up

1. `docker compose logs tailscale` is the first place to look; the certificate error is explicit.
2. Check the node actually registered: `docker compose exec tailscale tailscale status`.
3. Check what `serve` thinks it is doing:
   `docker compose exec tailscale tailscale serve status`.
4. Re-check prerequisites 1 and 2. Both are admin-console settings that the container cannot
   enable for you, and both fail in ways that look like "the network is broken".

## A note on `${TS_CERT_DOMAIN}`

The hostname in a `serve` config has to be the node's own FQDN, and the tailnet name is not
knowable when the file is written, so the file uses a placeholder instead of a literal. This is
supported, not a trick: `containerboot`'s `readServeConfig` does

```go
j = bytes.ReplaceAll(j, []byte("${TS_CERT_DOMAIN}"), []byte(certDomain))
```

before unmarshalling, where `certDomain` is the node's cert domain from the netmap. It is a plain
byte replacement of that one token — there is **no general environment-variable expansion** in
serve configs, so `${ANYTHING_ELSE}` would be passed through as a literal string and produce a
nonsensical `Web` key. Only `${TS_CERT_DOMAIN}` is meaningful. The value is empty when MagicDNS is
off, which is the mechanism behind prerequisite 1's failure mode.
