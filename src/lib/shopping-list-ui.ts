import {
  addManualItem,
  clearChecked,
  deleteItem,
  fetchShoppingList,
  setItemOrder,
  subscribeShoppingList,
  updateItem,
  type ShoppingItem,
} from './shopping-list';
import { fetchKnownIngredients } from './recipe-editor';
import { wireIngredientAutocomplete } from './ingredient-autocomplete';

/** Soft inline fields — no stark white boxes. */
const inputSubtle =
  'bg-surface-container/50 border border-transparent rounded-lg px-2 py-1 text-xs text-on-surface-muted placeholder:text-outline/70 focus:text-on-surface focus:bg-surface-container focus:border-outline-soft/60 focus:outline-none transition-colors';

const selectSubtle =
  'bg-surface-container/50 border border-transparent rounded-lg px-1.5 py-1 text-xs text-on-surface-muted focus:text-on-surface focus:bg-surface-container focus:border-outline-soft/60 focus:outline-none transition-colors';

const UNIT_OPTIONS = ['g', 'each', 'pinch', 'dash', 'sprig', 'handful', 'cup', 'tsp', 'tbsp', 'ml', 'kg'];

const btnIcon =
  'shrink-0 w-9 h-9 flex items-center justify-center rounded-full text-outline hover:bg-surface-container hover:text-primary transition-colors';

const GRIP_SVG = `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/></svg>`;

let items: ShoppingItem[] = [];
let listEl: HTMLElement;
let emptyEl: HTMLElement;
let refreshing = false;
let dragging = false;

export async function initShoppingListUI() {
  listEl = document.getElementById('shopping-list')!;
  emptyEl = document.getElementById('shopping-empty')!;
  const addForm = document.getElementById('add-item-form') as HTMLFormElement;
  const clearBtn = document.getElementById('clear-checked')!;
  const errorEl = document.getElementById('shopping-error')!;

  const knownIngredients = await fetchKnownIngredients();
  const addNameInput = document.getElementById('add-name') as HTMLInputElement;
  const addSuggestions = document.getElementById('add-name-suggestions') as HTMLUListElement;

  if (addNameInput && addSuggestions) {
    wireIngredientAutocomplete(addNameInput, addSuggestions, knownIngredients, (ing) => {
      addNameInput.value = ing;
    });
  }

  await refresh();
  setupDragReorder(listEl);

  subscribeShoppingList(() => {
    if (!refreshing && !dragging) refresh();
  });

  addForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.classList.add('hidden');

    const name = addNameInput.value;
    const qtyRaw = (document.getElementById('add-qty') as HTMLInputElement).value;
    const unit = (document.getElementById('add-unit') as HTMLSelectElement).value;

    try {
      const quantity = parseQty(qtyRaw);
      await addManualItem(name, quantity, unit);
      addForm.reset();
      (document.getElementById('add-unit') as HTMLSelectElement).value = 'each';
      await refresh();
    } catch (err) {
      errorEl.textContent = err instanceof Error ? err.message : 'Could not add item';
      errorEl.classList.remove('hidden');
    }
  });

  clearBtn?.addEventListener('click', async () => {
    try {
      await clearChecked();
      await refresh();
    } catch (err) {
      errorEl.textContent = err instanceof Error ? err.message : 'Could not clear items';
      errorEl.classList.remove('hidden');
    }
  });
}

function parseQty(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

async function refresh() {
  refreshing = true;
  try {
    items = await fetchShoppingList();
    render();
  } finally {
    refreshing = false;
  }
}

function render() {
  listEl.innerHTML = '';
  emptyEl.classList.toggle('hidden', items.length > 0);
  document.getElementById('clear-checked')?.classList.toggle('hidden', !items.some(i => i.checked));

  for (const item of items) {
    listEl.appendChild(buildRow(item));
  }
}

function buildRow(item: ShoppingItem): HTMLElement {
  const row = document.createElement('li');
  row.className = [
    'shopping-row flex items-center gap-1.5 py-2.5 border-b border-outline-soft/60 last:border-b-0',
    item.checked ? 'opacity-50' : '',
  ].join(' ');
  row.dataset.id = String(item.id);

  const unitOptions = UNIT_OPTIONS.map(u =>
    `<option value="${u}"${(item.unit ?? 'each') === u ? ' selected' : ''}>${u}</option>`,
  ).join('');

  row.innerHTML = `
    <button type="button" class="drag-handle shrink-0 touch-none p-1 -ml-0.5 text-outline/80 hover:text-on-surface-muted cursor-grab active:cursor-grabbing active:text-primary" aria-label="Drag to reorder" data-drag-handle>
      ${GRIP_SVG}
    </button>
    <input type="checkbox" class="item-checked shrink-0 w-4 h-4 rounded accent-primary" ${item.checked ? 'checked' : ''} aria-label="Mark ${escapeHtml(item.ingredient)} as done" />
    <span class="item-name flex-1 min-w-0 text-sm text-on-surface truncate ${item.checked ? 'line-through' : ''}">${escapeHtml(item.ingredient)}</span>
    <input type="text" inputmode="decimal" class="item-qty w-[4.25rem] shrink-0 ${inputSubtle} text-right tabular-nums" value="${item.quantity != null ? item.quantity : ''}" placeholder="qty" aria-label="Quantity" />
    <select class="item-unit w-[4.25rem] shrink-0 ${selectSubtle}" aria-label="Unit">${unitOptions}</select>
    <button type="button" class="delete-item ${btnIcon}" aria-label="Delete">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
    </button>
  `;

  const checkbox = row.querySelector('.item-checked') as HTMLInputElement;
  const qtyInput = row.querySelector('.item-qty') as HTMLInputElement;
  const unitSelect = row.querySelector('.item-unit') as HTMLSelectElement;
  const nameEl = row.querySelector('.item-name') as HTMLElement;

  checkbox.addEventListener('change', async () => {
    const checked = checkbox.checked;
    row.classList.toggle('opacity-50', checked);
    nameEl.classList.toggle('line-through', checked);
    try {
      await updateItem(item.id, { checked });
      item.checked = checked;
      document.getElementById('clear-checked')?.classList.toggle('hidden', !items.some(i => i.checked));
    } catch {
      checkbox.checked = !checked;
    }
  });

  const saveQtyUnit = async () => {
    const quantity = parseQty(qtyInput.value);
    const unit = unitSelect.value;
    try {
      await updateItem(item.id, { quantity, unit });
      item.quantity = quantity;
      item.unit = unit;
    } catch {
      qtyInput.value = item.quantity != null ? String(item.quantity) : '';
      unitSelect.value = item.unit ?? 'each';
    }
  };

  qtyInput.addEventListener('change', saveQtyUnit);
  qtyInput.addEventListener('blur', saveQtyUnit);
  unitSelect.addEventListener('change', saveQtyUnit);

  row.querySelector('.delete-item')?.addEventListener('click', async () => {
    try {
      await deleteItem(item.id);
      await refresh();
    } catch { /* ignore */ }
  });

  return row;
}

/** Pointer-based drag reorder — works on touch and mouse. */
function setupDragReorder(container: HTMLElement) {
  let activeRow: HTMLElement | null = null;
  let pointerId: number | null = null;

  function endDrag() {
    if (!activeRow) return;
    activeRow.classList.remove('shadow-sm', 'bg-surface-low', 'relative', 'z-10', 'rounded-xl');
    activeRow = null;
    pointerId = null;
    dragging = false;
  }

  async function persistOrder() {
    const ids = [...container.querySelectorAll<HTMLElement>('.shopping-row')]
      .map(row => Number(row.dataset.id))
      .filter(id => !Number.isNaN(id));

    if (ids.length === 0) return;

    try {
      await setItemOrder(ids);
      items = ids
        .map(id => items.find(i => i.id === id))
        .filter((i): i is ShoppingItem => i != null);
    } catch {
      await refresh();
    }
  }

  container.addEventListener('pointerdown', (e) => {
    const handle = (e.target as HTMLElement).closest('[data-drag-handle]');
    if (!handle) return;

    const row = handle.closest('.shopping-row') as HTMLElement | null;
    if (!row) return;

    e.preventDefault();
    activeRow = row;
    pointerId = e.pointerId;
    dragging = true;
    (handle as HTMLElement).setPointerCapture(pointerId);
    row.classList.add('shadow-sm', 'bg-surface-low', 'relative', 'z-10', 'rounded-xl');
  });

  container.addEventListener('pointermove', (e) => {
    if (!activeRow || e.pointerId !== pointerId) return;

    const siblings = [...container.querySelectorAll<HTMLElement>('.shopping-row')].filter(r => r !== activeRow);
    const y = e.clientY;
    let placed = false;

    for (const sibling of siblings) {
      const rect = sibling.getBoundingClientRect();
      if (y < rect.top + rect.height / 2) {
        container.insertBefore(activeRow, sibling);
        placed = true;
        break;
      }
    }

    if (!placed) {
      container.appendChild(activeRow);
    }
  });

  container.addEventListener('pointerup', async (e) => {
    if (!activeRow || e.pointerId !== pointerId) return;
    endDrag();
    await persistOrder();
  });

  container.addEventListener('pointercancel', () => {
    endDrag();
  });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
