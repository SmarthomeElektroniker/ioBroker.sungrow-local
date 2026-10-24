const path = require('node:path');
const assert = require('node:assert');
const { tests } = require('@iobroker/testing');
const { createFakeWinet } = require('./fakeWinet');
const io = require('../io-package.json');
const { CATALOG } = require('../lib/catalog');

// Starts a temporary js-controller, installs the adapter and runs it against a simulated WiNet-S2.
// Locally: IOB_CONTROLLER=latest npm run test:integration
tests.integration(path.join(__dirname, '..'), {
    controllerVersion: process.env.IOB_CONTROLLER || undefined,

    defineAdditionalTests({ suite }) {
        suite('Against a simulated WiNet-S2', getHarness => {
            let fake;
            before(async () => {
                fake = await createFakeWinet({
                    units: { 1: { latency: 10, busTimeout: 300 }, 2: { latency: 40, busGap: 300, busTimeout: 500 } },
                });
                fake.set(1, 'input', 5016, [70000 & 0xffff, 70000 >>> 16]); // 35017 Total DC Power
                fake.set(1, 'input', 13022, [955]); // 43023 Battery level (WR) 95.5 %
                fake.set(1, 'input', 13002, [12345 & 0xffff, 12345 >>> 16]); // 43003 Total PV Generation 1234.5 kWh
                fake.set(2, 'input', 10743, [970]); // 40744 Battery level 97 %
                fake.set(1, 'holding', 33030, [1000]); // 73031 Max SOC 100 %
            });
            after(async () => {
                await fake.close();
            });

            it('same IDs as an ioBroker.modbus instance, values per group, unit-2 timeouts isolated, confirmed writes, diagnostics', async function () {
                this.timeout(90000);
                const harness = getHarness();
                await harness.changeAdapterConfig('sungrow-local', {
                    native: {
                        ...io.native,
                        host: fake.host,
                        port: fake.port,
                        requestGap: 20,
                        reconnectDelay: 1,
                        writeTimeout: 1500,
                        groups: [
                            { enabled: true, name: 'live', interval: 1, timeout: 800, pauseAfter: 0 },
                            { enabled: true, name: 'energie', interval: 3, timeout: 800, pauseAfter: 0 },
                            { enabled: true, name: 'steuerung', interval: 3, timeout: 800, pauseAfter: 0 },
                            { enabled: true, name: 'akku', interval: 2, timeout: 1000, pauseAfter: 300 },
                        ],
                    },
                });
                await harness.startAdapterAndWait();
                const ns = 'sungrow-local.0';
                const waitFor = async (id, pred, ms = 20000, needAck = true) => {
                    const end = Date.now() + ms;
                    for (;;) {
                        const s = await harness.states.getStateAsync(`${ns}.${id}`);
                        if (s && (!needAck || s.ack) && pred(s.val, s)) {
                            return s;
                        }
                        if (Date.now() > end) {
                            throw new Error(`${id} did not reach the expected value, last: ${JSON.stringify(s)}`);
                        }
                        await new Promise(r => setTimeout(r, 200));
                    }
                };

                await waitFor('info.connection', v => v === true);
                await waitFor('inputRegisters.1.35017_Total_DC_Power', v => v === 70000);
                await waitFor('inputRegisters.1.43023_Battery_level', v => v === 95.5);
                await waitFor('inputRegisters.1.43003_Total_PV_Generation', v => v === 1234.5);
                await waitFor('inputRegisters.2.40744_Battery_level', v => v === 97);
                await waitFor('holdingRegisters.1.73031_Max_SOC', v => v === 100);

                // objects like ioBroker.modbus: name = description, unit, role, holding writable
                const soc = await harness.objects.getObjectAsync(`${ns}.inputRegisters.2.40744_Battery_level`);
                assert.deepStrictEqual(
                    [
                        soc.common.name,
                        soc.common.unit,
                        soc.common.role,
                        soc.common.write,
                        soc.native.address,
                        soc.native.deviceId,
                    ],
                    ['Battery module SoC', '%', 'value.battery', false, 10743, 2],
                );
                const charge = await harness.objects.getObjectAsync(
                    `${ns}.holdingRegisters.1.53051_Charge/discharge_command`,
                );
                assert.strictEqual(charge.common.write, true);
                // 0.2.0: plain text for status/control registers, limits for set points, MPPT 3 display name
                assert.strictEqual(charge.common.states['187'], 'Discharge (0xBB)');
                const maxSoc = await harness.objects.getObjectAsync(`${ns}.holdingRegisters.1.73031_Max_SOC`);
                assert.deepStrictEqual([maxSoc.common.min, maxSoc.common.max, maxSoc.common.role], [0, 100, 'level']);
                const mppt3 = await harness.objects.getObjectAsync(`${ns}.inputRegisters.1.35016_MPPT_2_Current`);
                assert.deepStrictEqual([mppt3.common.name, mppt3.common.role], ['MPPT3 current', 'value.current']);
                // 0.2.1: every level of the ID exists as an object (folder per register type, device per unit)
                const unit2 = await harness.objects.getObjectAsync(`${ns}.inputRegisters.2`);
                const folder = await harness.objects.getObjectAsync(`${ns}.holdingRegisters`);
                assert.deepStrictEqual([unit2.type, unit2.common.name, folder.type], ['device', 'Unit 2', 'folder']);

                // heartbeat per group, also without value changes (the fake values never change)
                const r1 = await waitFor('info.groups.live.lastRound', v => v > 0);
                await waitFor('info.groups.live.lastRound', v => v > r1.val, 5000);
                await waitFor('info.groups.live.lastRoundText', v => /^\d\d:\d\d:\d\d \(\d+ ms\)$/.test(v));
                await waitFor('info.lastValueUpdate', v => Date.now() - v < 3000);
                const chLive = await harness.objects.getObjectAsync(`${ns}.info.groups.live`);
                assert.strictEqual(chLive.common.name.de.startsWith('Abfragegruppe live'), true);
                const skippedObj = await harness.objects.getObjectAsync(`${ns}.info.groups.live.skippedToday`);
                assert.strictEqual(typeof skippedObj.common.name, 'object');
                assert.ok(skippedObj.common.name.de.startsWith('Übersprungene Runden'));
                const list = await harness.objects.getObjectListAsync({
                    startkey: `${ns}.inputRegisters.`,
                    endkey: `${ns}.inputRegisters.\u9999`,
                });
                const ids = list.rows.map(r => r.id);
                assert.strictEqual(ids.filter(i => /\.\d+_/.test(i)).length, 68);

                // unit 2 stops answering: only the battery group fails, unit 1 goes on, no reconnect
                fake.drop(2, 3);
                await waitFor('info.groups.akku.timeoutsToday', v => v >= 3, 30000);
                const live = await harness.states.getStateAsync(`${ns}.info.groups.live.lastSuccess`);
                assert.ok(Date.now() - live.val < 3000, 'live group still answers');
                assert.strictEqual((await harness.states.getStateAsync(`${ns}.info.groups.live.timeoutsToday`)).val, 0);
                assert.strictEqual((await harness.states.getStateAsync(`${ns}.info.connection`)).val, true);
                const rc = await harness.states.getStateAsync(`${ns}.info.reconnects`);
                assert.ok(!rc || !rc.val, 'no reconnect');
                assert.strictEqual(fake.state.connections, 1, 'one connection only');
                assert.ok(
                    (await harness.states.getStateAsync(`${ns}.info.groups.akku.lastError`)).val.includes('10740'),
                );

                // write with confirmation: ack only after the read-back
                await harness.states.setStateAsync(`${ns}.holdingRegisters.1.73031_Max_SOC`, { val: 95, ack: false });
                await waitFor('holdingRegisters.1.73031_Max_SOC', v => v === 95);
                assert.strictEqual(fake.state.units[1].holding.get(33030), 950);
                const w = fake.state.requests.filter(r => r.fc === 6 && r.addr === 33030);
                assert.strictEqual(w.length, 1);

                // same value again: must still end with ack=true
                await harness.states.setStateAsync(`${ns}.holdingRegisters.1.73031_Max_SOC`, { val: 95, ack: false });
                await waitFor('holdingRegisters.1.73031_Max_SOC', (v, s) => v === 95 && s.ack, 10000);
                assert.strictEqual(fake.state.requests.filter(r => r.fc === 6 && r.addr === 33030).length, 2);
                await waitFor('info.write.okTotal', v => v >= 4);

                // implausible value (above max): the check only warns, the value is still written (0.2.0)
                await harness.states.setStateAsync(`${ns}.holdingRegisters.1.73031_Max_SOC`, { val: 150, ack: false });
                await waitFor('holdingRegisters.1.73031_Max_SOC', (v, s) => v === 150 && s.ack, 10000);
                assert.strictEqual(fake.state.units[1].holding.get(33030), 1500);

                // input registers are read-only: a foreign write is reset
                await harness.states.setStateAsync(`${ns}.inputRegisters.1.35017_Total_DC_Power`, {
                    val: 1,
                    ack: false,
                });
                await waitFor('inputRegisters.1.35017_Total_DC_Power', v => v === 70000, 5000);
            });
        });

        suite('Register template and conversion helper (0.3.0)', getHarness => {
            let fake;
            before(async () => {
                fake = await createFakeWinet({ units: { 1: { latency: 10 }, 2: { latency: 10 } } });
                fake.set(1, 'input', 5016, [70000 & 0xffff, 70000 >>> 16]); // 35017 Total DC Power
                fake.set(1, 'input', 13021, [0xfe70]); // 43022 Battery power (raw -400)
            });
            after(async () => {
                await fake.close();
            });

            it('a 0.2.x configuration gets the template once (unticked), reads the same registers, helper answers', async function () {
                this.timeout(90000);
                const harness = getHarness();
                // configuration of an instance before 0.3.0: no enabled flags, no template rows, no catalogVersion
                const old = JSON.parse(JSON.stringify(io.native));
                for (const t of ['inputRegs', 'holdingRegs']) {
                    old[t] = old[t]
                        .filter(r => !r.source)
                        .map(r => {
                            const c = { ...r };
                            delete c.enabled;
                            return c;
                        });
                }
                // replace the whole configuration (changeAdapterConfig would merge the arrays row by row)
                const instObj = await harness.objects.getObjectAsync('system.adapter.sungrow-local.0');
                instObj.native = {
                    ...old,
                    host: fake.host,
                    port: fake.port,
                    requestGap: 20,
                    groups: [{ enabled: true, name: 'live', interval: 1, timeout: 800, pauseAfter: 0 }],
                };
                await harness.objects.setObjectAsync('system.adapter.sungrow-local.0', instObj);
                await harness.enableSendTo();
                await harness.startAdapterAndWait();
                const ns = 'sungrow-local.0';
                const end = Date.now() + 30000;
                let inst;
                for (;;) {
                    inst = await harness.objects.getObjectAsync(`system.adapter.${ns}`);
                    if (inst.native.templateVersion === CATALOG.version || Date.now() > end) {
                        break;
                    }
                    await new Promise(r => setTimeout(r, 300));
                }
                assert.strictEqual(inst.native.templateVersion, CATALOG.version);
                assert.strictEqual(inst.native.inputRegs.length, 68 + 74);
                assert.strictEqual(inst.native.inputRegs.filter(r => r.enabled).length, 68);
                assert.ok(inst.native.groups.some(g => g.name === 'info'));

                // after the restart: values as before, no data point for unticked template rows
                const until = async (fn, ms = 30000) => {
                    const stop = Date.now() + ms;
                    for (;;) {
                        const v = await fn();
                        if (v || Date.now() > stop) {
                            return v;
                        }
                        await new Promise(r => setTimeout(r, 300));
                    }
                };
                const dc = await until(async () => {
                    const st = await harness.states.getStateAsync(`${ns}.inputRegisters.1.35017_Total_DC_Power`);
                    return st && st.ack && st.val === 70000 ? st : null;
                });
                assert.ok(dc, 'value after the migration');
                const list = await harness.objects.getObjectListAsync({
                    startkey: `${ns}.inputRegisters.`,
                    endkey: `${ns}.inputRegisters.\u9999`,
                });
                assert.strictEqual(list.rows.map(r => r.id).filter(i => /\.\d+_/.test(i)).length, 68);
                assert.ok(!(await harness.objects.getObjectAsync(`${ns}.inputRegisters.1.35000_Device_type_code`)));

                // conversion helper: reads register 13022 (document numbering) once and explains it
                const answer = await new Promise(resolve =>
                    harness.sendTo(
                        ns,
                        'convert',
                        {
                            addrMode: 'doc',
                            address: '13022',
                            regType: 'inputRegs',
                            deviceId: '1',
                            type: 'uint16be',
                            factor: '1',
                            unitText: 'W',
                            live: 'true',
                        },
                        resolve,
                    ),
                );
                assert.match(answer.text, /43022/);
                assert.match(answer.text, /0xFE70/);
                assert.match(answer.text, /-400 W/);
                assert.strictEqual(
                    fake.count(r => r.fc === 6 || r.fc === 16),
                    0,
                    'the helper never writes',
                );
            });
        });

        suite('Read-only mode', getHarness => {
            let fake;
            before(async () => {
                fake = await createFakeWinet({ units: { 1: { latency: 10 }, 2: { latency: 10 } } });
                fake.set(1, 'holding', 33030, [950]); // 73031 Max SOC 95 %
            });
            after(async () => {
                await fake.close();
            });

            it('read-only mode rejects writes and restores the device value', async function () {
                this.timeout(60000);
                const harness = getHarness();
                await harness.changeAdapterConfig('sungrow-local', {
                    native: {
                        ...io.native,
                        host: fake.host,
                        port: fake.port,
                        readOnly: true,
                        requestGap: 20,
                        groups: [{ enabled: true, name: 'steuerung', interval: 1, timeout: 800, pauseAfter: 0 }],
                    },
                });
                await harness.startAdapterAndWait();
                const id = 'sungrow-local.0.holdingRegisters.1.73031_Max_SOC';
                const before = fake.state.units[1].holding.get(33030);
                const end = Date.now() + 15000;
                let s;
                while (Date.now() < end) {
                    s = await harness.states.getStateAsync(id);
                    if (s && s.ack && s.val === before / 10) {
                        break;
                    }
                    await new Promise(r => setTimeout(r, 200));
                }
                const writes = fake.count(r => r.fc === 6);
                await harness.states.setStateAsync(id, { val: 50, ack: false });
                await new Promise(r => setTimeout(r, 2500));
                s = await harness.states.getStateAsync(id);
                assert.deepStrictEqual([s.val, s.ack], [before / 10, true]);
                assert.strictEqual(
                    fake.count(r => r.fc === 6),
                    writes,
                    'nothing written',
                );
            });
        });
    },
});
