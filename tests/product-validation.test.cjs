const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateProductInput: validate } = require('../js/product-validation.js');
const valid = { code: ' st-001 ', name: ' 商品 ', unit: ' 個 ', point: '0' };
test('正規化と発注点0', () => {
  assert.deepEqual(validate(valid), { value: { code: 'ST-001', name: '商品', unit: '個', point: 0 }, errors: {} });
});
for (const [field, values] of Object.entries({
  code: ['', '   ', 'ＡＢＣ', 'AB C', '<script>', 'A'.repeat(41)],
  name: ['', '　 ', '名'.repeat(101)], unit: ['', ' ', '個'.repeat(11)],
  point: ['', ' ', '-1', '1.5', 'NaN', 'Infinity', '9007199254740992']
})) for (const value of values) test(`${field}: ${JSON.stringify(value)}を拒否`, () => {
  assert.ok(validate({ ...valid, [field]: value }).errors[field]);
});
test('文字数上限と安全な整数上限', () => {
  assert.deepEqual(validate({ code:'A'.repeat(40), name:'名'.repeat(100), unit:'個'.repeat(10), point:String(Number.MAX_SAFE_INTEGER) }).errors, {});
});
test('HTML風の商品名は文字列として許可（表示側で安全化）', () => {
  assert.deepEqual(validate({ ...valid, name:'<img src=x onerror=alert(1)>' }).errors, {});
});

// レビューで見つかった、変換前の形式検証に関する再発防止。
for (const code of ['ß', 'ſ', 'Ａ1', 'A１', 'A B', 'A\tB']) {
  test(`変換前の商品コードを拒否: ${JSON.stringify(code)}`, () => {
    const result = validate({ ...valid, code });
    assert.ok(result.errors.code);
    assert.equal(result.value.code, code);
  });
}
for (const point of ['1.0000000000000001', '9007199254740991.1', '1e3', '1E+3', '0x10', '+1', '１', '.0']) {
  test(`変換前の発注点形式を拒否: ${point}`, () => {
    assert.ok(validate({ ...valid, point }).errors.point);
  });
}
test('発注点の前後空白・先頭0・最大安全整数を許可', () => {
  for (const point of [' 0 ', '0012', String(Number.MAX_SAFE_INTEGER)]) {
    assert.deepEqual(validate({ ...valid, point }).errors, {});
  }
});
