// Exercise the actual page script with a minimal DOM and HTTP test double.
// Run with: node --test tests/test_instruction_terminal.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../assets/host_interaction/server.py', import.meta.url), 'utf8')
    .split('<script>')[1].split('</script>')[0];

function page(mode = 'en', translate = text => `English: ${text}`) {
    const elements = new Map();
    const makeElement = () => ({
        value: '', disabled: true, checked: false, hidden: false, style: {}, children: [],
        classList: { add() {}, remove() {} },
        addEventListener() {}, focus() {}, remove() {}, setAttribute() {},
        appendChild(child) { this.children.push(child); },
    });
    const element = id => {
        if (!elements.has(id)) elements.set(id, makeElement());
        return elements.get(id);
    };
    let pending;
    let serverSchedule = { state: 'idle' };
    let now = 0;
    const submitted = [], bodies = [], calls = [];
    const context = vm.createContext({
        document: { getElementById: element, body: element('body'), createElement: makeElement },
        URLSearchParams, performance: { now: () => now }, setInterval() {}, setTimeout() {},
        fetch: async (url, options) => {
            calls.push(url);
            if (url === '/status') return { ok: true, json: async () => ({ waiting: true, history: [], schedule: serverSchedule }) };
            if (url === '/translate') {
                const translation = translate(options.body.get('text'));
                return { ok: Boolean(translation), json: async () => ({ translation, error: 'Translation unavailable' }) };
            }
            if (url === '/cancel_schedule') {
                serverSchedule = { state: 'cancelled', reason: 'user' };
                return { ok: true, json: async () => ({ cancelled: true }) };
            }
            submitted.push(options.body.get('instruction'));
            bodies.push(options.body);
            return new Promise(resolve => { pending = resolve; });
        },
    });
    vm.runInContext(source.replace('__MODE__', mode), context);
    return { context, element, submitted, bodies, calls, respond: response => pending(response),
        setSchedule: value => { serverSchedule = value; }, advance: ms => { now += ms; vm.runInContext('renderStopwatch()',context); } };
}

async function flush() { for (let i = 0; i < 20; i++) await Promise.resolve(); }
function enableTimer(p) {
    p.element('timedMode').checked = true;
    p.element('timedMode').onchange();
    return vm.runInContext('scheduleInputs', p.context);
}

test('successful submissions re-enable the terminal while the robot keeps polling', async () => {
    const p = page();
    vm.runInContext('setWaiting(true)', p.context);
    for (const instruction of ['first task', 'turn right']) {
        p.element('englishInstruction').value = instruction;
        const submission = p.element('cmdForm').onsubmit({ preventDefault() {} });
        await flush();
        assert.equal(p.element('submitBtn').disabled, true);
        p.respond({ ok: true, json: async () => ({ accepted: true }) });
        await submission;
        assert.equal(p.element('submitBtn').disabled, false);
        assert.equal(p.element('englishInstruction').disabled, false);
    }
    assert.deepEqual(p.submitted, ['first task', 'turn right']);
});

test('poll changes do not unlock a pending submission, and rejection allows retry', async () => {
    const p = page();
    vm.runInContext('setWaiting(true)', p.context);
    p.element('englishInstruction').value = 'new task';
    const submission = p.element('cmdForm').onsubmit({ preventDefault() {} });
    await flush();
    vm.runInContext('setWaiting(false); setWaiting(true)', p.context);
    assert.equal(p.element('submitBtn').disabled, true);
    await p.element('cmdForm').onsubmit({ preventDefault() {} });
    assert.equal(p.submitted.length, 1);
    p.respond({ ok: false, json: async () => ({ accepted: false, error: 'retry shortly' }) });
    await submission;
    assert.equal(p.element('submitBtn').disabled, false);
    assert.equal(p.element('statusLine').textContent, 'retry shortly');
});

test('timed mode sends the first instruction and all absolute offsets in one request', async () => {
    const p = page();
    await flush();
    p.element('englishInstruction').value = 'first task';
    const rows = enableTimer(p);
    rows[0].delay.value = '10'; rows[0].text.value = 'second task';
    p.element('addScheduleRow').onclick();
    rows[1].delay.value = '25'; rows[1].text.value = 'third task';
    const submission = p.element('cmdForm').onsubmit({ preventDefault() {} });
    await flush();
    assert.equal(rows[0].text.disabled, true);
    assert.deepEqual(JSON.parse(p.bodies[0].get('schedule')), [
        { after_seconds: 10, instruction: 'second task', chinese: '' },
        { after_seconds: 25, instruction: 'third task', chinese: '' },
    ]);
    p.respond({ ok: true, json: async () => ({ accepted: true }) });
    await submission;
    assert.deepEqual(p.submitted, ['first task']);
    assert.equal(rows[0].text.disabled, false);
});

test('invalid offsets or empty follow-ups prevent even the first instruction being sent', async () => {
    for (const delay of ['0', '-1', 'NaN', '86401']) {
        const p = page(); await flush();
        p.element('englishInstruction').value = 'first';
        const rows = enableTimer(p);
        rows[0].delay.value = delay; rows[0].text.value = 'next';
        await p.element('cmdForm').onsubmit({ preventDefault() {} });
        assert.equal(p.submitted.length, 0);
    }
    const p = page(); await flush();
    p.element('englishInstruction').value = 'first';
    const rows = enableTimer(p);
    await p.element('cmdForm').onsubmit({ preventDefault() {} });
    rows[0].text.value = 'next';
    p.element('addScheduleRow').onclick();
    rows[1].delay.value = '5'; rows[1].text.value = 'too soon';
    await p.element('cmdForm').onsubmit({ preventDefault() {} });
    assert.equal(p.submitted.length, 0);
});

test('Chinese follow-ups are translated before the initial instruction and timer are submitted', async () => {
    const p = page('cn'); await flush();
    p.element('chineseInstruction').value = '拿起杯子';
    const rows = enableTimer(p);
    rows[0].text.value = '把杯子放右边';
    const submission = p.element('cmdForm').onsubmit({ preventDefault() {} });
    await flush();
    assert.equal(p.submitted[0], 'English: 拿起杯子');
    assert.deepEqual(JSON.parse(p.bodies[0].get('schedule')), [
        { after_seconds: 10, instruction: 'English: 把杯子放右边', chinese: '把杯子放右边' },
    ]);
    assert.ok(p.calls.lastIndexOf('/translate') < p.calls.indexOf('/web_submit'));
    p.respond({ ok: true, json: async () => ({ accepted: true }) });
    await submission;
});

test('follow-up translation failure does not start a partial plan', async () => {
    const p = page('en', () => ''); await flush();
    p.element('englishInstruction').value = 'first';
    const rows = enableTimer(p);
    rows[0].language.value = 'zh'; rows[0].text.value = '下一条';
    await p.element('cmdForm').onsubmit({ preventDefault() {} });
    assert.equal(p.submitted.length, 0);
    assert.equal(p.element('statusLine').textContent, 'Translation unavailable');
    assert.equal(p.element('submitBtn').disabled, false);
});

test('refresh restores the server countdown and cancel does not submit any instruction', async () => {
    const p = page(); await flush();
    p.setSchedule({ state: 'running', remaining: 2, seconds_remaining: 4.5, next_instruction: 'next task' });
    await vm.runInContext('poll()', p.context);
    assert.equal(p.element('cancelSchedule').hidden, false);
    assert.match(p.element('scheduleStatus').textContent, /4.5/);
    assert.match(p.element('scheduleStatus').textContent, /next task/);
    await p.element('cancelSchedule').onclick();
    assert.equal(p.element('cancelSchedule').hidden, true);
    assert.match(p.element('scheduleStatus').textContent, /cancelled/);
    assert.equal(p.submitted.length, 0);
    assert.ok(p.calls.includes('/cancel_schedule'));
});

test('turning timed mode off keeps manual submissions free of future commands', async () => {
    const p = page(); await flush();
    p.element('englishInstruction').value = 'manual';
    const rows = enableTimer(p);
    rows[0].text.value = 'unused'; rows[0].delay.value = '-1';
    p.element('timedMode').checked = false; p.element('timedMode').onchange();
    assert.equal(p.element('scheduleEditor').hidden, true);
    assert.equal(rows[0].delay.disabled, true);
    const submission = p.element('cmdForm').onsubmit({ preventDefault() {} });
    await flush();
    assert.equal(p.bodies[0].get('schedule'), '[]');
    p.respond({ ok: true, json: async () => ({ accepted: true }) }); await submission;
});

test('armed plan shows waiting for key 1 and stopwatch stays at zero', async () => {
    const p=page('cn'); await flush();
    p.setSchedule({state:'armed',remaining:2,execution:{phase:'waiting',elapsed_seconds:0}});
    await vm.runInContext('poll()',p.context);
    p.advance(20000);
    assert.equal(p.element('stopwatchValue').textContent,'00:00.0');
    assert.match(p.element('scheduleStatus').textContent,/等待按 1/);
    assert.equal(p.element('cancelSchedule').hidden,false);
});

test('stopwatch interpolates confirmed elapsed time, survives plan completion, and freezes on stop', async () => {
    const p=page(); await flush();
    p.setSchedule({state:'completed',execution:{phase:'running',elapsed_seconds:61.2}});
    await vm.runInContext('poll()',p.context);
    assert.equal(p.element('stopwatchValue').textContent,'01:01.2');
    p.advance(300);
    assert.equal(p.element('stopwatchValue').textContent,'01:01.5');
    p.setSchedule({state:'cancelled',reason:'episode_changed',execution:{phase:'stopped',elapsed_seconds:62.7}});
    await vm.runInContext('poll()',p.context);
    p.advance(3000);
    assert.equal(p.element('stopwatchValue').textContent,'01:02.7');
    p.setSchedule({state:'idle',execution:{phase:'waiting',elapsed_seconds:0}});
    await vm.runInContext('poll()',p.context);
    assert.equal(p.element('stopwatchValue').textContent,'00:00.0');
});
