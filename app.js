'use strict';

// 表示専用の仮データ。操作しても、この配列や在庫数は変更しません。
const demoProducts = [
  { id: 'p1', code: 'ST-001', name: 'クラフトノート A5', unit: '冊', stock: 24, point: 10 },
  { id: 'p2', code: 'ST-002', name: 'ゲルインクボールペン 黒', unit: '本', stock: 5, point: 10 },
  { id: 'p3', code: 'ST-003', name: 'マスキングテープ', unit: '個', stock: 0, point: 0 },
  { id: 'p4', code: 'ST-004', name: 'クリアファイル A4', unit: '枚', stock: 48, point: 20 },
  { id: 'p5', code: 'ST-005', name: 'ふせん くすみカラー', unit: '個', stock: 8, point: 8 }
];
const demoMovements = [
  { id: 'm1', productId: 'p1', date: '2026/10/28 10:30', type: 'IN', quantity: 12, before: 12, after: 24 },
  { id: 'm2', productId: 'p2', date: '2026/10/28 11:15', type: 'OUT', quantity: 3, before: 8, after: 5 },
  { id: 'm3', productId: 'p4', date: '2026/10/28 13:00', type: 'OUT', quantity: 2, before: 48, after: 46 }
];
const demoCancellations = [{ movementId: 'm3', date: '2026/10/28 13:10', reason: '出庫中止のため', before: 46, after: 48 }];
// 通常モードには仮データを渡しません。保存機能は後のステップで追加します。
let demoMode = false;
let products = [];
let movements = [];
let cancellations = [];
let loadGeneration = 0;
let dbState = 'idle';
let dbMessage = '';
let savingProduct = false;
let dataDirty = false;
let saveResult = null;
const inventoryFilters = { keyword:'', alertOnly:false };

// 保存の確定結果は、後続の読み込み成否とは独立して保持します。
function setSaveResult(result) {
  saveResult = result;
  const notice = document.querySelector('#save-notice');
  notice.textContent = result ? (result.kind === 'edit' ? '編集は完了しています。再保存は不要です。' : '商品登録は完了しています。再登録は不要です。') : '';
  notice.hidden = !result;
}
function readFailureMessage(message) {
  return message + (saveResult ? (saveResult.kind === 'edit' ? ' 編集は完了しています。再保存は不要です。' : ' 商品登録は完了しています。再登録は不要です。') : '');
}
// フォームの外側にあるため、入力を消さずにDBエラーを通知できます。
function showDatabaseNotice(message = '') {
  const notice = document.querySelector('#db-notice');
  notice.textContent = message;
  notice.hidden = !message;
}
function showDatabaseState() {
  screen.innerHTML = heading('在庫一覧', '保存データの読み込み状態') + '<section class="card"><p id="db-message" role="status"></p><button id="db-retry" type="button">再読み込み</button></section>';
  document.querySelector('#db-message').textContent = dbMessage;
  document.querySelector('#db-retry').addEventListener('click', () => { dbState = 'idle'; renderRoute(); });
}
async function loadNormalProducts() {
  const current = ++loadGeneration;
  dbState = 'loading';
  showDatabaseNotice();
  dbMessage = '商品データを読み込んでいます…';
  try {
    const loaded = await InventoryDB.readProducts();
    if (current !== loadGeneration || demoMode) return;
    products = loaded;
    dbState = 'ready';
  } catch (error) {
    if (current !== loadGeneration || demoMode) return;
    products = [];
    dbState = 'error';
    dbMessage = readFailureMessage(error.message || 'データの読み込みに失敗しました。');
    showDatabaseNotice(dbMessage);
  }
  if (!document.querySelector('#product-form')) renderRoute();
}
const screen = document.querySelector('#screen');
const dialog = document.querySelector('#operation-dialog');
let returnFocus = null;

// 入力文字をHTMLとして解釈させず、安全に画面へ表示するための変換。
const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const productById = id => products.find(product => product.id === id);
const cancellationFor = id => cancellations.find(item => item.movementId === id);
const alertBadge = product => product.stock <= product.point ? '<span class="badge alert">要発注</span>' : '<span class="badge">適正在庫</span>';
function heading(title, subtitle, action = '') {
  return `<div class="page-heading"><div><h1 tabindex="-1">${escapeHtml(title)}</h1><p class="subtitle">${escapeHtml(subtitle)}</p></div>${action}</div>`;
}
function announce(message) {
  document.querySelector('#status').textContent = message;
}
function inventory() {
  screen.innerHTML = heading('在庫一覧', '商品の在庫状況と発注のタイミングを確認できます。', '<a class="button primary" href="#product/new">＋ 商品登録</a>') + `
    <div class="stats"><div class="card"><div class="stat-label">登録商品</div><div class="stat-value">${products.length}<small>件</small></div></div><div class="card"><div class="stat-label">発注アラート</div><div class="stat-value amber">${products.filter(p => p.stock <= p.point).length}<small>件</small></div></div><div class="card"><div class="stat-label">在庫切れ</div><div class="stat-value">${products.filter(p => p.stock === 0).length}<small>件</small></div></div></div>
    <section class="card" aria-label="商品一覧"><div class="toolbar"><label>商品を検索<input id="search" type="search" placeholder="商品コード・商品名で検索"></label><label class="checkbox"><input id="alert-only" type="checkbox"> 要発注のみ表示</label><button disabled title="CSV出力は今後実装します">CSV出力（準備中）</button></div><div id="inventory-table"></div></section>`;
  document.querySelector('#search').value = inventoryFilters.keyword;
  document.querySelector('#alert-only').checked = inventoryFilters.alertOnly;
  document.querySelector('#search').addEventListener('input', renderInventoryTable);
  document.querySelector('#alert-only').addEventListener('change', renderInventoryTable);
  renderInventoryTable();
}
function renderInventoryTable() {
  inventoryFilters.keyword = document.querySelector('#search').value;
  inventoryFilters.alertOnly = document.querySelector('#alert-only').checked;
  const keyword = inventoryFilters.keyword.trim().toLowerCase();
  const alertOnly = inventoryFilters.alertOnly;
  const filtered = products.filter(p => `${p.code} ${p.name}`.toLowerCase().includes(keyword) && (!alertOnly || p.stock <= p.point));
  document.querySelector('#inventory-table').innerHTML = `<div class="table-wrap"><table><caption class="hint">商品名から詳細を確認できます。</caption><thead><tr><th scope="col">商品</th><th scope="col" class="number">在庫数</th><th scope="col" class="number">発注点</th><th scope="col">状態</th><th scope="col">操作</th></tr></thead><tbody>${filtered.map(p => `<tr><td><strong><a href="#product/${escapeHtml(p.id)}">${escapeHtml(p.name)}</a></strong><small>${escapeHtml(p.code)}</small></td><td class="number">${escapeHtml(p.stock)} ${escapeHtml(p.unit)}</td><td class="number">${escapeHtml(p.point)} ${escapeHtml(p.unit)}</td><td>${alertBadge(p)}</td><td><div class="row-actions"><button ${demoMode ? '' : 'disabled title="準備中"'} data-operation="IN" data-product="${escapeHtml(p.id)}" aria-label="${escapeHtml(p.name)}を入庫">入庫</button><button ${demoMode ? '' : 'disabled title="準備中"'} data-operation="OUT" data-product="${escapeHtml(p.id)}" aria-label="${escapeHtml(p.name)}を出庫">出庫</button></div></td></tr>`).join('')}</tbody></table></div>${filtered.length ? '' : '<p class="empty">該当する商品がありません。</p>'}<p class="table-footer" role="status">${filtered.length} / ${products.length} 件を表示</p>`;
}
function productForm(product) {
  const editing = Boolean(product);
  const expectedVersion = product?.version;
  const back = editing ? `#product/${escapeHtml(product.id)}` : '#inventory';
  screen.innerHTML = `<a class="back" href="${back}">← 戻る</a>` + heading(editing ? '商品編集' : '商品登録', '商品の基本情報を入力してください。') + `
    <form id="product-form" class="card form-card" novalidate><label class="field">商品コード<span class="required">必須</span><input name="code" required maxlength="40" value="${escapeHtml(product?.code || '')}" ${editing ? 'readonly' : ''}><span class="hint">半角英数字・ハイフン・アンダースコア、1〜40文字。前後空白を除去し英字を大文字に統一します。削除済みを含む商品コードの重複は保存できません。</span></label><label class="field">商品名<span class="required">必須</span><input name="name" required maxlength="100" value="${escapeHtml(product?.name || '')}"></label><label class="field">単位<span class="required">必須</span><input name="unit" required maxlength="10" placeholder="例：個、冊、本" value="${escapeHtml(product?.unit || '')}" ${editing && demoMode ? 'readonly' : ''}><span class="hint">通常モードの商品単位は編集できます。入出庫の実処理は未実装です。</span></label><label class="field">発注点<span class="required">必須</span><input name="point" type="number" required min="0" step="1" value="${escapeHtml(product?.point ?? 0)}"><span class="hint">在庫数がこの値以下になるとアラートを表示します。</span></label><p class="hint">${editing ? '在庫数は入庫・出庫で変更します。' : '初期在庫は0です。登録後、入庫から追加します。'}</p><div class="actions"><a class="button" href="${back}">キャンセル</a><button class="primary" type="submit">${!demoMode ? (editing ? '変更を保存' : '商品を登録') : (editing ? '編集' : '登録') + '入力を確認（保存なし）'}</button></div></form>`;
  const form = document.querySelector('#product-form');
  // エラーの説明を各入力欄と関連付け、読み上げでも原因を確認できるようにします。
  for (const name of ['code', 'name', 'unit', 'point']) {
    const input = form.elements.namedItem(name);
    const error = document.createElement('span');
    error.id = `${name}-error`;
    error.className = 'field-error';
    input.setAttribute('aria-describedby', error.id);
    input.parentElement.append(error);
  }
  form.addEventListener('input', event => {
    announce('');
    const input = event.target;
    if (input.name) {
      input.removeAttribute('aria-invalid');
      document.getElementById(`${input.name}-error`).textContent = '';
    }
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (savingProduct) return;
    announce('');
    const { value, errors } = validateProductInput(Object.fromEntries(new FormData(form)));
    for (const name of ['code', 'name', 'unit', 'point']) {
      form.elements.namedItem(name).setAttribute('aria-invalid', String(Boolean(errors[name])));
      document.getElementById(`${name}-error`).textContent = errors[name] || '';
    }
    const firstError = Object.keys(errors)[0];
    if (firstError) {
      form.elements.namedItem(firstError).focus();
      announce('入力内容を確認してください。保存は行っていません。');
      return;
    }
    // 正規化した文字列もinnerHTMLではなくvalueで設定します。
    if (demoMode) {
      for (const [name, normalized] of Object.entries(value)) form.elements.namedItem(name).value = normalized;
      announce('入力内容を確認しました。デモまたは編集のため保存していません。');
      return;
    }
    if (dbState !== 'ready') {
      showDatabaseNotice('DBの読み込みが完了していないか、エラーが発生しています。在庫一覧で再読み込みしてから登録してください。');
      return;
    }
    setSaveResult(null);
    showDatabaseNotice();
    savingProduct = true;
    const button = form.querySelector('button[type=submit]');
    const controls = [...form.querySelectorAll('input, button')];
    const disabledStates = controls.map(control => control.disabled);
    controls.forEach(control => { control.disabled = true; });
    document.querySelector('#mode-toggle').disabled = true;
    button.textContent = '保存中…';
    announce('商品を保存しています…');
    const current = loadGeneration;
    let committed = false;
    try {
      if (editing) await InventoryDB.updateProduct(product.id, expectedVersion, value, { mode:'normal' });
      else await InventoryDB.registerProduct(value, { mode:'normal' });
      committed = true;
      setSaveResult({ kind:editing ? 'edit' : 'register' });
      if (demoMode || current !== loadGeneration) {
        showDatabaseNotice(editing ? '商品は編集済みです。一覧を再読み込みしてください。再保存は不要です。' : '商品登録は完了しました。一覧を再読み込みしてください。再登録は不要です。');
        return;
      }
      const refreshed = await InventoryDB.readProducts();
      if (demoMode || current !== loadGeneration) {
        showDatabaseNotice(editing ? '商品は編集済みです。一覧を再読み込みしてください。再保存は不要です。' : '商品登録は完了しました。一覧を再読み込みしてください。再登録は不要です。');
        return;
      }
      products = refreshed;
      dbState = 'ready';
      showDatabaseNotice();
      // hashchangeによる画面描画が終わってから成功を通知します。
      if (location.hash === '#inventory') renderRoute();
      else await new Promise(resolve => {
        window.addEventListener('hashchange', resolve, { once:true });
        location.hash = 'inventory';
      });
      announce(editing ? '商品を編集しました。' : '商品を登録しました。初期在庫は0です。');
    } catch (error) {
      announce('');
      if (committed) {
        dbState = 'error';
        dbMessage = editing ? '編集済みですが、一覧の読み込みに失敗しました。再保存せず一覧を再読み込みしてください。' : '登録は完了しましたが、一覧の読み込みに失敗しました。再登録せず一覧を再読み込みしてください。';
        products = [];
        showDatabaseNotice(dbMessage);
        // 一覧を残して正常な0件・古い集計に見せない。フォームは再描画しません。
        if (!document.querySelector('#product-form')) renderRoute();
      } else {
        const message = error.message || '商品の保存に失敗しました。入力内容は保持しています。';
        if (InventoryDB.isReliabilityError(error)) {
          // DBを信頼できないときは一覧だけでなく詳細用キャッシュも無効にします。
          loadGeneration++;
          dataDirty = false;
          dbState = 'error';
          dbMessage = readFailureMessage(message);
          products = [];
          showDatabaseNotice(dbMessage);
          if (!document.querySelector('#product-form')) renderRoute();
        } else showDatabaseNotice(message);
      }
    } finally {
      savingProduct = false;
      document.querySelector('#mode-toggle').disabled = false;
      controls.forEach((control, index) => { control.disabled = committed ? true : disabledStates[index]; });
      button.textContent = committed ? (editing ? '編集済み（再保存不要）' : '登録済み（再登録不要）') : (editing ? '変更を保存' : '商品を登録');
      if (dataDirty && !demoMode && !document.querySelector('#product-form')) { dbState = 'idle'; renderRoute(); }
    }
  });
}
function historyTable(items) {
  return `<div class="table-wrap"><table><thead><tr><th scope="col">日時・商品</th><th scope="col">種別</th><th scope="col" class="number">数量</th><th scope="col">在庫の変化</th><th scope="col">取消状態・理由</th><th scope="col">操作</th></tr></thead><tbody>${items.map(m => {
    const p = productById(m.productId);
    const c = cancellationFor(m.id);
    return `<tr><td><small>${escapeHtml(m.date)}</small><strong><a href="#product/${escapeHtml(p.id)}">${escapeHtml(p.name)}</a></strong><small>${escapeHtml(p.code)}</small></td><td><span class="badge ${m.type === 'OUT' ? 'muted' : ''}">${m.type === 'IN' ? '入庫' : '出庫'}</span></td><td class="number">${escapeHtml(m.quantity)} ${escapeHtml(p.unit)}</td><td>${escapeHtml(m.before)} → ${escapeHtml(m.after)}</td><td>${c ? `<span class="badge muted">取消済み</span><br><small>${escapeHtml(c.date)}</small><br>${escapeHtml(c.reason)}<br><small>取消時在庫：${escapeHtml(c.before)} → ${escapeHtml(c.after)}</small>` : '未取消'}</td><td><button data-operation="CANCEL" data-movement="${escapeHtml(m.id)}" ${c ? 'disabled' : ''} aria-label="${escapeHtml(p.name)}の${escapeHtml(m.date)}の取引を取消">${c ? '取消済み' : '取消'}</button></td></tr>`;
  }).join('')}</tbody></table></div>${items.length ? '' : '<p class="empty">該当する履歴がありません。</p>'}`;
}
function detail(product) {
  screen.innerHTML = '<a class="back" href="#inventory">← 在庫一覧</a>' + heading(product.name, product.code, `<a class="button" href="#product/${escapeHtml(product.id)}/edit">商品編集</a>`) + `
    <div class="detail-grid"><section class="card"><h2>現在の在庫</h2>${alertBadge(product)}<p class="stock-number">${escapeHtml(product.stock)} <small>${escapeHtml(product.unit)}</small></p><p class="hint">発注点：${escapeHtml(product.point)} ${escapeHtml(product.unit)}</p><div class="actions"><button class="primary" data-operation="IN" data-product="${escapeHtml(product.id)}">入庫</button><button ${demoMode ? '' : 'disabled title="準備中"'} data-operation="OUT" data-product="${escapeHtml(product.id)}">出庫</button></div></section><section class="card"><h2>商品情報</h2><dl><dt>商品コード</dt><dd>${escapeHtml(product.code)}</dd><dt>単位</dt><dd>${escapeHtml(product.unit)}</dd><dt>削除</dt><dd class="hint">論理削除は今後実装します。在庫0の商品が対象です。</dd></dl><button disabled>商品削除（準備中）</button></section></div><section class="card"><h2>この商品の入出庫・取消履歴</h2>${historyTable(movements.filter(m => m.productId === product.id))}</section>`;
}
function history() {
  screen.innerHTML = heading('入出庫・取消履歴', '元の取引を残し、取消の日時と理由を確認できます。') + `<section class="card"><div class="toolbar"><label>商品<select id="history-product"><option value="">すべての商品</option>${products.map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join('')}</select></label><label>種別<select id="history-type"><option value="">すべて</option><option value="IN">入庫</option><option value="OUT">出庫</option></select></label><button disabled>CSV出力（準備中）</button></div><div id="history-table"></div><p class="hint">期間・取消状態による絞り込みは今後追加します。</p></section>`;
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
  if (dataDirty && !demoMode && !savingProduct) { dataDirty = false; dbState = 'idle'; }
  const route = location.hash.slice(1) || 'inventory';
  const [page, id, action] = route.split('/');
  if (!demoMode && dbState !== 'ready' && !(page === 'product' && id === 'new')) {
    if (dbState === 'idle') loadNormalProducts();
    showDatabaseState();
    return;
  }
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
  if (!demoMode) screen.querySelectorAll('[data-operation]').forEach(button => { button.disabled = true; button.textContent += '（準備中）'; });
  announce('');
  screen.querySelector('h1').focus();
  if (!demoMode && page === 'product' && id === 'new' && dbState === 'idle') loadNormalProducts();
}
function openOperation(button) {
  if (!demoMode) { announce('入庫・出庫・取消は準備中です。'); return; }
  const type = button.dataset.operation;
  const movement = movements.find(m => m.id === button.dataset.movement);
  const product = productById(button.dataset.product || movement?.productId);
  if (!product || (type === 'CANCEL' && (!movement || cancellationFor(movement.id)))) return;
  const title = { IN: '入庫', OUT: '出庫', CANCEL: '取消' }[type];
  document.querySelector('#dialog-title').textContent = `${title}（デモ）`;
  document.querySelector('#dialog-content').innerHTML = `<div class="summary"><strong>${escapeHtml(product.name)}</strong><br><small>${escapeHtml(product.code)} ／ 現在庫：${escapeHtml(product.stock)} ${escapeHtml(product.unit)}</small></div>` + (type === 'CANCEL' ? `<p>対象：${escapeHtml(movement.date)} ／ ${movement.type === 'IN' ? '入庫' : '出庫'} ${escapeHtml(movement.quantity)} ${escapeHtml(product.unit)}</p><p class="hint">取消後の予定在庫：${escapeHtml(product.stock + (movement.type === 'IN' ? -movement.quantity : movement.quantity))} ${escapeHtml(product.unit)}（参考）</p><label class="field">取消理由<span class="required">必須</span><textarea id="cancel-reason" required maxlength="500" rows="3" placeholder="例：重複登録のため"></textarea><span class="hint">前後の空白を除き1〜500文字。取消日時とともに記録する予定です。</span></label>` : `<label class="field">${title}数量<span class="required">必須</span><input id="quantity" type="number" required min="1" step="1" value="1"></label><p id="planned-stock" class="hint" aria-live="polite"></p><label class="field">備考（任意）<textarea rows="2" maxlength="500"></textarea></label>` ) + '<p class="hint">画面確認用です。在庫や履歴は変更しません。</p>';
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
function updateMode() {
  setSaveResult(null);
  inventoryFilters.keyword = '';
  inventoryFilters.alertOnly = false;
  showDatabaseNotice();
  loadGeneration++;
  dataDirty = false;
  dbState = 'idle';
  InventoryDB.close();
  products = demoMode ? demoProducts : [];
  movements = demoMode ? demoMovements : [];
  cancellations = demoMode ? demoCancellations : [];
  document.querySelector('#mode-label').textContent = demoMode ? 'デモモード' : '通常モード';
  document.querySelector('#mode-toggle').textContent = demoMode ? '通常モードへ' : 'デモモードへ';
  document.querySelector('.demo-notice').textContent = demoMode
    ? 'デモモード：仮データです。入力確認・入出庫・取消の画面操作だけを試せます。データは保存しません。'
    : '通常モード：商品登録を保存できます。商品編集も保存できます。入庫・出庫・取消は利用できません。デモモードで画面を確認できます。';
}
document.querySelector('#mode-toggle').addEventListener('click', () => {
  if (savingProduct) return;
  if (document.querySelector('#product-form') && !window.confirm('入力内容は破棄されます。モードを切り替えますか？')) return;
  dialog.close();
  demoMode = !demoMode;
  updateMode();
  if (location.hash !== '#inventory') location.hash = 'inventory';
  else renderRoute();
});
InventoryDB.subscribeChanges(() => {
  if (demoMode) return;
  dataDirty = true;
  if (savingProduct) return;
  if (document.querySelector('#product-form')) {
    showDatabaseNotice('別のタブで商品データが変更されました。入力は保持しています。保存時に競合を確認します。');
    return;
  }
  renderRoute();
});
InventoryDB.subscribe(message => {
  if (demoMode) return;
  dbMessage = message;
  if (message.includes('更新待ち')) {
    const status = document.querySelector('#db-message');
    if (status) status.textContent = message;
    return;
  }
  loadGeneration++;
  dbState = 'error';
  products = [];
  showDatabaseNotice(message);
  if (!document.querySelector('#product-form')) renderRoute();
});
window.addEventListener('pagehide', () => InventoryDB.close());
window.addEventListener('pageshow', event => {
  if (!event.persisted || demoMode) return;
  // bfcacheはDOMと編集開始時のversionを保持しています。再作成せずDBだけを更新。
  dbState = 'idle';
  if (document.querySelector('#product-form')) loadNormalProducts();
  else renderRoute();
});
document.addEventListener('click', event => {
  if (savingProduct && event.target.closest('a')) { event.preventDefault(); announce('保存中です。完了までお待ちください。'); }
}, true);
updateMode();
window.addEventListener('hashchange', renderRoute);
renderRoute();
