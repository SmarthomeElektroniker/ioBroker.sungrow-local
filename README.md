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
- js-controller >= 6.0.11, **admin >= 8.2.0** (the configuration page uses React components of the admin), Node.js >= 22.

## Configuration

The configuration page has six tabs. Everything works with mouse, keyboard and touch; drag & drop is always
optional (there is a button for every action).

1. **Overview** – traffic lights for instance, connection, last values and every poll group (last round, round
   duration, timeouts/errors/skipped rounds today) and live tiles: PV power, battery power with direction
   (sign of the battery current `43021`), battery level, grid (`35601`, + import / − feed-in), house consumption
   (calculated: AC output `43034` + grid; not clamped – an unmeasured generator in the house grid shows as
   "not balanceable") and any other register. Tiles can be added, removed and ordered.
   On a new instance (no address yet) the **setup wizard** opens here: gateway address, connection test (device
   type code → model, serial number, battery at the inverter, SBH battery at unit 2) and a profile
   *Basic / Battery / Extended* with a preview of the bus load.
2. **Registers** – the register catalog by topic (PV, battery, grid, inverter, control, info, own) with search.
   Activate a register with a click (into its default group, arrow = other group) or drag it into a poll group.
   Every group is a column with its interval and the requests it sends; the **bus load bar** (per group and in
   total) is calculated from the real block building of the adapter and shows *why* a register costs another
   request ("+1 request because 13050 is not next to the others"). **Own registers**: address in any notation
   (Sungrow document from 1, protocol from 0, column 30001/40001, Modicon) with off-by-one warning and a test
   read before saving.
3. **Control** – the writable holding registers. Writing is **released per register** (new in 0.4.0; existing
   installations keep their ticked registers writable), value range (min/max or value table), behaviour outside
   the range (warn or reject), the read-only master switch and the log of the last write commands
   (`info.write.log`).
4. **Connection** – address and port of the WiNet-S2; *Advanced* (folded): pauses, reconnect behaviour, write
   timeout/retries, block building, decimals and the bus capacity used for the load bars.
5. **Tools** – conversion helper (see below) and diagnostics of all groups in one table.
6. **Expert** – the plain tables (groups, input and holding registers) for bulk changes.

### Bus load model

The gateway handles about **1.25 requests per second** over a longer time (measured on the reference installation
SH20T + SBH400 behind a WiNet-S2): `live` 5 s + `energie` 60 s + `steuerung` 60 s + `akku` 120 s (1.14 requests/s)
ran stable, `live` 3 s (1.81/s) skipped rounds and `akku` 60 s produced timeouts. A request to a slow bus device
blocks the bus for its pause on top (SBH battery: 5 s). Load = requests per second / capacity + pause share; green
below 80 %, yellow up to 100 % (fully used), red above. A group whose interval is shorter than the pause of another
group will skip rounds. The capacity can be changed under *Connection → Advanced*.

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
    by Martin Kaiser, MIT License, © 2025 Martin Kaiser. Register addresses, data types, scaling and
    the value tables (device type codes, on/off codes, EMS and load adjustment modes) were taken from
    `modbus_sungrow.yaml`.
  - **reference list** – register list of the reference installation (SH20T + SBH400 via WiNet-S2), checked on
    the device; partly with notes (e.g. monthly yields: factor 0.1 measured, the document says 1).
- Grid code parameters (LVRT/HVRT, frequency/voltage protection, reactive power curves) are deliberately not
  part of the template – they are installer settings without documented scaling.

## Conversion helper

Sungrow documents, Home Assistant configurations and Modbus tools count addresses differently and describe
data types in different ways. The tab **Conversion helper** puts one register into all notations:

| Notation | Battery level | Max SoC | Rule | Used by |
|---|---|---|---|---|
| Sungrow document, column *Register* (counts from 1) | input 13023 | holding 13058 | – | Sungrow PDF, SunGather, openHAB binding (both subtract 1 before sending) |
| Protocol address (counts from 0, sent on the bus) | 13022 | 13057 | document − 1 | register lists "address incl. offset", Home Assistant / mkaiser `address: 13022  # reg 13023`, evcc, Loxone, ioBroker.modbus **without** aliases (the usual forum guide, IDs like `13022_Battery_level`) |
| Column *Address* of this adapter = ioBroker.modbus **with** aliases | 43023 | 53058 | protocol + 30001 / + 40001 | this adapter |
| Modicon, 6 digits | 313023 | 413058 | protocol + 300001 / + 400001 | Modbus tools |

- **The number is …:** choose the source of your number, or *detect automatically*: column (input ≥ 30001,
  holding ≥ 40001) and 6-digit Modicon numbers are unambiguous; a smaller number may count from 0 or from 1 –
  the helper then shows both readings with the register this adapter knows there and reads nothing.
- **Known register and off-by-one:** the helper names the register of your tables at the address and the
  neighbours you get when you count from 0 instead of 1 (column 43022 is *battery power*, 43023 *battery level*).
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

`<address>` is the *Address* column in the ioBroker.modbus alias notation: input register = 30001 + protocol
address, holding register = 40001 + protocol address – i.e. Sungrow document number + 30000 / + 40000 (battery level:
document 13023, protocol 13022, ID `43023_…`). `<name>` is the *name* column with spaces and dots replaced by `_`. The *description* column becomes the object name.

## Migration from ioBroker.modbus

The IDs, names, units, factors, data types and roles are built exactly like in ioBroker.modbus (with
*multi device ID* enabled), so the register tables of an existing instance can be copied into this adapter and
all state IDs stay the same apart from the instance prefix (`modbus.N.` → `sungrow-local.0.`).
This holds for instances with *aliases* switched on. Most Sungrow guides for ioBroker.modbus switch aliases
**off** and enter protocol addresses (IDs like `13022_Battery_level`): add 30001 (input) / 40001 (holding) to
those addresses – the IDs then change (`13022_…` → `43023_…`), scripts and history must be adapted.

One exception since 0.4.3: characters outside `[A-Za-z0-9_,-]` in the name column are replaced by `_` (umlauts
are transliterated), as ioBroker recommends for object IDs. ioBroker.modbus keeps e.g. the `/` of
`53051_Charge/discharge_command`; here the ID is `53051_Charge_discharge_command`. Replace these IDs as well.

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

- `35016` is the current of MPPT 3. Up to 0.3.0 the default row was named "MPPT 2 Current" (inherited from an old
  modbus configuration). New installations use `35016_MPPT_3_Current`; existing installations keep
  `35016_MPPT_2_Current` until the row is renamed in the register table (the old object can then be deleted).
- `43001` (running state) is a bit field and `43030` (grid state) is not clearly documented – both are shown as
  numbers without plain text (`43030` unscaled, factor 1).
- The upper limit 20000 W of `53052` (charge/discharge power) is an assumption for an SH20T; adjust it for other
  models.
- `43008` (load power) is read as `int32sw` and the phase currents `43031`–`43033` as `int16be` (signed, as in
  the Sungrow protocol); up to 0.3.0 they were unsigned, and `43030` had factor 0.1. Existing instances are
  corrected once on the first start, unless the row was changed by hand. The IDs stay the same.
- `43022` (battery power) is an amount without sign – the sign of `43021` (battery current) or the template row
  `35214` *Battery power signed* (register 5214, newer firmware) carries the direction.
- `43023` (battery level) is the usable level between min. and max. SoC; the battery's own level is `40744`
  (unit 2). Both agree as `40744 ≈ min SoC + 43023 × (max SoC − min SoC) / 100` as long as the level is inside the
  window.

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
### 0.4.3 (2026-10-25)

- State IDs only contain the characters recommended by ioBroker (`[A-Za-z0-9_,-]`): other characters of the
  name column (e.g. `/`) become `_`, umlauts are transliterated. Affected defaults:
  `holdingRegisters.1.53051_Charge_discharge_command`, `53052_Charge_discharge_power`,
  `70230_Manual_Scanning_-_ON_OFF`, `72535_Zustand_Netzanschluss_-_ON_OFF`. Existing objects are migrated on the
  first start: custom settings (history/sql/influxdb with `aliasId` = old ID, so the recorded data goes on), the
  last value and the rooms/functions move to the new ID, the old object is deleted. **Switch scripts and
  visualisations to the new IDs** (the log lists them).
- The role `level.mode` of older configurations (not in the ioBroker role list) becomes `level` (template v6).
- vis template *Akku*: register 53051 is labelled "Zwangsbefehl (nur im Zwangsmodus)" - it only acts in the EMS
  forced mode.
- Poller: no variable named `wait` (repository checker W5051); the pause between requests stays on the adapter
  timers, because stopping must end it immediately.

### 0.4.2 (2026-10-25)

- When stopping, the connection is closed without waiting (no plain timer during shutdown).
- Admin: sizes for large screens in the tab *Tools*; Dutch text completed.
- README: formula of the house consumption tile (AC output 43034 + grid).

### 0.4.1 (2026-10-25)

- Register objects are created without a default value: before the first read there is no state
  (previously 0 with ack=true, so scripts could react on e.g. SoC 0 % at adapter start). The default value
  is removed from existing objects; IDs, custom settings and values stay.
- Debug log line for every incoming command.
- Tests: the EMS command test waits until the adapter is ready (was flaky on slow Windows CI runners).

### 0.4.0 (2026-10-25)

- New configuration page with React components (admin >= 8.2): overview with traffic lights and live tiles,
  register catalog by topic with search, drag & drop into poll groups and a live bus load per group and in
  total (from the real block building, with the reason for every extra request), own registers in any address
  notation with test read, setup wizard (connection test, model detection, profile), tab *Control*, tab
  *Tools* with conversion helper and diagnostics, tab *Expert* with the plain tables.
- Register catalog: 187 further known registers (109 input, 78 holding: Sungrow protocol V1.1.11, register list
  of the reference installation, Home Assistant integration by mkaiser), every register with a name and a
  description in 11 languages; object names are translated as long as the description column is unchanged.
- Writing is released per holding register (`allowWrite`); a write to a register that is not released is
  rejected and the device value restored. Existing installations keep their ticked registers writable
  (template version 3). New option: reject values outside the range instead of only warning.
- Write log `info.write.log` (last 25 write commands with result).
- A too short answer (fewer registers than requested) discards the whole block and counts as an answer, not as a
  connection error.
- Messages for the admin: `probe` (test read, FC3/FC4 only), `wizardTest`, `analyse`.
- Value tables of writable registers (EMS mode, charge/discharge command, backup, load control, forced charging,
  on/off switches – 24 registers) in 11 languages: the states appear as a selection in admin/vis/apps, the tab
  *Control* offers them as a menu with a short explanation per mode and writes only after a confirmation. With
  "reject" a value outside the table is not written (template version 4 adds missing tables; own texts stay).
- Uniform register names (one term per quantity; "(from inverter)" / "(from BMS)" / "(from meter)" where the same
  quantity comes from two sources; pairs are shown next to each other). IDs do not change; object names follow the
  catalog as long as the description column still holds a former default text.
- Nearly constant values (nominal power, battery health, battery capacity, installed PV power, battery net capacity,
  rated load power) are read in the group `info` (hourly); existing instances move them once if the row still has the
  default group (template version 5).
- Read test of every template register on an SH20T behind a WiNet-S2: 67 addresses are rejected there ("illegal data
  address") and are marked in the catalog; the log explains a request that fails for this reason.
- Fix: battery direction. A positive battery current (43021) means **discharging** (verified with 4 days of history
  and raw reads); the overview and the vis templates showed it inverted. House consumption = AC output (43034) +
  meter (35601); a result clearly below zero (a generator the inverter does not measure) is shown as
  "not balanceable" instead of 0 W.

### 0.3.0 (2026-10-24)

- Register template: 100 further known registers (74 input, 26 holding) from the Home Assistant integration by
  mkaiser (MIT) and the register list of the reference installation, unticked in the register tables; existing
  installations get them once on the first start (one restart). Nothing that was read before changes.
- New column *Read* (tick) and *Source / note*; readable data type names, factor choice with examples.
- New tab *Conversion helper*: addresses in all notations (Sungrow document from 1, protocol address from 0 as in
  register lists / Home Assistant / evcc / ioBroker.modbus without aliases, column of this adapter, 6-digit
  Modicon) with automatic detection where unambiguous, the known register at the address and its off-by-one
  neighbours, interpretations of raw words, warnings, single test read (read only).
- New poll group `info` (3600 s) for device information; diagnostics only for groups that read registers.
- Hint in the log when the first value of a register is implausible for its unit.
- Fix: the round duration after a reconnect no longer contains the time without connection (was 26 640 904 ms
  after a night without gateway).
- Fix: no more warning "setTimeout called, but adapter is shutting down" when the instance stops.
- Fix: `43008` load power is signed (`int32sw`), phase currents `43031`–`43033` are signed (`int16be`), `43030`
  grid state is unscaled (factor 1). Existing instances get the correction once (template version 2) unless
  the row was edited.

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
