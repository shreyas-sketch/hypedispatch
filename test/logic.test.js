// Run: node test/logic.test.js  (no WhatsApp or API key needed)
import assert from 'assert';
import http from 'http';
import { phaseFor, nowParts, prettyDate } from '../src/time.js';
import { validate, fallback, withLinks, fetchPageText, composeMessage } from '../src/ai.js';

const ws = {
  id: 't1', name: 'Test', date: '2026-10-04', startTime: '19:00', timeLabel: '7 PM IST', dayOf: true,
  zoomLink: 'https://zoom.us/j/123', formLink: 'https://forms.gle/abc',
  factSheet: { title: 'AI Income Workshop', date_text: 'Sunday, 4 October', time_text: '7 PM IST', what_youll_learn: ['Build 3 AI automations'], price_text: '$9.99' },
};

// Phases for an Oct 4 workshop
const expect = { '2026-09-30': 'hype', '2026-10-01': 'hype', '2026-10-02': 'hype', '2026-10-03': 'tomorrow', '2026-10-04': 'dayof', '2026-10-05': null };
for (const [d, p] of Object.entries(expect)) assert.equal(phaseFor(ws, d).phase, p, d);
assert.equal(phaseFor({ ...ws, dayOf: false }, '2026-10-04').phase, null);

// IST conversion: 2026-09-30 20:00 UTC = Oct 1 01:30 IST
assert.deepEqual(nowParts(new Date('2026-09-30T20:00:00Z')), { date: '2026-10-01', hm: '01:30' });

// Validator
const good = 'Imagine walking away from one evening with 3 AI automations you actually built yourself 🤖\n\nThat is the whole point of *AI Income Workshop*. Real builds, zero fluff, and a room full of people figuring it out with you. Sunday, 7 PM IST. Bring your curiosity!';
assert.deepEqual(validate(good, ws, 'hype'), []);
assert.ok(validate(good.replace('3 AI', '10 AI'), ws, 'hype').some((i) => i.includes('"10"')), 'invented number caught');
assert.ok(validate('Only 3 days left!! ' + good, ws, 'hype').some((i) => i.includes('countdown')), 'countdown caught');
assert.ok(validate(good + ' https://x.com', ws, 'hype').some((i) => i.includes('link')), 'link caught');
assert.ok(validate(good.replace('7 PM', '8 PM'), ws, 'hype').some((i) => i.includes('"8"')), 'wrong time caught');
assert.deepEqual(validate('1️⃣ ' + good, ws, 'hype'), [], 'keycap emoji ignored');

assert.ok(validate(good.replace('Sunday', 'Saturday'), ws, 'hype').some((i) => i.includes('saturday')), 'wrong weekday caught');

// Links added by code only
assert.ok(withLinks('x', ws, 'tomorrow').includes(ws.formLink) && withLinks('x', ws, 'tomorrow').includes(ws.zoomLink));
assert.ok(!withLinks('x', ws, 'hype').includes('http'));
assert.ok(withLinks('x', ws, 'dayof').includes(ws.zoomLink) && !withLinks('x', ws, 'dayof').includes(ws.formLink));

// Fallback templates stay factual
for (const p of ['hype', 'tomorrow', 'dayof']) {
  const f = fallback(ws, p);
  assert.ok(f.includes('AI Income Workshop'), p);
}

// With a bad key, pipeline falls back instead of crashing
process.env.ANTHROPIC_API_KEY = 'sk-bad';
const out = await composeMessage(ws, 'tomorrow', []);
assert.equal(out.source, 'fallback');

// Landing page reader
const html = `<html><head><title>AI Income Workshop</title><script>var x=1</script></head><body>
<nav>Home</nav><h1>AI Income Workshop</h1><p>Live on Zoom · Saturday 4 October · 7 PM IST</p>
<ul><li>Build 3 AI automations</li><li>Price: $9.99</li></ul>${[...Array(10)].map((_, i) => '<p>Detail paragraph number ' + i + ' about the workshop agenda.</p>').join('')}<footer>Home</footer></body></html>`;
const srv = http.createServer((q, r) => r.end(html)).listen(0);
const text = await fetchPageText(`http://127.0.0.1:${srv.address().port}/`);
srv.close();
assert.ok(text.includes('Build 3 AI automations') && !text.includes('var x'));

console.log('All logic tests passed ✓');
console.log('\nSample fallback (tomorrow):\n' + withLinks(fallback(ws, 'tomorrow'), ws, 'tomorrow'));
