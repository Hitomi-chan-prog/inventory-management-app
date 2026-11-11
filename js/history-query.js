'use strict';
// DBやDOMに依存しない検索処理。検索日は日本時間の0時から翌日0時未満です。
const HistoryQuery = (() => {
  const PAGE_SIZE = 50;
  function dayStart(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return NaN;
    const time = Date.parse(value + 'T00:00:00.000Z');
    if (!Number.isFinite(time) || new Date(time).toISOString().slice(0,10) !== value) return NaN;
    return time - 9 * 60 * 60 * 1000;
  }
  function search(movements, cancellations, filters) {
    const start = filters.start ? dayStart(filters.start) : -Infinity;
    const end = filters.end ? dayStart(filters.end) + 86400000 : Infinity;
    let error = '';
    if (Number.isNaN(start) || Number.isNaN(end)) error = '日付は実在する日付をYYYY-MM-DD形式で入力してください。';
    else if (start >= end) error = '開始日は終了日以前の日付にしてください。';
    if (error) return {items:[],total:0,page:1,pages:1,error};
    const cancelled = new Set(cancellations.map(c=>c.movementId));
    const keyword = (filters.keyword || '').trim().toLowerCase();
    const selected = movements.filter(m=>{
      const time = Date.parse(m.occurredAt);
      return (!filters.productId || m.productId === filters.productId)
        && (!keyword || `${m.productCodeSnapshot} ${m.productNameSnapshot}`.toLowerCase().includes(keyword))
        && time >= start && time < end
        && (!filters.type || m.type === filters.type)
        && (!filters.status || (filters.status === 'cancelled' ? cancelled.has(m.id) : !cancelled.has(m.id)));
    });
    // 同一時刻では商品ID・在庫version・取引IDで順序を確定します。入力配列は変更しません。
    selected.sort((a,b)=>Date.parse(b.occurredAt)-Date.parse(a.occurredAt) || a.productId.localeCompare(b.productId) || b.stockVersionAfter-a.stockVersionAfter || a.id.localeCompare(b.id));
    const pages = Math.max(1,Math.ceil(selected.length/PAGE_SIZE));
    const page = Math.min(pages,Math.max(1,Number.isSafeInteger(filters.page)?filters.page:1));
    return {items:selected.slice((page-1)*PAGE_SIZE,page*PAGE_SIZE),total:selected.length,page,pages,error:''};
  }
  const formatter = new Intl.DateTimeFormat('ja-JP',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
  function formatTime(value) { return formatter.format(new Date(value)) + '（日本時間）'; }
  return {PAGE_SIZE,dayStart,search,formatTime};
})();
if (typeof module !== 'undefined') module.exports = HistoryQuery;
