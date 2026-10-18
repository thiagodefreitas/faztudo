# Phone and LAN access

By default faztudo listens only on `127.0.0.1:7457`. LAN mode adds an HTTPS
listener so you can use the web app from a phone or tablet on the same
network. It is built in and needs no outside service.

## Turn it on

1. Set a password: `faztudo passwd`.
2. In `~/.config/faztudo/config.toml`:

   ```toml
   [lan]
   enabled = true
   listen = "0.0.0.0:7458"
   ```

3. Restart `faztudo serve`. On first start it makes a local certificate
   authority and a server certificate under `~/.local/share/faztudo/tls/` and
   prints one `https://<lan-ip>:7458` address per network address.

## Trust the certificate

The certificate is signed by your own local CA, so your phone must trust it.

1. On the phone, open `http://<lan-ip>:7459`. This plain HTTP page serves only
   the CA download and its SHA-256 fingerprint.
2. Compare that fingerprint with the one in **Settings > Devices** on your
   desktop.
3. Download `ca.crt` and install it in the phone's certificate settings. The
   [getting started guide](https://thiagodefreitas.github.io/faztudo/getting-started/)
   has the iOS and Android steps.

## Pair the phone

In the desktop browser open **Settings > Devices**, click **Pair a phone**
and scan the QR code. The link works once and expires after 5 minutes. Name
the device and tap **Pair device**. You can also sign in at
`https://<lan-ip>:7458/login` with your password.

To disconnect a device, click **Revoke** next to it. Its session and open
streams close at once.

## Other ways to reach it

LAN mode only covers your local network. To reach faztudo from elsewhere you
can put a VPN or a reverse proxy in front of it, as long as it restricts
access to your own devices. Tailscale is one example. Add the proxy's host
name to `allowed_hosts` under `[server]` and read the notes in the
configuration reference first: that path relies on the proxy for access
control. None of this is required.

## Safety notes

- Use LAN mode only on networks you trust.
- Every request on the LAN listener needs a session, and writes must carry a
  matching `Origin` header.
- Failed logins are rate limited.
- The agents' MCP endpoint stays loopback-only.
