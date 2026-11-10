'use strict';

// DOMや保存処理に依存しない関数なので、Node.jsでも同じルールをテストできます。
function validateProductInput(input) {
  const codeText = String(input.code ?? '').trim();
  const pointText = String(input.point ?? '').trim();
  // 変換前に文字列の形式を確認し、丸めやUnicode大文字化による抜け道を防ぎます。
  const validCode = /^[A-Za-z0-9_-]+$/.test(codeText) && codeText.length <= 40;
  const validPointFormat = /^[0-9]+$/.test(pointText);
  const value = {
    code: validCode ? codeText.toUpperCase() : codeText,
    name: String(input.name ?? '').trim(),
    unit: String(input.unit ?? '').trim(),
    point: validPointFormat ? Number(pointText) : NaN
  };
  const errors = {};
  if (!validCode) {
    errors.code = '商品コードは半角英数字・ハイフン・アンダースコアで1〜40文字入力してください。';
  }
  if (!value.name || value.name.length > 100) errors.name = '商品名は空白を除いて1〜100文字入力してください。';
  if (!value.unit || value.unit.length > 10) errors.unit = '単位は空白を除いて1〜10文字入力してください。';
  if (!validPointFormat || !Number.isSafeInteger(value.point)) {
    errors.point = '発注点は半角の十進数字のみで、0以上の安全な整数を入力してください。';
  }
  return { value, errors };
}

// ブラウザでは通常の関数、Node.jsのテストではモジュールとして利用します。
if (typeof module !== 'undefined') module.exports = { validateProductInput };
