'use strict';

// 表示専用の仮データ。操作しても、この配列や在庫数は変更しません。
const products = [
  { id: 'p1', code: 'ST-001', name: 'クラフトノート A5', unit: '冊', stock: 24, point: 10 },
  { id: 'p2', code: 'ST-002', name: 'ゲルインクボールペン 黒', unit: '本', stock: 5, point: 10 },
  { id: 'p3', code: 'ST-003', name: 'マスキングテープ', unit: '個', stock: 0, point: 0 },
  { id: 'p4', code: 'ST-004', name: 'クリアファイル A4', unit: '枚', stock: 48, point: 20 },
  { id: 'p5', code: 'ST-005', name: 'ふせん くすみカラー', unit: '個', stock: 8, point: 8 }
];
const movements = [
  { id: 'm1', productId: 'p1', date: '2026/10/28 10:30', type: 'IN', quantity: 12, before: 12, after: 24 },
  { id: 'm2', productId: 'p2', date: '2026/10/28 11:15', type: 'OUT', quantity: 3, before: 8, after: 5 },
  { id: 'm3', productId: 'p4', date: '2026/10/28 13:00', type: 'OUT', quantity: 2, before: 48, after: 46 }
];
const cancellations = [{ movementId: 'm3', date: '2026/10/28 13:10', reason: '出庫中止のため', before: 46, after: 48 }];
const screen = document.querySelector('#screen');
const dialog = document.querySelector('#operation-dialog');
let returnFocus = null;

// 入力文字をHTMLとして解釈させず、安全に画面へ表示するための変換。
const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const productById = id => products.find(product => product.id === id);
const cancellationFor = id => cancellations.find(item => item.movementId === id);
const alertBadge = product => product.stock <= product.point ? '<span class="badge alert">要発注</span>' : '<span class="badge">適正在庫</span>';
function heading(title, subtitle, action = '') {
  return `<div class="page-heading"><div><h1 tabindex="-1">${title}</h1><p class="subtitle">${subtitle}</p></div>${action}</div>`;
}
function announce(message) {
  document.querySelector('#status').textContent = message;
}
function inventory() {
  screen.innerHTML = heading('在庫一覧', '商品の在庫状況と発注のタイミングを確認できます。', '<a class="button primary" href="#product/new">＋ 商品登録</a>') + `
    <div class="stats"><div class="card"><div class="stat-label">登録商品</div><div class="stat-value">5<small>件</small></div></div><div class="card"><div class="stat-label">発注アラート</div><div class="stat-value amber">3<small>件</small></div></div><div class="card"><div class="stat-label">在庫切れ</div><div class="stat-value">1<small>件</small></div></div></div>
    <section class="card" aria-label="商品一覧"><div class="toolbar"><label>商品を検索<input id="search" type="search" placeholder="商品コード・商品名で検索"></label><label class="checkbox"><input id="alert-only" type="checkbox"> 要発注のみ表示</label><button disabled title="CSV出力は今後実装します">CSV出力（準備中）</button></div><div id="inventory-table"></div></section>`;
  document.querySelector('#search').addEventListener('input', renderInventoryTable);
  document.querySelector('#alert-only').addEventListener('change', renderInventoryTable);
  renderInventoryTable();
}
function renderInventoryTable() {
  const keyword = document.querySelector('#search').value.trim().toLowerCase();
  const alertOnly = document.querySelector('#alert-only').checked;
  const filtered = products.filter(p => `${p.code} ${p.name}`.toLowerCase().includes(keyword) && (!alertOnly || p.stock <= p.point));
  document.querySelector('#inventory-table').innerHTML = `<div class="table-wrap"><table><caption class="hint">商品名から詳細を確認できます。</caption><thead><tr><th scope="col">商品</th><th scope="col" class="number">在庫数</th><th scope="col" class="number">発注点</th><th scope="col">状態</th><th scope="col">操作</th></tr></thead><tbody>${filtered.map(p => `<tr><td><strong><a href="#product/${p.id}">${p.name}</a></strong><small>${p.code}</small></td><td class="number">${p.stock} ${p.unit}</td><td class="number">${p.point} ${p.unit}</td><td>${alertBadge(p)}</td><td><div class="row-actions"><button data-operation="IN" data-product="${p.id}" aria-label="${p.name}を入庫">入庫</button><button data-operation="OUT" data-product="${p.id}" aria-label="${p.name}を出庫">出庫</button></div></td></tr>`).join('')}</tbody></table></div>${filtered.length ? '' : '<p class="empty">該当する商品がありません。</p>'}<p class="table-footer" role="status">${filtered.length} / ${products.length} 件を表示</p>`;
}
function productForm(product) {
  const editing = Boolean(product);
  const back = editing ? `#product/${product.id}` : '#inventory';
  screen.innerHTML = `<a class="back" href="${back}">← 戻る</a>` + heading(editing ? '商品編集' : '商品登録', '商品の基本情報を入力してください。') + `
    <form id="product-form" class="card form-card"><label class="field">商品コード<span class="required">必須</span><input name="code" required maxlength="40" value="${product?.code || ''}" ${editing ? 'readonly' : ''}><span class="hint">登録後は変更できません。削除済みのコードも再利用できません。</span></label><label class="field">商品名<span class="required">必須</span><input name="name" required maxlength="100" value="${product?.name || ''}"></label><label class="field">単位<span class="required">必須</span><input name="unit" required maxlength="10" placeholder="例：個、冊、本" value="${product?.unit || ''}" ${editing ? 'readonly' : ''}><span class="hint">履歴がある商品の単位は変更できません。</span></label><label class="field">発注点<span class="required">必須</span><input name="point" type="number" required min="0" step="1" value="${product?.point ?? 0}"><span class="hint">在庫数がこの値以下になるとアラートを表示します。</span></label><p class="hint">${editing ? '在庫数は入庫・出庫で変更します。' : '初期在庫は0です。登録後、入庫から追加します。'}</p><div class="actions"><a class="button" href="${back}">キャンセル</a><button class="primary" type="submit">${editing ? '編集' : '登録'}内容を確認（デモ）</button></div></form>`;
  document.querySelector('#product-form').addEventListener('submit', event => {
    event.preventDefault();
    announce('入力内容を確認しました。画面デモのため保存していません。');
  });
}
function historyTable(items) {
  return `<div class="table-wrap"><table><thead><tr><th scope="col">日時・商品</th><th scope="col">種別</th><th scope="col" class="number">数量</th><th scope="col">在庫の変化</th><th scope="col">取消状態・理由</th><th scope="col">操作</th></tr></thead><tbody>${items.map(m => {
    const p = productById(m.productId);
    const c = cancellationFor(m.id);
    return `<tr><td><small>${m.date}</small><strong><a href="#product/${p.id}">${p.name}</a></strong><small>${p.code}</small></td><td><span class="badge ${m.type === 'OUT' ? 'muted' : ''}">${m.type === 'IN' ? '入庫' : '出庫'}</span></td><td class="number">${m.quantity} ${p.unit}</td><td>${m.before} → ${m.after}</td><td>${c ? `<span class="badge muted">取消済み</span><br><small>${c.date}</small><br>${escapeHtml(c.reason)}<br><small>取消時在庫：${c.before} → ${c.after}</small>` : '未取消'}</td><td><button data-operation="CANCEL" data-movement="${m.id}" ${c ? 'disabled' : ''} aria-label="${p.name}の${m.date}の取引を取消">${c ? '取消済み' : '取消'}</button></td></tr>`;
  }).join('')}</tbody></table></div>${items.length ? '' : '<p class="empty">該当する履歴がありません。</p>'}`;
}
function detail(product) {
  screen.innerHTML = '<a class="back" href="#inventory">← 在庫一覧</a>' + heading(product.name, product.code, `<a class="button" href="#product/${product.id}/edit">商品編集</a>`) + `
    <div class="detail-grid"><section class="card"><h2>現在の在庫</h2>${alertBadge(product)}<p class="stock-number">${product.stock} <small>${product.unit}</small></p><p class="hint">発注点：${product.point} ${product.unit}</p><div class="actions"><button class="primary" data-operation="IN" data-product="${product.id}">入庫</button><button data-operation="OUT" data-product="${product.id}">出庫</button></div></section><section class="card"><h2>商品情報</h2><dl><dt>商品コード</dt><dd>${product.code}</dd><dt>単位</dt><dd>${product.unit}</dd><dt>削除</dt><dd class="hint">論理削除は今後実装します。在庫0の商品が対象です。</dd></dl><button disabled>商品削除（準備中）</button></section></div><section class="card"><h2>この商品の入出庫・取消履歴</h2>${historyTable(movements.filter(m => m.productId === product.id))}</section>`;
}
function history() {
  screen.innerHTML = heading('入出庫・取消履歴', '元の取引を残し、取消の日時と理由を確認できます。') + `<section class="card"><div class="toolbar"><label>商品<select id="history-product"><option value="">すべての商品</option>${products.map(p => `<option value="${p.id}">${p.name}</option>`).join('')}</select></label><label>種別<select id="history-type"><option value="">すべて</option><option value="IN">入庫</option><option value="OUT">出庫</option></select></label><button disabled>CSV出力（準備中）</button></div><div id="history-table"></div><p class="hint">期間・取消状態による絞り込みは今後追加します。</p></section>`;
  const refresh = () => {
    const product = document.querySelector('#history-product').value;
    const type = document.querySelector('#history-type').value;
    document.querySelector('#history-table').innerHTML = historyTable(movements.filter(m => (!product || m.productId === product) && (!type || m.type === type)));
  };
  document.querySelector('#history-product').addEventListener('change', refresh);
  document.querySelector('#history-type').addEventListener('change', refresh);
  refresh();
}
// URLの # 以降を読み、同じHTMLの表示領域を切り替えます。ブラウザの戻るにも対応。
function renderRoute() {
  const route = location.hash.slice(1) || 'inventory';
  const [page, id, action] = route.split('/');
  if (page === 'inventory') inventory();
  else if (page === 'history') history();
  else if (page === 'product' && id === 'new') productForm();
  else if (page === 'product' && productById(id)) {
    if (action === 'edit') productForm(productById(id));
    else detail(productById(id));
  } else screen.innerHTML = heading('画面が見つかりません', '在庫一覧から商品を選び直してください。', '<a class="button" href="#inventory">在庫一覧へ</a>');
  document.querySelectorAll('[data-nav]').forEach(link => {
    const active = link.dataset.nav === page;
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  announce('');
  screen.querySelector('h1').focus();
}
function openOperation(button) {
  const type = button.dataset.operation;
  const movement = movements.find(m => m.id === button.dataset.movement);
  const product = productById(button.dataset.product || movement?.productId);
  if (!product || (type === 'CANCEL' && (!movement || cancellationFor(movement.id)))) return;
  const title = { IN: '入庫', OUT: '出庫', CANCEL: '取消' }[type];
  document.querySelector('#dialog-title').textContent = `${title}（デモ）`;
  document.querySelector('#dialog-content').innerHTML = `<div class="summary"><strong>${product.name}</strong><br><small>${product.code} ／ 現在庫：${product.stock} ${product.unit}</small></div>` + (type === 'CANCEL' ? `<p>対象：${movement.date} ／ ${movement.type === 'IN' ? '入庫' : '出庫'} ${movement.quantity} ${product.unit}</p><p class="hint">取消後の予定在庫：${product.stock + (movement.type === 'IN' ? -movement.quantity : movement.quantity)} ${product.unit}（参考）</p><label class="field">取消理由<span class="required">必須</span><textarea id="cancel-reason" required maxlength="500" rows="3" placeholder="例：重複登録のため"></textarea><span class="hint">前後の空白を除き1〜500文字。取消日時とともに記録する予定です。</span></label>` : `<label class="field">${title}数量<span class="required">必須</span><input id="quantity" type="number" required min="1" step="1" value="1"></label><p id="planned-stock" class="hint" aria-live="polite"></p><label class="field">備考（任意）<textarea rows="2" maxlength="500"></textarea></label>` ) + '<p class="hint">画面確認用です。在庫や履歴は変更しません。</p>';
  const quantity = document.querySelector('#quantity');
  if (quantity) {
    const updatePreview = () => {
      const value = quantity.valueAsNumber;
      document.querySelector('#planned-stock').textContent = quantity.validity.valid ? `予定在庫：${product.stock + (type === 'IN' ? value : -value)} ${product.unit}（参考・在庫不足の判定は今後実装）` : '1以上の整数を入力してください。';
    };
    quantity.addEventListener('input', updatePreview);
    updatePreview();
  }
  const reason = document.querySelector('#cancel-reason');
  if (reason) reason.addEventListener('input', () => reason.setCustomValidity(reason.value.trim() ? '' : '取消理由を入力してください。'));
  returnFocus = button;
  dialog.showModal();
}
// 再描画で追加されるボタンも、親要素でクリックを受け取ると処理できます。
screen.addEventListener('click', event => {
  const button = event.target.closest('[data-operation]');
  if (button) openOperation(button);
});
document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => dialog.close()));
dialog.addEventListener('close', () => returnFocus?.focus());
document.querySelector('#operation-form').addEventListener('submit', event => {
  event.preventDefault();
  dialog.close();
  announce('デモ内容を確認しました。在庫更新・取消・履歴保存は実行していません。');
});
window.addEventListener('hashchange', renderRoute);
renderRoute();
