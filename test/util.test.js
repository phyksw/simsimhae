import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseKoDate, parseCount, absUrl, hostMatches } from '../src/lib/util.js';
import { cleanHtml, htmlToText } from '../src/reader.js';

const NOW = new Date('2026-10-17T03:00:00Z'); // KST 12:00

test('parseKoDate: 커뮤니티 날짜 표기 (KST)', () => {
  const cases = {
    '21:15': '2026-10-16T12:15:00.000Z', // 미래 → 어제
    '11:30': '2026-10-17T02:30:00.000Z',
    '10.16': '2026-10-15T15:00:00.000Z',
    '26.10.16': '2026-10-15T15:00:00.000Z',
    '2026.10.16. 21:15': '2026-10-16T12:15:00.000Z',
    '2026-10-16 21:15:00': '2026-10-16T12:15:00.000Z',
    '3분 전': '2026-10-17T02:57:00.000Z',
    '어제 21:15': '2026-10-16T12:15:00.000Z',
    '12.31': '2025-12-30T15:00:00.000Z', // 미래 → 작년
  };
  for (const [s, iso] of Object.entries(cases)) assert.equal(parseKoDate(s, NOW), iso, s);
  assert.equal(parseKoDate('', NOW), null);
  assert.equal(parseKoDate('아무말', NOW), null);
});

test('parseCount', () => {
  assert.equal(parseCount('1.2만'), 12000);
  assert.equal(parseCount('[12]'), 12);
  assert.equal(parseCount('1,234'), 1234);
  assert.equal(parseCount(''), null);
});

test('absUrl / hostMatches', () => {
  assert.equal(absUrl('//img.x.com/a.jpg', 'https://a.com/'), 'https://img.x.com/a.jpg');
  assert.equal(absUrl('javascript:alert(1)', 'https://a.com/'), null);
  assert.ok(hostMatches('dcimg8.dcinside.co.kr', ['dcinside.co.kr']));
  assert.ok(!hostMatches('evildcinside.co.kr', ['dcinside.co.kr']));
});

test('cleanHtml: 스크립트·이벤트 제거, 허용 호스트 이미지는 프록시로', () => {
  const src = { id: 'x', imageHosts: ['img.x.com'] };
  const out = cleanHtml(
    '<p onclick="alert(1)">hi<script>alert(1)</script></p><img src="https://img.x.com/a.jpg" onerror="x()"><img src="https://other.com/b.png"><a href="javascript:alert(1)">l</a><iframe src="https://evil.com/"></iframe><iframe src="https://www.youtube.com/embed/abc"></iframe>',
    src,
  );
  assert.ok(!/script|onclick|onerror|javascript:/i.test(out), out);
  assert.ok(out.includes('/api/img?s=x&amp;u=https%3A%2F%2Fimg.x.com%2Fa.jpg'), out);
  assert.ok(out.includes('referrerpolicy="no-referrer"'), out);
  assert.ok(!out.includes('evil.com'), out);
  assert.ok(out.includes('youtube.com/embed/abc'), out);
});

test('htmlToText: 줄바꿈 유지', () => {
  assert.equal(htmlToText('<p>첫 줄</p><p>둘째<br>셋째</p><img src="a">'), '첫 줄\n둘째\n셋째\n\n[이미지]');
});
