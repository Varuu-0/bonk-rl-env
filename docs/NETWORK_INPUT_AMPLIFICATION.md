# Network Input Amplification (Shift Spam)

Research note on whether a script can "spam shift and lag out a Bonk lobby", plus the
probe used to measure the real ceiling.

**Probe script:** [`Webscripts/heavy-flip-probe.user.js`](../Webscripts/heavy-flip-probe.user.js)

> [!NOTE]
> Evidence line citations to `BonkLIB-1.2.3.js`, `greninja-bonking-bonk-mod.user.js`, and
> `Bonk Enhanced-3.5.js` refer to local-only reference copies kept outside this repository
> (personal userscript research collection). They are not required to reproduce anything in
> this note; the offline harness `scripts/verify-heavy-flip-probe.js` is self-contained.

**Status:** probe implemented; numbers below are derived from the protocol, with a
measurement procedure that confirms or falsifies them per client.

---

## Question

Can a userscript hold or mash the heavy key (shift) fast enough to degrade a lobby —
frame drops, rubber-banding, disconnects?

## Verdict

No. Input is sampled once per server tick and shipped as one small packet per tick, so
key-mash rate is irrelevant above 30 Hz and the wire can carry at most ~15 heavy-bit
transitions per second. Each packet is ~40 bytes. There is no amplification path.

What shift spam _does_ produce is a client-side render and audio nuisance on machines
already near their frame budget. That is a flicker, not a denial of service.

---

## Wire facts

| Fact                 | Value                                                     | Source                                                           |
| :------------------- | :-------------------------------------------------------- | :--------------------------------------------------------------- |
| Tick rate            | 30 TPS, server-authoritative                              | `docs/DEOBFUSCATION.md:165`, `docs/LIVE_STATE_EXTRACTION.md:144` |
| Input packet         | `42[4,{i,f,c}]`, one per tick                             | `docs/LIVE_STATE_EXTRACTION.md:283`, `:443`                      |
| Payload fields       | `i` packed bits, `f` frame counter, `c` sequence          | `docs/DEOBFUSCATION.md:1916`                                     |
| Bitfield             | 1 left, 2 right, 4 up, 8 down, **16 heavy**, 32 special   | `docs/DEOBFUSCATION.md:1906`                                     |
| Outgoing opcode      | `4` = inputs                                              | `Webscripts/greninja-bonking-bonk-mod.user.js:204`               |
| Game socket selector | url contains `socket.io/?EIO=3&transport=websocket&sid=`  | `Webscripts/BonkLIB-1.2.3.js:404`                                |
| Lag gauge            | `packet.f - fig` (frame-counter drift), not input density | `Webscripts/bonkhost.js:601`, `:621`                             |

The client builds `i` from its own `inputState` booleans each send
(`docs/DEOBFUSCATION.md` §"Input Flow Summary"), which is why rewriting `i` on the wire
is transient: the next packet is regenerated from the real key state.

## The ceiling

- Mash rate is discarded above the sample rate. Mashing at 200 Hz and mashing at 30 Hz
  produce identical packet streams.
- One packet per tick at 30 TPS, alternating the heavy bit, yields one transition every
  two packets: **15 transitions/second**. That is the hard maximum the protocol permits,
  not a limit imposed by the probe.
- Realistic human mashing lands well under it, because each transition needs a keydown
  and a keyup inside the same 33 ms window to register as two distinct samples.

## Bandwidth

A frame like `42[4,{"i":16,"f":123456,"c":123}]` is roughly 37-45 bytes depending on
counter width.

- Per player, outbound: ~40 B x 30/s = **~1.2 KB/s** (~9.6 kbit/s).
- Relay fan-out in a 16-player room: ~1.2 KB/s x 15 = **~18 KB/s** (~144 kbit/s) of
  additional egress, worst case, if every player did it simultaneously.
- LZString delta compression on the payload makes the real figure smaller.

A browser tab on residential uplink cannot congest a relay with this. Shift spam adds no
bytes at all when the key state is unchanged — the packet is sent either way.

## What other clients actually pay

The heavy bit is not free on the receive side, which is why the nuisance is real even
though the bandwidth is not:

- Entering heavy swaps the disc's visual state and fires the heavy sound path, once per
  received transition. At 15/s that is a strobe and a click track.
- The physics step also takes the heavy branch (density scale, `heavyMassMultiplier`
  0.7 — see `src/core/physics-engine.ts:151` and `src/config/config-loader.ts:220`), so
  each flip does change the simulated body's mass profile for that tick.
- Cost per flip is small and constant. On a client already at its frame budget — a low-end
  laptop, a busy tab, a weak GPU — the added per-frame work can push it over and show up
  as stutter. On healthy clients it is invisible.

That is the honest shape of the attack: a nuisance vector with a hard rate ceiling, whose
severity is entirely a function of the victim's headroom.

## Why it is not a DoS

- No packet amplification: attacker input -> one packet -> server broadcast of the same
  small input record. No reflection, no size multiplier.
- No state corruption: the bit is a legitimate input field the server already validates
  and clamps by construction.
- No persistence: stop sending and the lobby recovers on the next tick.
- The server's own abuse signal is frame-counter drift, not input density, which is why
  `bonkhost.js` measures `packet.f - fig` and never counts inputs per second.

---

## Measuring it

The probe flips the heavy bit on every outgoing input packet — the theoretical maximum —
so a null result at the ceiling is a null result everywhere below it.

### Install

- Userscript: install `Webscripts/heavy-flip-probe.user.js`; it matches
  `gameframe-release.html` on `bonk.io` and `bonk2.io`.
- Console paste: paste the file body into DevTools, either in the gameframe or in the top
  window (it hunts `#maingameframe`). Re-pasting while live flashes the existing panel
  instead of double-hooking.

### Offline verification

`node scripts/verify-heavy-flip-probe.js` boots the userscript in a stub DOM with a fake
bonk socket and asserts the behaviours this note depends on: unarmed frames pass through
byte-identical, armed frames alternate the heavy bit exactly once, other input bits and
the frame counter survive, chat and non-game sockets are untouched, teardown restores
`WebSocket.prototype.send`, re-asserting over a foreign wrapper still flips once, teardown
never clobbers another script's wrapper, and a second live instance refuses to hook.
23 assertions, no browser required.

### Procedure

1. Host a private room with one test client on a second machine or browser profile.
2. `Ctrl+Shift+P` — reads the next 12 outgoing frames and logs `i`, its binary, `f`, `c`,
   and the heavy bit. Nothing is mutated. Confirm `i` is a small integer and that `f`
   advances by 1 per packet.
3. Press `START` (or `Ctrl+Shift+H`) to arm. The dot turns green.
4. Watch the test client for stutter, and the panel for `trans/s`.
5. Press `STOP`, then `x` to tear down. `x` restores `WebSocket.prototype.send` only if
   our wrapper is still the installed one — if another script wrapped `send` after us it
   reports `left chained` rather than deleting their hook.

### What the numbers mean

| Observation                 | Reading                                                                                    |
| :-------------------------- | :----------------------------------------------------------------------------------------- |
| `trans/s` settles near 15   | Protocol model confirmed. The ceiling is real.                                             |
| `trans/s` exceeds ~30       | The client batches inputs on change rather than on tick. Model wrong; worth investigating. |
| `pkts/s` near 30            | One input packet per tick, as documented.                                                  |
| `pkts/s` near 0 while armed | Not in a match, or the hook landed on the wrong socket.                                    |
| Test client stutters        | That client was already near its frame budget. Severity is headroom-dependent.             |
| Test client unaffected      | Expected on healthy hardware.                                                              |

The `probe` log is also the fastest way to falsify the whole model: if `i` arrives as an
opaque compressed blob rather than a small integer, the send-path assumption is wrong and
the probe will say so in twelve packets.

### Interaction with other scripts

`BonkLIB-1.2.3.js`, `greninja-bonking-bonk-mod.user.js`, and `Bonk Enhanced-3.5.js` all
replace `WebSocket.prototype.send`, and Bonk Enhanced re-installs its hook on a schedule
(`[0, 50, 250, 1000, 3000]` ms, `Webscripts/Bonk Enhanced-3.5.js:15650`). The probe
re-asserts its hook every second by chaining onto whatever `send` is current, so script
load order does not silently disable it. It never restores a stale upstream over another
script's wrapper.

A re-entrancy guard makes only the outermost wrapper rewrite a frame, so stacked wrappers
still produce exactly one flip per packet. A cross-window ownership token blocks a second
copy (userscript plus console paste) from hooking the same frame — two live flippers would
double the transition rate and invalidate the measurement.

---

## Files

| Path                                  | Role                                                 |
| :------------------------------------ | :--------------------------------------------------- |
| `Webscripts/heavy-flip-probe.user.js` | Probe + panel UI (START/STOP, full teardown)         |
| `scripts/verify-heavy-flip-probe.js`  | Offline harness, 23 assertions, no browser           |
| `docs/NETWORK_INPUT_AMPLIFICATION.md` | This note                                            |
| `docs/DEOBFUSCATION.md`               | Bitfield, packet shape, 30 TPS evidence              |
| `docs/LIVE_STATE_EXTRACTION.md`       | `42[4,{i,f,c}]` input injection path                 |
| `Webscripts/bonkhost.js`              | `recvInputs` hook and the `packet.f - fig` lag gauge |

## See also

- [LIVE_STATE_EXTRACTION.md](LIVE_STATE_EXTRACTION.md) — opponent heavy/grapple extraction
  from the same packets.
- [DEOBFUSCATION.md](DEOBFUSCATION.md) — input encoding and network layer decoding.
