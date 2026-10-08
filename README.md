# LuxPower for Homey Pro

Local control of LuxPower (and EG4-rebadged) hybrid inverters from Homey Pro,
over the dongle's native LXP protocol on TCP port 8000. No cloud, no polling of
LuxPower's servers.

Homey Pro only — Homey Cloud/Bridge apps have no local network access.

## Status

| Part | State |
|---|---|
| LXP packet builder + CRC-16/Modbus | done, byte-verified against the reference implementation |
| Response parser (protocol 1/2/5, exceptions, heartbeats) | done |
| TCP client: stream framing, serialised requests, reconnect | done, covered by `tools/test-framing.js` |
| Register map + decoder | core values done |
| Homey app (drivers, capabilities, flows) | not started |

## Layout

```
lib/crc.js           CRC-16/Modbus
lib/LxpRequest.js    38-byte request packets (read fn 3/4, write fn 6)
lib/LxpResponse.js   response parsing and CRC validation
lib/LxpClient.js     TCP client: framing, request queue, timeouts, reconnect
lib/registers.js     register map and decoding into named values
tools/probe.js       sweep a real inverter and dump its registers
tools/test-framing.js  protocol tests against a fake dongle (no hardware needed)
```

## Protocol

A request is always 38 bytes:

```
offset  size  field
0       2     prefix A1 1A
2       2     protocol (1), little-endian
4       2     frame length (32)
6       1     reserved (1)
7       1     tcp function (194 = translated data)
8      10     dongle serial, ASCII
18      2     data length (18 = 16-byte frame + CRC)
--- data frame, 16 bytes, the CRC covers exactly this ---
20      1     action (0)
21      1     function: 3 read hold, 4 read input, 6 write single
22     10     inverter serial, ASCII
32      2     register, little-endian
34      2     register count (read) or value (write), little-endian
---
36      2     CRC-16/Modbus over bytes 20..35, little-endian
```

Responses carry the same header but a variable-length data frame; protocol 2 and
5 prefix the payload with a length byte. The dongle also pushes its own
cloud-sync traffic (tcp function 193) down the same socket, so the client frames
packets off the stream and drops anything that is not the answer it is waiting
for.

## Testing without hardware

```
node tools/test-framing.js
```

Spins up a fake dongle that splits responses across TCP chunks, coalesces
frames, and interleaves heartbeats.

## Probing a real inverter

```
node tools/probe.js --host 192.168.1.50 --dongle BA12345678 --inverter 1234567890 --out dump.json
```

Older dongle firmware rejects 125-register blocks; use `--block 40` if every
block fails.

## Credits

Register map and protocol details derived from
[ant0nkr/luxpower-ha-integration](https://github.com/ant0nkr/luxpower-ha-integration) (MIT).
