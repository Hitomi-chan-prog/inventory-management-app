const {test}=require('node:test');
const assert=require('node:assert/strict');
const {validateMovementInput:v}=require('../js/movement-validation.js');
for(const quantity of ['', ' ', '0', '-1', '1.5', '1.0000000000000001', '1e3', '0x10', '+1', '１', String(Number.MAX_SAFE_INTEGER+1)])test(`入出庫数量拒否 ${JSON.stringify(quantity)}`,()=>assert.ok(v({quantity,note:''}).errors.quantity));
test('数量の前後空白・先頭0と備考を正規化',()=>assert.deepEqual(v({quantity:' 001 ',note:' 備考<& '}),{value:{quantity:1,note:'備考<&'},errors:{}}));
test('数量の最大安全整数・備考500文字を許可、501文字を拒否',()=>{assert.deepEqual(v({quantity:String(Number.MAX_SAFE_INTEGER),note:'a'.repeat(500)}).errors,{});assert.ok(v({quantity:'1',note:'a'.repeat(501)}).errors.note)});

const {validateCancellationInput:c}=require('../js/movement-validation.js');
for(const reason of ['', '  ', 'a'.repeat(501)])test('取消理由の不正境界 '+reason.length,()=>assert.ok(c({reason}).errors.reason));
for(const reason of ['a', 'a'.repeat(500), ' '+ 'a'.repeat(500)+' '])test('取消理由の正常境界 '+reason.length,()=>assert.deepEqual(c({reason}),{value:{reason:reason.trim()},errors:{}}));
