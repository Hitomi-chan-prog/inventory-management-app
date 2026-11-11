'use strict';

// STEP 3-1で検証基盤、3-2で入出庫保存、3-3で取消保存を実装。3-4で履歴検索・詳細表示を実装。
const HistoryValidation = (() => {
  const movementFields = Object.freeze(['id','productId','type','quantity','stockBefore','stockAfter','stockVersionBefore','stockVersionAfter','productCodeSnapshot','productNameSnapshot','unitSnapshot','occurredAt','note','actorId']);
  const cancellationFields = Object.freeze(['id','movementId','productId','stockBefore','stockAfter','stockVersionBefore','stockVersionAfter','reason','cancelledAt','actorId']);
  const integer = (v,min=0) => typeof v === 'number' && Number.isSafeInteger(v) && v >= min;
  const uuid = v => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
  const date = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
  const text = (v,min,max) => typeof v === 'string' && v === v.trim() && v.length >= min && v.length <= max;
  const record = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  function validate(products, stocks, movements, cancellations) {
    const bad = () => { throw Object.assign(new Error('入出庫・取消履歴と在庫の型・計算・参照・時系列が不整合です。データは変更していません。'), {name:'InventoryError',code:'DATA'}); };
    if (![products,stocks,movements,cancellations].every(Array.isArray) || !products.every(record) || !stocks.every(record)) bad();
    const productMap = new Map(products.map(p=>[p.id,p]));
    const stockMap = new Map(stocks.map(s=>[s.productId,s]));
    const movementMap = new Map();
    const events = new Map(products.map(p=>[p.id,[]]));
    const cancelled = new Set();
    const cancelIds = new Set();
    const validEvent = (e,p,time) => record(e) && uuid(e.id) && uuid(e.productId) && integer(e.stockBefore) && integer(e.stockAfter) && integer(e.stockVersionBefore,1) && integer(e.stockVersionAfter,2) && e.stockVersionAfter === e.stockVersionBefore+1 && date(time) && time >= p.createdAt && (p.deletedAt === null || time <= p.deletedAt) && (e.actorId === null || uuid(e.actorId));
    for (const m of movements) {
      if (!record(m)) bad();
      const p = productMap.get(m.productId);
      if (!p || !validEvent(m,p,m.occurredAt) || movementMap.has(m.id) || !['IN','OUT'].includes(m.type) || !integer(m.quantity,1) || !text(m.productCodeSnapshot,1,40) || !/^[A-Z0-9_-]+$/.test(m.productCodeSnapshot) || m.productCodeSnapshot !== p.productCode || !text(m.productNameSnapshot,1,100) || !text(m.unitSnapshot,1,10) || m.unitSnapshot !== p.unit || !text(m.note,0,500)) bad();
      const after = m.stockBefore + (m.type === 'IN' ? m.quantity : -m.quantity);
      if (!integer(after) || after !== m.stockAfter) bad();
      movementMap.set(m.id,m);
      events.get(m.productId).push({...m,time:m.occurredAt});
    }
    for (const c of cancellations) {
      if (!record(c)) bad();
      const p = productMap.get(c.productId);
      const m = movementMap.get(c.movementId);
      if (!p || !m || !uuid(c.movementId) || !validEvent(c,p,c.cancelledAt) || c.productId !== m.productId || cancelIds.has(c.id) || cancelled.has(c.movementId) || c.cancelledAt < m.occurredAt || c.stockVersionBefore < m.stockVersionAfter || !text(c.reason,1,500)) bad();
      const after = c.stockBefore + (m.type === 'IN' ? -m.quantity : m.quantity);
      if (!integer(after) || after !== c.stockAfter) bad();
      cancelIds.add(c.id);
      cancelled.add(c.movementId);
      events.get(c.productId).push({...c,time:c.cancelledAt});
    }
    for (const p of products) {
      const stock = stockMap.get(p.id);
      if (!stock) bad();
      const chain = events.get(p.id).sort((a,b)=>a.stockVersionAfter-b.stockVersionAfter);
      if (!chain.length) { if (stock.quantity !== 0 || stock.version !== 1) bad(); continue; }
      let quantity = 0, version = 1, time = p.createdAt;
      for (const e of chain) {
        if (e.stockBefore !== quantity || e.stockVersionBefore !== version || e.time < time) bad();
        quantity=e.stockAfter;version=e.stockVersionAfter;time=e.time;
      }
      if (stock.quantity !== quantity || stock.version !== version || stock.updatedAt !== time) bad();
    }
    return { movementCount:movements.length, cancellationCount:cancellations.length };
  }
  // 商品編集のreadwriteトランザクションから同じストアを参照できます。
  // 一度でも実履歴があれば、全件取消後も単位変更不可です。
  function hasMovements(movements, productId) { return movements.some(m=>m.productId===productId); }
  return { movementFields, cancellationFields, validate, hasMovements };
})();
if (typeof module !== 'undefined') module.exports = HistoryValidation;
