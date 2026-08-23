import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { elementTypeOf, gradeValue, parseGradeValue, renderValue, sampleCard } from '../lib/templates';

const page = readFileSync(join(process.cwd(), 'app/page.tsx'), 'utf8');
const route = readFileSync(join(process.cwd(), 'app/api/prices/graded/route.ts'), 'utf8');

test('grade element type is detected from value', () => {
  assert.equal(elementTypeOf('{grade:PSA:10}'), 'grade');
  assert.equal(elementTypeOf('{grade:BGS:9}'), 'grade');
  assert.equal(elementTypeOf('{grade:CGC:8}'), 'grade');
  // 仅 UI 提供的公司（PSA/BGS/CGC）可识别为评级元素；SGC 值按自定义处理
  assert.equal(elementTypeOf('{grade:SGC:7}'), 'custom');
  assert.equal(elementTypeOf('{title}'), 'title');
  assert.equal(elementTypeOf('${market}'), 'market');
});

test('parseGradeValue parses and validates company/score', () => {
  assert.deepEqual(parseGradeValue('{grade:PSA:10}'), { company: 'PSA', score: 10 });
  assert.deepEqual(parseGradeValue('{grade:CGC:9}'), { company: 'CGC', score: 9 });
  assert.equal(parseGradeValue('{grade:XXX:10}'), null);
  assert.equal(parseGradeValue('{grade:PSA:11}'), null);
  assert.equal(parseGradeValue('{grade:PSA}'), null);
  assert.equal(parseGradeValue('{title}'), null);
  assert.equal(gradeValue('PSA', 10), '{grade:PSA:10}');
});

test('renderValue renders grade price as "PSA10 $xxx"', () => {
  const withGrades = { ...sampleCard, grades: { 'PSA:10': 123.45, 'BGS:9': 88 } };
  assert.equal(renderValue('{grade:PSA:10}', withGrades), 'PSA10 $123.45');
  assert.equal(renderValue('{grade:BGS:9}', withGrades), 'BGS9 $88.00');
  // 无该评级数据时显示 --
  assert.equal(renderValue('{grade:CGC:8}', withGrades), 'CGC8 $--');
  assert.equal(renderValue('{grade:PSA:10}', sampleCard), 'PSA10 $--');
});

test('page editor exposes grade element with company/score selects', () => {
  assert.match(page, /aria-label="评级公司"/);
  assert.ok(page.includes('aria-label="评级分数"'));
  assert.match(page, /gradeValue\(e\.target\.value as typeof g\.company, g\.score\)/);
  assert.match(page, /parseGradeValue\(item\.value\)/);
  assert.match(page, /setGraded\(null\)/);
  assert.match(page, /fetchGraded\(card\.cardKey\)/);
});

test('graded price API route uses free PriceCharting page scraper', () => {
  assert.match(route, /getGradedPrices/);
  assert.match(route, /grades: result\.grades/);
  assert.match(route, /CARD_NOT_FOUND/);
  const lib = readFileSync(join(process.cwd(), 'lib/pricecharting.ts'), 'utf8');
  assert.match(lib, /search-products\?type=prices/);
  assert.match(lib, /id="price_data"/);
  assert.match(lib, /24 \* 60 \* 60 \* 1000/);
});

test('device config route re-bakes graded frame on daily refresh', () => {
  const configRoute = readFileSync(join(process.cwd(), 'app/api/devices/[id]/config/route.ts'), 'utf8');
  assert.match(configRoute, /maybeRefreshGradedFrame/);
  assert.match(configRoute, /\{grade:/);
  assert.match(configRoute, /framePayload\(program, sample, bg\)/);
  assert.match(configRoute, /saveDeviceConfig\(device\.deviceId/);
  assert.match(configRoute, /getGradedPrices\(card\)/);
});
