import {
  addManualItem,
  clearAllItems,
  clearChecked,
  deleteItem,
  ensureIngredientForShopping,
  fetchIngredientRegistry,
  fetchShoppingList,
  lookupIngredientCategory,
  setItemOrder,
  subscribeShoppingList,
  updateItem,
  type ShoppingItem,
} from './shopping-list';
import { fetchShoppableIngredients } from './recipe-editor';
import { wireIngredientAutocomplete } from './ingredient-autocomplete';
import { promptIngredientCategories } from './ingredient-category-prompt';
import { normalizeIngredient } from './ingredient';
import {
  INGREDIENT_SECTION_ORDER,
  sectionDisplayLabel,
  type IngredientSection,
} from './ingredient-sections';
import { collectOrderedIds, setupShoppingListDrag } from './shopping-list-drag';

/** Soft inline fields — no stark white boxes. */
const inputSubtle =
  'bg-surface-container/50 border border-transparent rounded-lg px-2 py-1.5 text-xs text-on-surface-muted placeholder:text-outline/70 focus:text-on-surface focus:bg-surface-container focus:border-outline-soft/60 focus:outline-none transition-colors';

const selectSubtle =
  'bg-surface-container/50 border border-transparent rounded-lg px-1.5 py-1.5 text-xs text-on-surface-muted focus:text-on-surface focus:bg-surface-container focus:border-outline-soft/60 focus:outline-none transition-colors';

const UNIT_OPTIONS = ['g', 'each', 'pinch', 'dash', 'sprig', 'handful', 'cup', 'tsp', 'tbsp', 'ml', 'kg'];

const btnIcon =
  'shrink-0 w-9 h-9 flex items-center justify-center rounded-full text-outline hover:bg-surface-container hover:text-primary transition-colors';

const btnDelete =
  'shrink-0 w-9 h-9 flex items-center justify-center rounded-full text-outline/80 hover:bg-primary-container hover:text-primary transition-colors';

const GRIP_SVG = `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/></svg>`;

const DELETE_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;

const GROUPED_VIEW_KEY = 'yumlog-shopping-grouped';

let items: ShoppingItem[] = [];
let listEl: HTMLElement;
let emptyEl: HTMLElement;
let viewControlsEl: HTMLElement | null;
let groupByAisleToggle: HTMLButtonElement | null;
let groupedView = true;
let refreshing = false;
let dragging = false;

function loadGroupedPreference(): boolean {
  try {
    const stored = localStorage.getItem(GROUPED_VIEW_KEY);
    if (stored === 'false') return false;
    if (stored === 'true') return true;
  } catch { /* private browsing */ }
  return true;
}

function saveGroupedPreference(grouped: boolean): void {
  try {
    localStorage.setItem(GROUPED_VIEW_KEY, grouped ? 'true' : 'false');
  } catch { /* ignore */ }
}

function syncViewToggle(): void {
  if (!viewControlsEl || !groupByAisleToggle) return;

  viewControlsEl.classList.toggle('hidden', items.length === 0);
  groupByAisleToggle.setAttribute('aria-checked', groupedView ? 'true' : 'false');
  groupByAisleToggle.classList.toggle('bg-primary', groupedView);
  groupByAisleToggle.classList.toggle('bg-outline-soft/70', !groupedView);

  const thumb = groupByAisleToggle.querySelector('.switch-thumb');
  if (thumb) {
    thumb.classList.toggle('translate-x-5', groupedView);
    thumb.classList.toggle('translate-x-0', !groupedView);
  }
}

export async function initShoppingListUI() {
  listEl = document.getElementById('shopping-list')!;
  emptyEl = document.getElementById('shopping-empty')!;
  const addForm = document.getElementById('add-item-form') as HTMLFormElement;
  const clearBtn = document.getElementById('clear-checked')!;
  const clearAllBtn = document.getElementById('clear-all')!;
  const clearAllDialog = document.getElementById('clear-all-dialog')!;
  const clearAllCancel = document.getElementById('clear-all-cancel')!;
  const clearAllConfirm = document.getElementById('clear-all-confirm')!;
  const errorEl = document.getElementById('shopping-error')!;
  viewControlsEl = document.getElementById('list-view-controls');
  groupByAisleToggle = document.getElementById('group-by-aisle') as HTMLButtonElement | null;
  groupedView = loadGroupedPreference();
  syncViewToggle();

  groupByAisleToggle?.addEventListener('click', () => {
    groupedView = !groupedView;
    saveGroupedPreference(groupedView);
    syncViewToggle();
    render();
  });

  const knownIngredients = await fetchShoppableIngredients();
  const addNameInput = document.getElementById('add-name') as HTMLInputElement;
  const addSuggestions = document.getElementById('add-name-suggestions') as HTMLUListElement;

  if (addNameInput && addSuggestions) {
    wireIngredientAutocomplete(addNameInput, addSuggestions, knownIngredients, (ing) => {
      addNameInput.value = ing;
    });
  }

  await refresh();

  setupShoppingListDrag(
    listEl,
    () => { void persistOrder(); },
    (isDragging) => { dragging = isDragging; },
  );

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
      const canonical = normalizeIngredient(name);
      if (!canonical) throw new Error('Enter an ingredient name');

      const registry = await fetchIngredientRegistry();
      let category: string | null = null;

      if (!registry.has(canonical)) {
        const picked = await promptIngredientCategories([canonical]);
        if (!picked) return;
        await ensureIngredientForShopping(name, picked[canonical]);
        category = picked[canonical];
      } else {
        category = await lookupIngredientCategory(name);
        if (!category) {
          errorEl.textContent = 'That ingredient isn’t shopped for — it won’t be added to the list.';
          errorEl.classList.remove('hidden');
          return;
        }
      }

      const quantity = parseQty(qtyRaw);
      await addManualItem(name, quantity, unit, category);
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

  function openClearAllDialog() {
    clearAllDialog.classList.remove('hidden');
    clearAllCancel.focus();
  }

  function closeClearAllDialog() {
    clearAllDialog.classList.add('hidden');
  }

  clearAllBtn?.addEventListener('click', openClearAllDialog);
  clearAllCancel?.addEventListener('click', closeClearAllDialog);
  clearAllDialog.querySelector('[data-dialog-backdrop]')?.addEventListener('click', closeClearAllDialog);

  clearAllConfirm?.addEventListener('click', async () => {
    closeClearAllDialog();
    try {
      await clearAllItems();
      await refresh();
    } catch (err) {
      errorEl.textContent = err instanceof Error ? err.message : 'Could not clear list';
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

async function persistOrder() {
  const ids = collectOrderedIds(listEl, INGREDIENT_SECTION_ORDER);
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

function groupBySection(allItems: ShoppingItem[]): Map<string, ShoppingItem[]> {
  const groups = new Map<string, ShoppingItem[]>();

  for (const item of allItems) {
    const key = item.category ?? '';
    const list = groups.get(key) ?? [];
    list.push(item);
    groups.set(key, list);
  }

  for (const list of groups.values()) {
    list.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  }

  return groups;
}

function render() {
  listEl.innerHTML = '';
  emptyEl.classList.toggle('hidden', items.length > 0);
  const hasItems = items.length > 0;
  document.getElementById('clear-checked')?.classList.toggle('hidden', !items.some(i => i.checked));
  document.getElementById('clear-all')?.classList.toggle('hidden', !hasItems);
  syncViewToggle();

  if (!hasItems) return;

  if (groupedView) {
    renderGrouped();
  } else {
    listEl.appendChild(buildFlatList(items));
  }
}

function renderGrouped() {
  const groups = groupBySection(items);

  for (const sectionKey of INGREDIENT_SECTION_ORDER) {
    const sectionItems = groups.get(sectionKey);
    if (!sectionItems?.length) continue;
    listEl.appendChild(buildSection(sectionKey as IngredientSection, sectionItems));
  }

  const uncategorised = groups.get('');
  if (uncategorised?.length) {
    listEl.appendChild(buildSection('' as IngredientSection, uncategorised, 'Other'));
  }
}

function buildFlatList(allItems: ShoppingItem[]): HTMLElement {
  const ul = document.createElement('ul');
  ul.className =
    'shopping-section flex flex-col bg-surface-low/60 rounded-2xl px-2 py-1 divide-y divide-outline-soft/50 list-none m-0';
  ul.dataset.flat = 'true';

  const sorted = [...allItems].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  for (const item of sorted) {
    ul.appendChild(buildRow(item));
  }

  return ul;
}

function buildSection(
  sectionKey: IngredientSection | '',
  sectionItems: ShoppingItem[],
  labelOverride?: string,
): HTMLElement {
  const group = document.createElement('section');
  group.className = 'shopping-group mb-5 last:mb-0';

  const label = labelOverride ?? sectionDisplayLabel(sectionKey as IngredientSection);
  group.innerHTML = `
    <h2 class="font-serif text-base font-bold text-on-surface mb-2 px-1">${escapeHtml(label)}</h2>
  `;

  const ul = document.createElement('ul');
  ul.className =
    'shopping-section flex flex-col bg-surface-low/60 rounded-2xl px-2 py-1 divide-y divide-outline-soft/50 list-none m-0';
  ul.dataset.section = sectionKey;

  for (const item of sectionItems) {
    ul.appendChild(buildRow(item));
  }

  group.appendChild(ul);
  return group;
}

function buildRow(item: ShoppingItem): HTMLElement {
  const row = document.createElement('li');
  row.className = [
    'shopping-row flex items-center gap-2 py-2.5 transition-[opacity,background-color] duration-150',
    item.checked ? 'opacity-50' : '',
  ].join(' ');
  row.dataset.id = String(item.id);

  const unitOptions = UNIT_OPTIONS.map(u =>
    `<option value="${u}"${(item.unit ?? 'each') === u ? ' selected' : ''}>${u}</option>`,
  ).join('');

  row.innerHTML = `
    <button type="button" class="delete-item ${btnDelete}" aria-label="Remove ${escapeAttr(item.ingredient)}">
      ${DELETE_SVG}
    </button>
    <div class="row-qty-zone flex items-center gap-1 shrink-0 py-1.5 px-2 -my-1 rounded-xl touch-manipulation">
      <input type="text" inputmode="decimal" class="item-qty w-[3.75rem] ${inputSubtle} text-right tabular-nums" value="${item.quantity != null ? item.quantity : ''}" placeholder="qty" aria-label="Quantity for ${escapeAttr(item.ingredient)}" />
      <select class="item-unit w-[4rem] ${selectSubtle}" aria-label="Unit for ${escapeAttr(item.ingredient)}">${unitOptions}</select>
    </div>
    <span class="item-name flex-1 min-w-0 text-sm text-on-surface truncate px-1 ${item.checked ? 'line-through' : ''}">${escapeHtml(item.ingredient)}</span>
    <input type="checkbox" class="item-checked shrink-0 w-5 h-5 rounded accent-primary touch-manipulation" ${item.checked ? 'checked' : ''} aria-label="Mark ${escapeAttr(item.ingredient)} as done" />
    <button type="button" class="drag-handle shrink-0 touch-none p-1.5 -mr-0.5 text-outline/80 hover:text-on-surface-muted cursor-grab active:cursor-grabbing active:text-primary rounded-full hover:bg-surface-container transition-colors" aria-label="Drag to reorder ${escapeAttr(item.ingredient)}" data-drag-handle>
      ${GRIP_SVG}
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

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
