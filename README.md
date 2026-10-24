![Logo](admin/sungrow-local.png)

# ioBroker.sungrow-local

[![NPM version](https://img.shields.io/npm/v/iobroker.sungrow-local.svg)](https://www.npmjs.com/package/iobroker.sungrow-local)
[![Test and Release](https://github.com/SmarthomeElektroniker/ioBroker.sungrow-local/actions/workflows/test-and-release.yml/badge.svg)](https://github.com/SmarthomeElektroniker/ioBroker.sungrow-local/actions/workflows/test-and-release.yml)

*Read this in another language: [Deutsche Kurzbeschreibung](README_de.md).*

Connects a **Sungrow hybrid inverter** (developed with an SH20T) and its **battery** (SBH series, e.g. SBH400)
to ioBroker through the **WiNet-S2** communication module via **Modbus TCP** – locally, without iSolarCloud.

The adapter was written as a replacement for a generic `ioBroker.modbus` instance that read the same registers.
It keeps the state IDs of such an instance, so existing scripts, visualisations and history settings can be
moved over by a simple text replacement (see [Migration](#migration-from-iobrokermodbus)).

## Why another Modbus adapter?

The WiNet-S2 is a Modbus TCP ↔ RTU gateway: every request ends up on one RS485 bus shared by the inverter
(unit 1) and the battery (unit 2). The battery is slow – the WiNet gives it an *instruction interval* of 5000 ms,
during which the bus is blocked. With a generic Modbus instance this leads to:

- one poll interval for everything – either the power values are slow or the battery requests time out,
- every timeout drops the whole TCP connection; after the reconnect all PV values are missing for about a minute,
- writes that run into the blocked bus are discarded and look as if the inverter ignored them.

## Features

- **Exactly one TCP connection** to the WiNet-S2. All requests are queued and sent strictly one after another,
  with a configurable minimum pause between them.
- **Poll groups** with their own interval, request timeout and optional pause after each request. Defaults
  (measured on a reference installation): `live` 5 s, `energie` 60 s, `steuerung` 60 s, `akku` 120 s with
  timeout 15000 ms and a pause of 5000 ms. Shorter values are marked red in the admin UI (warning only).
  Blocks are built like in ioBroker.modbus (max. block size / max. gap), but per group.
- **A timeout only fails its own block.** The connection is re-established only after N failures in a row
  (default 3) or when the gateway closes the socket; only then `info.connection` becomes `false`. Modbus
  exceptions count as an answer.
- **Prioritised writes:** holding registers are written before the next read request (FC6; with
  *do not use write multiple registers* also for 32-bit values) and read back immediately. `ack=true` is set
  only with the confirmed value – also when the same value was written again.
- **Read-only mode** (reject writes and reset the state), e.g. for the first days after a migration.
- **Plain text and limits** per register (`states` as `value:text;value:text`, `min`, `max`). A write outside
  these limits is logged as a warning and still sent.
- **Diagnostics per group** under `info.groups.<group>.*`: response time, last success, last error,
  requests/timeouts/errors/skipped rounds today and timeouts/errors in total; writes under `info.write.*`.
- **Heartbeat** per group: `lastRound` (timestamp of every complete round, also without value changes),
  `roundDuration` and `lastRoundText`, plus `info.lastValueUpdate`. Register values are only written on change,
  so an old timestamp at a register is no fault – a stuck bus shows in `lastRound`.
- **Status tab** in the instance settings with connection state, heartbeat, response time and counters per group.
- **Register template:** besides the registers read by default, the tables contain 100 further known Sungrow
  registers (unticked). Tick a row to read it – it joins the request blocks of its group, no extra connection.
  Own registers can still be added.
- **Conversion helper** tab: addresses in all notations, data type, sign, word order and factor explained, raw
  values decoded in every common way, plausibility warnings and an optional single test read of the register.

## Requirements

- Sungrow hybrid inverter with a **WiNet-S2** module and Modbus TCP enabled (port 502).
- The WiNet-S2 has an **IP allow list for Modbus TCP**. A client that is not on that list gets its connection
  accepted and then reset at the first request (`ECONNRESET`) – it looks like a network problem. Add the IP
  address of the ioBroker host (as seen by the WiNet, i.e. after NAT) in the WiNet web interface.
- Only one Modbus client at a time should talk to the WiNet. Disable other Modbus instances that poll the same
  gateway before enabling this adapter.
- js-controller >= 6.0.11, admin >= 7.6.20, Node.js >= 22.

## Configuration

1. **Connection** – IP address and port (502) of the WiNet-S2, minimum pause between requests, reconnect
   behaviour, write timeout/retries, read-only mode, block building (max. registers per request, max. gap) and
   number of decimal places.
2. **Poll groups** – interval, timeout and pause per group. The admin UI shows the limits that were measured
   to be stable and marks shorter values red.
3. **Input registers / Holding registers** – the register tables (same columns as ioBroker.modbus plus
   *read*, *group*, *states*, *min*, *max* and *source / note*). Ticked by default: 68 input registers (inverter
   unit 1 and battery unit 2) and 9 holding registers (EMS mode, charge/discharge command and power, SoC
   limits, …). The other rows are the register template (see below).
4. **Conversion helper** – see below.
5. **Status** – live view of the running instance.

## Register template

The register tables contain every register this adapter knows, **ticked** ones are read:

- **Ticked by default** are exactly the registers of the earlier versions – an update changes nothing that is
  read and no state ID.
- **Unticked** are 74 input and 26 holding registers: device type (with model names), serial number and firmware
  versions, MPPT 4, signed battery power and current (newer firmware), precise grid frequency, energy meter
  voltages/currents/totals, monthly PV yields, alarm and fault codes, battery current and temperature of the
  SBH (unit 2), system clock, export limitation, load adjustment, battery charge/discharge power limits, forced
  charging and more. Writable rows come with plain text (`states`) or limits.
- Tick a row and save: the register is added to the request blocks of its group (e.g. battery current and
  temperature of unit 2 lie inside the existing battery request – no additional request). Rarely changing values
  are in the group `info` (once per hour).
- **Unticking** a register that was read before removes its data point (including history settings).
- Existing installations get the template once on the first start of 0.3.0 (the instance restarts once); rows
  you configured yourself always win – a template row that overlaps one of your registers is not added.
- Column *source / note* tells where a row comes from:
  - **HA mkaiser (MIT)** – [Sungrow-SHx-Inverter-Modbus-Home-Assistant](https://github.com/mkaiser/Sungrow-SHx-Inverter-Modbus-Home-Assistant)
    by Martin Kaiser, MIT License, Copyright (c) 2025 Martin Kaiser. Register addresses, data types, scaling and
    the value tables (device type codes, on/off codes, EMS and load adjustment modes) were taken from
    `modbus_sungrow.yaml`.
  - **reference list** – register list of the reference installation (SH20T + SBH400 via WiNet-S2), checked on
    the device; partly with notes (e.g. monthly yields: factor 0.1 measured, the document says 1).
- Grid code parameters (LVRT/HVRT, frequency/voltage protection, reactive power curves) are deliberately not
  part of the template – they are installer settings without documented scaling.

## Conversion helper

Sungrow documents, Home Assistant configurations and Modbus tools count addresses differently and describe
data types in different ways. The tab **Conversion helper** puts one register into all notations:

| Notation | Battery level | Rule |
|---|---|---|
| Sungrow document (counts from 1) | 13023 | – |
| Modbus protocol / Home Assistant `address:` (counts from 0) | 13022 | document − 1 |
| Column *Address* in this adapter (input / holding) | 43023 | protocol + 30001 / + 40001 |

- **Data types:** 16 bit `U16` (never negative) or `S16` (power, current, temperature – raw values above
  32767 are negative). 32-bit values use two registers and Sungrow sends the **low word first**: `uint32sw` /
  `int32sw`. The type list in the tables shows these explanations.
- **Factor:** Sungrow gives the resolution, e.g. "0.1 kWh" = factor 0.1. Value = raw value × factor + offset.
- **Raw values:** type them in (`950`, `0x03B6`, `4464 1` for 32 bit) or tick *Read from the device*: the
  adapter reads the register once over its connection (queued like every other request, at most every 5 s,
  FC4/FC3 only – never a write).
- **Output:** all addresses and the resulting state ID, the value of the selected type, the same raw words as
  U16/S16/U32/S32 in both word orders, warnings (`0xFFFF` = no value, sign, word order, implausible value with a
  better factor) and the line to enter in the register table.
- When a register is read for the first time after a start, its value is checked against a plausible range per
  unit (V, A, W, kWh, %, °C, Hz); an implausible first value is logged as a hint (info).

## Objects

| ID | Content |
|---|---|
| `inputRegisters.<unit>.<address>_<name>` | input registers (read-only) |
| `holdingRegisters.<unit>.<address>_<name>` | holding registers (writable unless read-only mode is on) |
| `info.connection`, `info.reconnects`, `info.lastReconnect`, `info.queueLength`, `info.lastValueUpdate` | connection |
| `info.groups.<group>.*` | diagnostics and heartbeat per poll group |
| `info.write.*` | diagnostics of writes |

`<address>` is the register address as shown in the Sungrow documentation (30001/40001 based), `<name>` is the
*name* column with spaces and dots replaced by `_`. The *description* column becomes the object name.

## Migration from ioBroker.modbus

The IDs, names, units, factors, data types and roles are built exactly like in ioBroker.modbus (with
*multi device ID* enabled), so the register tables of an existing instance can be copied into this adapter and
all state IDs stay the same apart from the instance prefix (`modbus.N.` → `sungrow-local.0.`).

Suggested order: back up; switch scripts/watchdogs to the new instance; disable the old Modbus instance (the
WiNet should only see one client); enter the host and enable this adapter (read-only first); compare the values;
then allow writes. History data of the old states can be continued with the `aliasId` setting of the history
adapter.

## Difference to other adapters

- **ioBroker.modbus** is the generic Modbus adapter and the base this adapter is compatible with. It is the
  right choice for any other Modbus device. `sungrow-local` only adds what the WiNet-S2 needs: per-group
  intervals, timeouts that do not drop the connection, prioritised and confirmed writes, and diagnostics.
- At the time of writing there is **no dedicated Sungrow adapter** in the ioBroker repository; other solutions
  use the iSolarCloud (internet) or the WiNet web socket API. This adapter uses only the documented local
  Modbus TCP interface.

## Visualisation (vis templates)

The folder [`vis-templates/`](vis-templates/) contains ready-made **vis 1** views (animated energy flow,
battery, inverter & grid, adapter diagnostics) and a battery symbol widget in two colours. They use only
data points of `sungrow-local.0` – no scripts, no other adapters. Import instructions:
[vis-templates/README.md](vis-templates/README.md).

## Notes

- `35016` is the current of MPPT 3. Its ID stays `35016_MPPT_2_Current` for compatibility with existing
  installations; only the object name was corrected.
- `43001` (running state) is a bit field and `43030` (grid state) is not clearly documented – both are shown as
  numbers without plain text.
- The upper limit 20000 W of `53052` (charge/discharge power) is an assumption for an SH20T; adjust it for other
  models.
- Comparison with other projects (kept unchanged for compatibility, you can change type/factor in the table):
  `43008` (load power) and the phase currents `43031`–`43033` are signed values in other projects (`int32sw` /
  `int16be`); `43022` (battery power) is an amount without sign – the template row `35214` *Battery power
  signed* (register 5214, newer firmware) carries the direction.

## Tests

```
npm test                                         # package check + unit tests (incl. simulated WiNet-S2)
IOB_CONTROLLER=latest npm run test:integration
npm run lint
```

`test/fakeWinet.js` simulates the WiNet-S2: one shared bus, latency and instruction interval per unit, swallowed
requests, late answers, total failure and connection loss.

## Changelog

<!--
	Placeholder for the next version (at the beginning of the line):
	### **WORK IN PROGRESS**
-->

### 0.3.0 (2026-10-24)

- Register template: 100 further known registers (74 input, 26 holding) from the Home Assistant integration by
  mkaiser (MIT) and the register list of the reference installation, unticked in the register tables; existing
  installations get them once on the first start (one restart). Nothing that was read before changes.
- New column *Read* (tick) and *Source / note*; readable data type names, factor choice with examples.
- New tab *Conversion helper*: addresses in all notations, interpretations of raw words, warnings, single test
  read (read only).
- New poll group `info` (3600 s) for device information; diagnostics only for groups that read registers.
- Hint in the log when the first value of a register is implausible for its unit.
- Fix: the round duration after a reconnect no longer contains the time without connection (was 26 640 904 ms
  after a night without gateway).
- Fix: no more warning "setTimeout called, but adapter is shutting down" when the instance stops.

### 0.2.1 (2026-10-23)

- First public release (functionally the same as 0.2.0): published on GitHub and npm.
- Default register tables in English (object names and plain texts), no default room.
- Control registers with plain text use the role `level` (`level.mode` is not a valid role).
- Admin UI translated into all languages.
- Every level of the state IDs exists as an object: a folder per register type and a device per Modbus unit
  (`inputRegisters.1`, `inputRegisters.2`, …); the state IDs are unchanged.

Older entries (versions before the first public release) are in [CHANGELOG_OLD.md](CHANGELOG_OLD.md).

## Trademark

Sungrow, WiNet and iSolarCloud are trademarks of Sungrow Power Supply Co., Ltd. This adapter is an independent
project and is neither affiliated with nor endorsed by Sungrow.

## License

MIT License

Copyright (c) 2026 Immanuel <github@freitag.online>

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the Software without restriction, including without limitation
the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and
to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of
the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO
THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF
CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
IN THE SOFTWARE.
