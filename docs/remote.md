# Remote: your session on your phone

`/remote` serves the running session to a phone browser. You can read the transcript, send prompts, stop a turn, and answer permission requests, questions and plans while the work keeps running on your computer.

| Command | What it does |
| --- | --- |
| `/remote local` | Serve on your Wi-Fi. The phone must be on the same network. |
| `/remote global` | Serve through a free Cloudflare HTTPS tunnel. Works from anywhere, including cellular. Needs `cloudflared`. |
| `/remote devices` | List remembered phones, forget one, or remember a connected phone. |
| `/remote status` | Show the mode, the address and how many devices are connected. |
| `/remote off` | Stop serving. Connected phones are signed out. |
| `tau --remote-local` | Start Tau with `/remote local` already on. |

Without `/remote` or `--remote-local`, Tau never listens for phones.

Running Tau inside WSL? Local mode needs a one-time network setup first: see [WSL 2](#wsl-2).

## Start with Tau

```sh
tau --remote-local
```

When the session opens, a notice shows the address, for example `http://192.168.1.20:7777`. Phones you remembered can connect right away. For a new phone, run `/remote local` to show the QR code; it shows the same running session, not a new one.

`--remote-local` needs an interactive session, so `tau -p` refuses it. It does not start the tunnel; use `/remote global` for that.

## Pair a phone and remember it

> **Tip for iPhone / iPad:** Scan the QR code using the built-in **Camera app** and tap the link to open it in Safari. Do not use the Control Center Code Scanner, because iOS runs that in an isolated in-app web view with separate storage that cannot share remembered keys with Safari.

1. Run `/remote local` and scan the QR code with the phone's Camera app (on iPhone, tap the link to open in Safari).
2. The page opens and connects. Tau asks **Remember this phone?**
3. Press **Y** to remember it, or **N** to connect only this time.

A remembered phone reconnects to later sessions on this computer without a QR code:

- If the page is still open in the phone's browser when Tau restarts, it reconnects by itself.
- Otherwise, open the same page again, from a bookmark or the browser history. The address bar shows the plain address, with no code in it, so it is safe to bookmark.
- One phone can be remembered by several Tau installs that use the same address, such as Tau on Windows and Tau in WSL. Pair it once with each: the phone keeps a key for each and uses the one that the running Tau knows.
- If the Tau now on that address does not know the phone, the page says so and keeps trying. It gets in by itself once a Tau that remembers it is back.

It works only while the session has remote on (`tau --remote-local` or `/remote local`). It never works through `/remote global`.

A phone is remembered for one address: the computer's IP address and port, such as `192.168.1.20:7777`. If either changes, scan the QR code again. To keep the address stable:

- Reserve the computer's IP address in your router (often called a DHCP reservation).
- Keep port 7777 free. If another Tau window already uses it, the new session takes another port and shows a warning. Set `TAU_REMOTE_PORT` to give each session its own fixed port.
- Or set `TAU_REMOTE_HOST` to a name that follows the computer, such as `mypc.local`, if your phone can resolve it.

## Forget a phone

Run `/remote devices`, select the phone and press **Enter**, then **Y**. It is signed out at once and needs the QR code to connect again. Forgetting in one Tau window signs the phone out of every other window within 30 seconds.

Phones that are connected but not remembered are listed too; press **Enter** on one to remember it.

The list is kept in `~/.claude/remote/devices.json` (inside `CLAUDE_CONFIG_DIR` when that is set), readable only by your user.

## Settings

| Variable | Purpose |
| --- | --- |
| `TAU_REMOTE_HOST` | The address in the QR code: an IP address or a hostname. Use it when Tau cannot see the right address, for example behind a port forward. |
| `TAU_REMOTE_PORT` | A fixed port. If it is taken, Tau reports an error instead of switching ports. Use it with a port forward, or to give each session its own address. |

## Security

Local mode uses plain HTTP and WebSocket on your network, without encryption. That keeps it simple, with no certificates to install, but it has limits:

- Anyone on the same network who records the traffic can read what the phone shows, and can use this session's QR link until the session ends.
- When you press **Y**, the phone's key crosses the network once. After that the phone signs in by answering a fresh challenge, so the key itself is not sent again, and a recorded sign-in cannot be replayed. Pair on a network you trust.
- A connected phone controls the session: it can send prompts and approve tool calls on your computer.

Use local mode on networks you trust, such as home or office Wi-Fi. On public Wi-Fi, use `/remote global` (HTTPS) and do not remember phones. If a phone is lost or given away, forget it with `/remote devices`.

Tau never sends the session link's code to the model: `/remote status` and the other `/remote` messages show only the address.

## Platform notes

- **Windows:** the first time, Windows asks whether Node.js may use the network. Allow it on private networks. If your Wi-Fi is marked Public, Windows may block the phone.
- **macOS:** allow incoming connections if the firewall asks.
- **WSL 2:** needs a one-time network setup; see [WSL 2](#wsl-2) below.
- **Android 17 and later:** if the page never loads, allow the browser to find nearby devices: Settings > Apps > your browser > Permissions > Nearby devices.
- **iPhone and iPad:** scan with the built-in **Camera app** (tap the link to open in Safari), not the Control Center Code Scanner. A page added to the Home Screen can also keep its own storage, apart from Safari; if the Home Screen icon says the phone is not paired, use the page in Safari instead.
- **Private tabs** forget the phone when they close.
- **Browsers in HTTPS-only mode** warn before opening a plain-HTTP page. Continue to the page; that warning is the plain-HTTP trade-off described above.

## WSL 2

By default, WSL 2 runs Linux in a small virtual machine with a private address that only Windows can see. Your phone can reach Windows, but not Linux behind it:

```
phone ── Wi-Fi ── Windows PC (192.168.1.20) ──✕── WSL 2 (172.18.93.43)
```

So when Tau runs inside WSL 2, local mode needs one of the setups below. `/remote global` works without any of them.

Commands below are marked with where to run them:

- **PowerShell (admin):** Windows PowerShell opened with *Run as administrator*.
- **PowerShell:** a normal Windows PowerShell.
- **WSL:** your Linux terminal.

### Step 1: check your setup

**PowerShell:**

```powershell
wsl -l -v       # the VERSION column: 1 or 2
wsl --version   # the WSL version and Windows version
```

**WSL:**

```sh
wslinfo --networking-mode
```

| What you see | What Tau does | What to do |
| --- | --- | --- |
| `nat` | Refuses local mode and says why. Press G to use Global instead. | [Option A](#option-a-mirrored-networking-recommended) or [Option B](#option-b-port-forward-windows-10-or-keeping-nat), or use `/remote global`. |
| `mirrored` | Works, with your PC's Wi-Fi address in the QR code. | Only the firewall rule, [Option A step 4](#option-a-mirrored-networking-recommended). |
| `wslinfo: command not found` | Assumes `nat`, because older WSL only had NAT. | Run `wsl --update` in PowerShell, then check again. |
| VERSION `1` in `wsl -l -v` | Works like Windows: WSL 1 uses the Windows network directly. | Nothing. |

### Option A: mirrored networking (recommended)

Linux shares the PC's own network address, so the phone reaches Tau directly. You set this up once, and remembered phones keep working across restarts.

Needs Windows 11 version 22H2 or later and WSL 2.0.0 or later. `wsl --version` shows both; `wsl --update` updates WSL.

1. **PowerShell:** open the WSL settings file. Notepad offers to create it if it does not exist yet.

   ```powershell
   notepad "$env:USERPROFILE\.wslconfig"
   ```

   This file is in your Windows user folder, for example `C:\Users\you\.wslconfig`, not inside Linux.

2. Make sure it contains these two lines, then save:

   ```ini
   [wsl2]
   networkingMode=mirrored
   ```

   If the file already has a `[wsl2]` line, add only `networkingMode=mirrored` under it. A second `[wsl2]` line is not needed.

3. **PowerShell:** restart WSL so the setting takes effect. Wait about 10 seconds, then open your WSL terminal again.

   ```powershell
   wsl --shutdown
   ```

   **WSL:** `wslinfo --networking-mode` should now print `mirrored`, and `hostname -I` should include the same address that `ipconfig` shows for your Wi-Fi in Windows.

4. **PowerShell (admin):** WSL has its own firewall (the Hyper-V firewall), which blocks phones by default. Allow Tau's port, once:

   ```powershell
   New-NetFirewallHyperVRule -Name TauRemote -DisplayName "Tau remote" -Direction Inbound -VMCreatorId '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}' -Protocol TCP -LocalPorts 7777
   ```

   The long ID is the fixed ID Windows uses for WSL; copy it exactly. Check the rule with `Get-NetFirewallHyperVRule -Name TauRemote`. If you set `TAU_REMOTE_PORT` to another port, allow that port instead of 7777.

5. **WSL:** start Tau and pair your phone:

   ```sh
   tau --remote-local
   ```

   Then run `/remote local`, scan the QR code, and press **Y** to remember the phone. Next time, `tau --remote-local` is enough.

**Tau on Windows and Tau in WSL share one address in mirrored mode**, so only one of them can use port 7777 at a time. The one started second moves to another port and shows a warning, and the phone is not paired at that new address. Choose one way:

- **Run one at a time.** Pair the phone once with each, while that one is running. The phone keeps a key for each and works with whichever is running, with no more scanning.
- **Give each its own port**, to run both at once. For example, start the Windows one with `TAU_REMOTE_PORT=7778` and keep WSL on 7777. Then pair the phone once at each address. Windows already lets Node.js accept connections once you have allowed it, on any port.

### Option B: port forward (Windows 10, or keeping NAT)

Windows receives the phone's connection on port 7777 and passes it to Linux. This works on Windows 10, where mirrored mode is not available. The catch: **Linux gets a new address every time WSL or Windows restarts**, so you must rerun step 2 after each restart.

1. **PowerShell (admin):** allow the port in the Windows firewall, once:

   ```powershell
   New-NetFirewallRule -DisplayName "Tau remote" -Direction Inbound -Protocol TCP -LocalPort 7777 -Action Allow -Profile Private
   ```

   This rule covers networks Windows calls *Private*. If your Wi-Fi is marked *Public*, switch it to Private (Settings > Network & internet > Wi-Fi > your network > Private network), or use `-Profile Any`.

2. **PowerShell (admin):** forward the port to Linux's current address. Run this again after every WSL or Windows restart.

   ```powershell
   $wslIp = (wsl hostname -I).Trim().Split(' ')[0]
   netsh interface portproxy delete v4tov4 listenaddress=0.0.0.0 listenport=7777
   netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=7777 connectaddress=$wslIp connectport=7777
   netsh interface portproxy show v4tov4
   ```

   The `delete` line says it cannot find the file the first time; that is fine. The last line should show `0.0.0.0  7777  <Linux address>  7777`. With several distributions, use `wsl -d <name> hostname -I`.

3. **PowerShell:** find your PC's Wi-Fi address with `ipconfig`, under *Wireless LAN adapter Wi-Fi*, *IPv4 Address*. For example, `192.168.1.20`.

4. **WSL:** tell Tau that address and pin the port. Here 192.168.1.20 stands for your own address. Add it to `~/.bashrc` so it applies every time:

   ```sh
   echo 'export TAU_REMOTE_HOST=192.168.1.20 TAU_REMOTE_PORT=7777' >> ~/.bashrc
   source ~/.bashrc
   tau --remote-local
   ```

   `TAU_REMOTE_HOST` puts the Windows address in the QR code, because the Linux address is unreachable. `TAU_REMOTE_PORT=7777` keeps Tau on the forwarded port: if 7777 is taken, Tau stops with an error instead of moving to a port the forward does not cover.

5. Pair as usual: `/remote local`, scan, then **Y**.

While the forward exists, Windows holds port 7777. Tau running on Windows itself, rather than in WSL, will move to another port.

### Option C: `/remote global`

This needs no network setup and also works over cellular, through a free Cloudflare tunnel. Install the **Linux** `cloudflared` inside WSL, not the Windows one:

```sh
curl -L -o cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
sudo dpkg -i cloudflared.deb
```

On an ARM PC, use `cloudflared-linux-arm64.deb`. The catch: phones are not remembered in global mode, because the tunnel gets a new address each time. You scan the QR code every session.

### Undo

- **Option A:** remove `networkingMode=mirrored` from `.wslconfig` and run `wsl --shutdown`. **PowerShell (admin):** `Remove-NetFirewallHyperVRule -Name TauRemote`.
- **Option B:** **PowerShell (admin):** `netsh interface portproxy delete v4tov4 listenaddress=0.0.0.0 listenport=7777` and `Remove-NetFirewallRule -DisplayName "Tau remote"`. Remove the `export` line from `~/.bashrc`.

### If the phone still cannot connect

- **Tau says "WSL 2 with NAT networking":** you are still on NAT. Check `wslinfo --networking-mode`; after editing `.wslconfig`, `wsl --shutdown` is required.
- **Mirrored, but the page never loads:** the Hyper-V firewall rule is missing or has the wrong port. Check it with `Get-NetFirewallHyperVRule -Name TauRemote`.
- **Port forward, and it worked yesterday:** Linux has a new address after a restart; rerun Option B step 2. If `netsh interface portproxy show v4tov4` shows nothing, the forward is gone. Port forwarding also needs the *IP Helper* Windows service, which is on by default.
- **"Port 7777 (TAU_REMOTE_PORT) is already in use":** another Tau with remote on, in WSL or on Windows, already has the port. Close it, or pin a different port in both the forward and `TAU_REMOTE_PORT`.
- **The phone says "Tau on your computer does not remember this phone":** the Tau now on that address is a different install (the Windows one or the WSL one), or it forgot the phone. Scan that Tau's QR code once and press **Y**. The phone keeps its other keys.
- **Tau shows an address like `:54515` instead of `:7777`:** another Tau already had 7777 (see *Tau on Windows and Tau in WSL share one address* above). The phone is not paired at that address, and the address alone, without the code from the QR code, can only say "not paired".
- **A remembered phone stopped reconnecting:** your PC's Wi-Fi address probably changed, so the phone's saved address is old. Update `TAU_REMOTE_HOST` if you set it, and scan the QR code again. To stop this happening, reserve the PC's address in your router (often called a *DHCP reservation*).
- **Still stuck:** the phone side can block it too. See the Android note in [Platform notes](#platform-notes).
