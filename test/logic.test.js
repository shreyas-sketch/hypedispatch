// Run: node test/logic.test.js  (no WhatsApp or API key needed)
import assert from 'assert';
import http from 'http';
import { phaseFor, nowParts, prettyDate } from '../src/time.js';
import { validate, fallback, withLinks, fetchPageText, composeMessage, toWhatsApp } from '../src/ai.js';

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
const good = '🤖 Imagine walking away with 3 AI automations you built yourself.\n\nNot watched. *Built.* By you, live, in one evening.\n\nThat is the whole point of *AI Income Workshop* 🔥\n\nReal builds. Zero fluff. A room full of people figuring it out with you.\n\n✨ Bring your laptop and that idea you have been sitting on.\n\nYou are in. Now show up!\n\n*Sunday, 7 PM IST*. See you there! 🚀';
assert.deepEqual(validate(good, ws, 'hype'), []);
assert.ok(validate(good.replace('3 AI', '10 AI'), ws, 'hype').some((i) => i.includes('"10"')), 'invented number caught');
assert.ok(validate('Only 3 days left!! ' + good, ws, 'hype').some((i) => i.includes('countdown')), 'countdown caught');
assert.ok(validate(good + ' https://x.com', ws, 'hype').some((i) => i.includes('link')), 'link caught');
assert.ok(validate(good.replace('7 PM', '8 PM'), ws, 'hype').some((i) => i.includes('"8"')), 'wrong time caught');
assert.deepEqual(validate('1️⃣ ' + good, ws, 'hype'), [], 'keycap emoji ignored');

assert.ok(validate(good.replace('Sunday', 'Saturday'), ws, 'hype').some((i) => i.includes('saturday')), 'wrong weekday caught');

// Length and emojis
assert.ok(validate('🚀 Short and sweet message that is way too short. ✨', ws, 'hype').some((i) => i.includes('too short')), 'short caught');
assert.ok(validate(good.replace(/\p{Extended_Pictographic}/gu, ''), ws, 'hype').some((i) => i.includes('emojis')), 'no emojis caught');

// Formatting: needs bold, and stray markdown is turned into WhatsApp formatting
assert.ok(validate(good.replace(/\*/g, ''), ws, 'hype').some((i) => i.includes('bold')), 'no bold caught');
assert.equal(toWhatsApp('*A Workshop* is moving to *Tuesday, 6 October*'), '*A Workshop* is moving to *Tuesday, 6 October*', 'text between bold parts untouched');
assert.equal(toWhatsApp('## Big news\n**AI Income Workshop** is on [our site](https://x.com)\n\n\n\nSee you'), 'Big news\n*AI Income Workshop* is on our site\n\nSee you');

// Already-joined audience: no price, no "register", short paragraphs
assert.ok(validate(good + ' All this for just ₹99!', ws, 'hype').some((i) => i.includes('price')), 'price caught');
assert.ok(validate(good.replace('You are in. Now show up!', 'Register now and show up!'), ws, 'hype').some((i) => i.includes('register')), 'selling caught');
assert.ok(validate(good.replace('\n\nReal builds.', ' Real builds.').replace('\n\nNot watched.', ' Not watched.').replace('\n\nThat is', ' That is'), ws, 'hype').some((i) => i.includes('paragraph')), 'long paragraph caught');
{
  const { withoutPrice } = await import('../src/workshop.js');
  const f = withoutPrice({ title: 'X', price_text: '₹99 only', other_key_facts: ['Just ₹99 today', '3 live case studies', 'Usual fee Rs 4999'], bonuses: ['Free templates'] });
  assert.equal(f.price_text, undefined);
  assert.deepEqual(f.other_key_facts, ['3 live case studies']);
  assert.deepEqual(f.bonuses, ['Free templates']);
}
for (const p of ['hype', 'tomorrow', 'dayof', 'reschedule']) {
  const t = fallback({ ...ws, factSheet: { ...ws.factSheet, old_date_text: 'Saturday, 3 October', host: 'Akshat Dani' } }, p);
  const longest = Math.max(...t.split(/\n\s*\n/).map((x) => x.split(/\s+/).filter(Boolean).length));
  assert.ok(longest <= 25, `${p} template has short paragraphs (${longest})`);
  assert.ok(!/regist|₹|price/i.test(t), p);
}

// Numbers must match whole: "10" is not accepted because the fact sheet says "100"
const ws100 = { ...ws, factSheet: { ...ws.factSheet, other_key_facts: ['100+ students trained'] } };
assert.ok(validate(good.replace('3 AI', '10 AI'), ws100, 'hype').some((i) => i.includes('"10"')), 'part of a bigger number is not enough');
assert.deepEqual(validate(good.replace('3 AI', '100 AI'), ws100, 'hype'), [], 'exact number allowed');
const wsPrice = { ...ws, factSheet: { ...ws.factSheet, price_text: '₹1,999', list: [1, 2] } };
assert.deepEqual(validate(good + ' 1999 of us.', wsPrice, 'hype'), [], '1,999 and 1999 match');
assert.ok(validate(good.replace('3 AI', '12 AI'), wsPrice, 'hype').some((i) => i.includes('"12"')), 'numeric array [1,2] is not read as 12');

// Links added by code only
assert.ok(withLinks('x', ws, 'tomorrow').includes(ws.formLink) && withLinks('x', ws, 'tomorrow').includes(ws.zoomLink));
assert.ok(withLinks('x', ws, 'hype').includes(ws.formLink) && !withLinks('x', ws, 'hype').includes(ws.zoomLink), 'hype: form only');
assert.ok(withLinks('x', ws, 'reschedule').includes(ws.formLink) && !withLinks('x', ws, 'reschedule').includes(ws.zoomLink), 'reschedule: form only');
assert.equal(withLinks('x', { ...ws, formLink: '' }, 'hype'), 'x', 'no form link set: nothing added');
// Signature is always the very last thing, after the links
const signed = withLinks('x', { ...ws, signature: '*Team Akshat Dani*\nakshatdani.com' }, 'tomorrow');
assert.ok(signed.endsWith('🎥 *Zoom link:*\nhttps://zoom.us/j/123\n\n*Team Akshat Dani*\nakshatdani.com'), signed);
assert.ok(signed.includes('🎁 *Unlock your surprise bonus:*\nhttps://forms.gle/abc'), signed);
assert.ok(withLinks('x', { ...ws, signature: '*Team X*' }, 'dayof').endsWith('*Team X*'));
assert.ok(withLinks('x', ws, 'dayof').includes(ws.zoomLink) && !withLinks('x', ws, 'dayof').includes(ws.formLink));

// Fallback templates stay factual
for (const p of ['hype', 'tomorrow', 'dayof']) {
  const f = fallback(ws, p);
  assert.ok(f.includes('AI Income Workshop'), p);
  assert.ok(!/https?:/.test(f), 'templates never contain links themselves');
}
assert.ok(fallback(ws, 'hype').includes('tailor the workshop to you, and unlock your *surprise bonus*'));
assert.ok(!/regist/i.test(fallback(ws, 'hype') + fallback(ws, 'tomorrow') + withLinks('x', ws, 'hype')), 'never called a registration form');
assert.ok(fallback(ws, 'tomorrow').includes('unlock your *surprise bonus*, and save the Zoom link'));
assert.ok(fallback(ws, 'dayof').includes('Zoom link below') && !fallback(ws, 'dayof').includes('orm'));
assert.ok(!fallback({ ...ws, formLink: '' }, 'hype').includes('below'), 'no form link: no "below" line');

// With a bad key / unreachable API, pipeline falls back instead of crashing (offline, so the test is fast)
process.env.ANTHROPIC_API_KEY = 'sk-bad';
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:9';
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
