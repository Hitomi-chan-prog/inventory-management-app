const { test } = require('node:test');
const assert = require('node:assert/strict');
const H = require('../js/history-validation.js');
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const t0='2026-11-10T00:00:00.000Z',t1='2026-11-10T00:00:01.000Z',t2='2026-11-10T00:00:02.000Z',t3='2026-11-10T00:00:03.000Z';
function fixture(){
 const p={id:id(1),productCode:'A',name:'現在名',unit:'個',createdAt:t0,deletedAt:null};
 const m={id:id(2),productId:p.id,type:'IN',quantity:5,stockBefore:0,stockAfter:5,stockVersionBefore:1,stockVersionAfter:2,productCodeSnapshot:'A',productNameSnapshot:'取引時の名前<&',unitSnapshot:'個',occurredAt:t1,note:'',actorId:null};
 const c={id:id(3),movementId:m.id,productId:p.id,stockBefore:5,stockAfter:0,stockVersionBefore:2,stockVersionAfter:3,reason:'重複登録',cancelledAt:t2,actorId:null};
 const s={productId:p.id,quantity:0,version:3,updatedAt:t2};return {p,m,c,s};
}
const check=({p,m,c,s})=>H.validate([p],[s],m?[m]:[],c?[c]:[]);
test('入庫と全量取消の有効な連鎖、スナップショットは現在名と別',()=>{assert.deepEqual(check(fixture()),{movementCount:1,cancellationCount:1})});
test('履歴なし在庫0・version1は正常でレコードを変更しない',()=>{const {p}=fixture();const s={productId:p.id,quantity:0,version:1,updatedAt:t0};const before=JSON.stringify([p,s]);H.validate([p],[s],[],[]);assert.equal(JSON.stringify([p,s]),before)});
test('履歴なし在庫非0は不整合',()=>{const f=fixture();f.m=null;f.c=null;f.s.quantity=5;assert.throws(()=>check(f),e=>e.code==='DATA')});
const movementCases={
 'ID不正':m=>m.id='bad','商品参照不正':m=>m.productId=id(99),'種別不正':m=>m.type='CANCEL','数量0':m=>m.quantity=0,'数量負':m=>m.quantity=-1,'数量小数':m=>m.quantity=1.5,'数量文字列':m=>m.quantity='5','数量安全上限超過':m=>m.quantity=Number.MAX_SAFE_INTEGER+1,
 '在庫計算不正':m=>m.stockAfter=4,'負在庫':m=>m.stockAfter=-1,'version不正':m=>m.stockVersionAfter=3,'version文字列':m=>m.stockVersionBefore='1','日時不正':m=>m.occurredAt='bad','作成前日時':m=>m.occurredAt='2020-01-01T00:00:00.000Z',
 'コードsnapshot不正':m=>m.productCodeSnapshot='B','名前snapshot空白':m=>m.productNameSnapshot=' ','単位不一致':m=>m.unitSnapshot='箱','備考501文字':m=>m.note='a'.repeat(501),'備考前後空白':m=>m.note=' a ','担当者ID不正':m=>m.actorId='bad'
};
for(const[name,mutate]of Object.entries(movementCases))test('入出庫: '+name,()=>{const f=fixture();mutate(f.m);assert.throws(()=>check(f),e=>e.code==='DATA')});
const cancelCases={
 '元取引なし':c=>c.movementId=id(98),'商品参照不一致':c=>c.productId=id(98),'在庫計算不正':c=>c.stockAfter=1,'取消負在庫':c=>c.stockBefore=4,'理由空白':c=>c.reason=' ','理由501文字':c=>c.reason='a'.repeat(501),'理由前後空白':c=>c.reason=' a ',
 '元取引前日時':c=>c.cancelledAt=t0,'日時不正':c=>c.cancelledAt='bad','version重複':c=>{c.stockVersionBefore=1;c.stockVersionAfter=2},'数量型不正':c=>c.stockBefore='5','actor不正':c=>c.actorId=1
};
for(const[name,mutate]of Object.entries(cancelCases))test('取消: '+name,()=>{const f=fixture();mutate(f.c);assert.throws(()=>check(f),e=>e.code==='DATA')});
test('二重取消・重複取引IDを拒否',()=>{const {p,s,m,c}=fixture();assert.throws(()=>H.validate([p],[s],[m],[c,{...c,id:id(4)}]));assert.throws(()=>H.validate([p],[s],[m,m],[c]))});
test('在庫と履歴の最終quantity/version/updatedAt不一致を拒否',()=>{for(const patch of [{quantity:1},{version:4},{updatedAt:t3}]){const f=fixture();Object.assign(f.s,patch);assert.throws(()=>check(f))}});
test('取消理由1文字・500文字、備考500文字を許可',()=>{for(const n of [1,500]){const f=fixture();f.c.reason='理'.repeat(n);f.m.note='a'.repeat(500);check(f)}});
test('配列の並びではなくversionで時系列を確認し同一日時も許可',()=>{const {p,m,c}=fixture();c.cancelledAt=t1;const out={...m,id:id(4),type:'OUT',stockBefore:5,stockAfter:3,quantity:2,stockVersionBefore:2,stockVersionAfter:3,occurredAt:t1};const cancelOut={...c,movementId:out.id,stockBefore:3,stockAfter:5,stockVersionBefore:3,stockVersionAfter:4};H.validate([p],[{productId:p.id,quantity:5,version:4,updatedAt:t1}],[out,m],[cancelOut])});
test('日時逆転・version欠番を拒否',()=>{const f=fixture();f.m.occurredAt=t2;f.c.cancelledAt=t1;assert.throws(()=>check(f));const g=fixture();g.c.stockVersionBefore=3;g.c.stockVersionAfter=4;assert.throws(()=>check(g))});
test('全件取消後もhasMovementsはtrue',()=>{const {p,m}=fixture();assert.equal(H.hasMovements([m],p.id),true);assert.equal(H.hasMovements([],p.id),false)});
test('削除後に発生した取引を拒否',()=>{const f=fixture();f.p.deletedAt=t0;assert.throws(()=>check(f))});
test('別商品の履歴が混ざっても商品ごとに連続性を確認',()=>{const {p,m}=fixture();const p2={...p,id:id(10),productCode:'B'};const m2={...m,id:id(11),productId:p2.id,productCodeSnapshot:'B'};assert.deepEqual(H.validate([p,p2],[{productId:p.id,quantity:5,version:2,updatedAt:t1},{productId:p2.id,quantity:5,version:2,updatedAt:t1}],[m2,m],[]),{movementCount:2,cancellationCount:0})});

test('配列でない引数・nullレコードをDATAで拒否',()=>{const {p,s}=fixture();for(const args of [[null,[s],[],[]],[[null],[s],[],[]],[[p],[null],[],[]],[[p],[s],[null],[]],[[p],[s],[],[null]]])assert.throws(()=>H.validate(...args),e=>e.code==='DATA')});
test('加算結果の安全整数超過・在庫version重複を拒否',()=>{const f=fixture();f.m.stockBefore=Number.MAX_SAFE_INTEGER;f.m.quantity=1;f.m.stockAfter=Number.MAX_SAFE_INTEGER+1;assert.throws(()=>check(f));const {p,s,m,c}=fixture();const next={...m,id:id(10),stockBefore:5,stockAfter:10};assert.throws(()=>H.validate([p],[s],[m,next],[c]))});
test('履歴・取消の予定フィールドをすべて定義',()=>{const {m,c}=fixture();assert.deepEqual([...H.movementFields].sort(),Object.keys(m).sort());assert.deepEqual([...H.cancellationFields].sort(),Object.keys(c).sort())});


for(const version of [0,2,7,'1']) test(`履歴なし在庫0・version ${JSON.stringify(version)} はDATA`,()=>{
 const {p}=fixture();const stock={productId:p.id,quantity:0,version,updatedAt:t0};const before=JSON.stringify(stock);
 assert.throws(()=>H.validate([p],[stock],[],[]),error=>error.code==='DATA');assert.equal(JSON.stringify(stock),before);
});
test('履歴なし在庫非0・version1を拒否',()=>{
 const {p}=fixture();assert.throws(()=>H.validate([p],[{productId:p.id,quantity:5,version:1,updatedAt:t0}],[],[]),error=>error.code==='DATA');
});
test('初回入庫1→2、2回目出庫2→3、出庫取消3→4を連続して検証',()=>{
 const {p,m,c}=fixture();const out={...m,id:id(5),type:'OUT',quantity:2,stockBefore:5,stockAfter:3,stockVersionBefore:2,stockVersionAfter:3,occurredAt:t2};
 const cancelOut={...c,id:id(6),movementId:out.id,stockBefore:3,stockAfter:5,stockVersionBefore:3,stockVersionAfter:4,cancelledAt:t3};
 H.validate([p],[{productId:p.id,quantity:5,version:2,updatedAt:t1}],[m],[]);
 H.validate([p],[{productId:p.id,quantity:3,version:3,updatedAt:t2}],[m,out],[]);
 H.validate([p],[{productId:p.id,quantity:5,version:4,updatedAt:t3}],[m,out],[cancelOut]);
 for(const patch of [{stockVersionBefore:4,stockVersionAfter:5},{stockVersionBefore:2,stockVersionAfter:3}])assert.throws(()=>H.validate([p],[{productId:p.id,quantity:5,version:4,updatedAt:t3}],[m,out],[{...cancelOut,...patch}]),error=>error.code==='DATA');
});
test('最初の入庫をversion7→8から開始する履歴を拒否',()=>{
 const {p,m}=fixture();const movement={...m,stockVersionBefore:7,stockVersionAfter:8};assert.throws(()=>H.validate([p],[{productId:p.id,quantity:5,version:8,updatedAt:t1}],[movement],[]),error=>error.code==='DATA');
});
