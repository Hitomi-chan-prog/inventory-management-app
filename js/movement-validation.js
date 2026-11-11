'use strict';
function validateMovementInput(input) {
  const raw = String(input.quantity ?? '').trim();
  const quantity = /^[0-9]+$/.test(raw) ? Number(raw) : NaN;
  const note = String(input.note ?? '').trim();
  const errors = {};
  if (!Number.isSafeInteger(quantity) || quantity < 1) errors.quantity = '数量は半角十進数字で1以上の安全な整数を入力してください。';
  if (note.length > 500) errors.note = '備考は前後の空白を除いて500文字以内で入力してください。';
  return { value:{quantity,note}, errors };
}
function validateCancellationInput(input) {
  const reason = String(input.reason ?? '').trim();
  const errors = {};
  if (reason.length < 1 || reason.length > 500) errors.reason = '取消理由は前後の空白を除き1〜500文字で入力してください。';
  return {value:{reason},errors};
}
if (typeof module !== 'undefined') module.exports = { validateMovementInput, validateCancellationInput };
