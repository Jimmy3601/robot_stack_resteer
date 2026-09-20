// Exercise the actual page script with a minimal DOM and HTTP test double.
// Run with: node --test tests/test_instruction_terminal.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../assets/host_interaction/server.py', import.meta.url), 'utf8')
    .split('<script>')[1].split('</script>')[0].replace('__MODE__', 'en');

function page() {
    const elements = new Map();
    const element = id => {
        if (!elements.has(id)) elements.set(id, {
            value: '', disabled: true, style: {}, classList: { add() {}, remove() {} },
            addEventListener() {}, focus() {}, appendChild() {},
        });
        return elements.get(id);
    };
    let pending;
    const submitted = [];
    const context = vm.createContext({
        document: { getElementById: element, body: element('body'), createElement: element },
        URLSearchParams, setInterval() {}, setTimeout() {},
        fetch: async (url, options) => {
            if (url === '/status') return { json: async () => ({ waiting: true, history: [] }) };
            submitted.push(options.body.get('instruction'));
            return new Promise(resolve => { pending = resolve; });
        },
    });
    vm.runInContext(source, context);
    return { context, element, submitted, respond: response => pending(response) };
}

test('successful submissions re-enable the terminal while the robot keeps polling', async () => {
    const p = page();
    vm.runInContext('setWaiting(true)', p.context);
    for (const instruction of ['first task', 'turn right']) {
        p.element('englishInstruction').value = instruction;
        const submission = p.element('cmdForm').onsubmit({ preventDefault() {} });
        await Promise.resolve();
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
    await Promise.resolve();
    vm.runInContext('setWaiting(false); setWaiting(true)', p.context);
    assert.equal(p.element('submitBtn').disabled, true);
    await p.element('cmdForm').onsubmit({ preventDefault() {} });
    assert.equal(p.submitted.length, 1);
    p.respond({ ok: false, json: async () => ({ accepted: false, error: 'retry shortly' }) });
    await submission;
    assert.equal(p.element('submitBtn').disabled, false);
    assert.equal(p.element('statusLine').textContent, 'retry shortly');
});
