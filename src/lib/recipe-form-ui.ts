import { wireIngredientAutocomplete } from './ingredient-autocomplete';
import { promptIngredientCategories } from './ingredient-category-prompt';
import type { IngredientSection } from './ingredient-sections';
import {
  collectCanonicalNames,
  emptyFormData,
  emptyIngredientRow,
  fetchFilterOptions,
  fetchIngredientNames,
  fetchKnownIngredients,
  loadRecipe,
  recipeToFormData,
  saveRecipe,
  findUnknownIngredients,
  UNIT_OPTIONS,
  type RecipeFormData,
} from './recipe-editor';

const inputClass =
  'w-full bg-surface border border-outline-soft rounded-2xl px-4 py-2.5 text-sm text-on-surface placeholder:text-outline focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary transition-colors';

const selectClass =
  'w-full bg-surface border border-outline-soft rounded-xl px-3 py-2.5 text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary transition-colors';

const btnSecondary =
  'inline-flex items-center gap-1.5 text-sm font-medium text-secondary border border-secondary/30 rounded-full px-3 py-1.5 hover:bg-secondary-container transition-colors';

const btnIcon =
  'shrink-0 w-9 h-9 flex items-center justify-center rounded-full text-on-surface-muted hover:bg-surface-container hover:text-primary transition-colors';

export async function initRecipeForm(editSlug: string | null) {
  const formEl = document.getElementById('recipe-form');
  const titleEl = document.getElementById('title') as HTMLInputElement | null;
  const categoryEl = document.getElementById('category') as HTMLInputElement | null;
  const proteinEl = document.getElementById('protein') as HTMLInputElement | null;
  const cookTimeEl = document.getElementById('cook-time') as HTMLInputElement | null;
  const sourceUrlEl = document.getElementById('source-url') as HTMLInputElement | null;
  const methodList = document.getElementById('method-list')!;
  const tipsList = document.getElementById('tips-list')!;
  const subsList = document.getElementById('subs-list')!;
  const ingredientsList = document.getElementById('ingredients-list')!;
  const formError = document.getElementById('form-error')!;
  const formSuccess = document.getElementById('form-success')!;
  const pageTitle = document.getElementById('page-title')!;
  const submitBtn = document.getElementById('submit-btn') as HTMLButtonElement | null;
  const categoryDatalist = document.getElementById('category-options')!;
  const proteinDatalist = document.getElementById('protein-options')!;

  if (!formEl || !titleEl || !methodList || !ingredientsList) return;

  let knownIngredients: string[] = [];

  const [filterOpts, known] = await Promise.all([
    fetchFilterOptions(),
    fetchKnownIngredients(),
  ]);
  knownIngredients = known;

  for (const c of filterOpts.categories) {
    categoryDatalist.appendChild(Object.assign(document.createElement('option'), { value: c }));
  }
  for (const p of filterOpts.proteins) {
    proteinDatalist.appendChild(Object.assign(document.createElement('option'), { value: p }));
  }

  let formData = emptyFormData();

  if (editSlug) {
    pageTitle.textContent = 'Edit recipe';
    if (submitBtn) submitBtn.textContent = 'Save changes';
    const cancelLink = document.querySelector('#recipe-form a[href="/"]') as HTMLAnchorElement | null;
    if (cancelLink) {
      cancelLink.href = `/recipes/${editSlug}`;
      cancelLink.textContent = 'Cancel';
    }

    try {
      const { recipe, ingredients } = await loadRecipe(editSlug);
      formData = recipeToFormData(recipe, ingredients);
    } catch {
      formError.textContent = 'Recipe not found or could not be loaded.';
      formError.classList.remove('hidden');
      return;
    }

    populateScalars(formData, { titleEl, categoryEl, proteinEl, cookTimeEl, sourceUrlEl });
    renderMethodSteps(methodList, formData.methodSteps);
    renderTextLines(tipsList, formData.tips, 'tip');
    renderTextLines(subsList, formData.substitutions, 'sub');
    renderIngredients(ingredientsList, formData.ingredients, knownIngredients, onIngredientChange);
  } else {
    renderMethodSteps(methodList, formData.methodSteps);
    renderTextLines(tipsList, formData.tips, 'tip');
    renderTextLines(subsList, formData.substitutions, 'sub');
    renderIngredients(ingredientsList, formData.ingredients, knownIngredients, onIngredientChange);
  }

  document.getElementById('add-method')?.addEventListener('click', () => {
    addMethodRow(methodList, '');
    focusLastInput(methodList);
  });

  document.getElementById('add-tip')?.addEventListener('click', () => {
    addTextLineRow(tipsList, 'tip', '');
    focusLastInput(tipsList);
  });

  document.getElementById('add-sub')?.addEventListener('click', () => {
    addTextLineRow(subsList, 'sub', '');
    focusLastInput(subsList);
  });

  document.getElementById('add-ingredient')?.addEventListener('click', () => {
    addIngredientRow(ingredientsList, emptyIngredientRow(), knownIngredients, onIngredientChange);
    focusLastInput(ingredientsList);
  });

  formEl.addEventListener('submit', async (e) => {
    e.preventDefault();
    formError.classList.add('hidden');
    formSuccess.classList.add('hidden');
    if (submitBtn) submitBtn.disabled = true;

    try {
      const data = collectFormData({
        titleEl, categoryEl, proteinEl, cookTimeEl, sourceUrlEl,
        methodList, tipsList, subsList, ingredientsList,
      });

      const registry = await fetchIngredientNames();
      const unknown = findUnknownIngredients(
        collectCanonicalNames(data.ingredients),
        registry,
      );

      let newCategories: Record<string, IngredientSection> = {};
      if (unknown.length > 0) {
        if (submitBtn) submitBtn.disabled = false;
        const picked = await promptIngredientCategories(unknown);
        if (!picked) return;
        newCategories = picked;
        if (submitBtn) submitBtn.disabled = true;
      }

      const { slug, isNew } = await saveRecipe(data, editSlug, newCategories);

      if (isNew) {
        formSuccess.textContent = 'Recipe created! It will appear on the site after the next deploy.';
        formSuccess.classList.remove('hidden');
        setTimeout(() => { window.location.href = `/recipes/${slug}`; }, 1500);
      } else {
        window.location.href = `/recipes/${slug}`;
      }
    } catch (err) {
      formError.textContent = err instanceof Error ? err.message : 'Something went wrong';
      formError.classList.remove('hidden');
      if (submitBtn) submitBtn.disabled = false;
    }
  });

  function onIngredientChange() {
    // reserved for future live preview
  }
}

function populateScalars(
  data: RecipeFormData,
  els: {
    titleEl: HTMLInputElement;
    categoryEl: HTMLInputElement | null;
    proteinEl: HTMLInputElement | null;
    cookTimeEl: HTMLInputElement | null;
    sourceUrlEl: HTMLInputElement | null;
  },
) {
  els.titleEl.value = data.title;
  if (els.categoryEl) els.categoryEl.value = data.category;
  if (els.proteinEl) els.proteinEl.value = data.protein;
  if (els.cookTimeEl) els.cookTimeEl.value = data.cookTimeMin;
  if (els.sourceUrlEl) els.sourceUrlEl.value = data.sourceUrl;
}

function collectFormData(els: {
  titleEl: HTMLInputElement;
  categoryEl: HTMLInputElement | null;
  proteinEl: HTMLInputElement | null;
  cookTimeEl: HTMLInputElement | null;
  sourceUrlEl: HTMLInputElement | null;
  methodList: HTMLElement;
  tipsList: HTMLElement;
  subsList: HTMLElement;
  ingredientsList: HTMLElement;
}): RecipeFormData {
  return {
    title: els.titleEl.value,
    category: els.categoryEl?.value ?? '',
    protein: els.proteinEl?.value ?? '',
    cookTimeMin: els.cookTimeEl?.value ?? '',
    sourceUrl: els.sourceUrlEl?.value ?? '',
    methodSteps: readTextInputs(els.methodList, '.method-input'),
    tips: readTextInputs(els.tipsList, '.tip-input'),
    substitutions: readTextInputs(els.subsList, '.sub-input'),
    ingredients: readIngredientRows(els.ingredientsList),
  };
}

function readTextInputs(container: HTMLElement, selector: string): string[] {
  return Array.from(container.querySelectorAll<HTMLInputElement>(selector))
    .map(el => el.value);
}

function readIngredientRows(container: HTMLElement) {
  return Array.from(container.querySelectorAll<HTMLElement>('.ingredient-row')).map(row => ({
    quantity: (row.querySelector('.ing-qty') as HTMLInputElement)?.value ?? '',
    unit: (row.querySelector('.ing-unit') as HTMLSelectElement)?.value ?? 'each',
    name: (row.querySelector('.ing-name') as HTMLInputElement)?.value ?? '',
    pickedCanonical: row.dataset.pickedCanonical ?? null,
  }));
}

function focusLastInput(container: HTMLElement) {
  const inputs = container.querySelectorAll('input, select, textarea');
  (inputs[inputs.length - 1] as HTMLElement)?.focus();
}

// ── Method steps ─────────────────────────────────────────────────────────────

function renderMethodSteps(container: HTMLElement, steps: string[]) {
  container.innerHTML = '';
  const rows = steps.length > 0 ? steps : [''];
  rows.forEach((text, i) => addMethodRow(container, text, i + 1));
}

function addMethodRow(container: HTMLElement, value: string, num?: number) {
  const index = num ?? container.querySelectorAll('.method-row').length + 1;
  const row = document.createElement('div');
  row.className = 'method-row flex items-start gap-2';
  row.innerHTML = `
    <span class="shrink-0 w-6 pt-2.5 text-sm font-medium text-on-surface-muted tabular-nums">${index}.</span>
    <input type="text" class="method-input flex-1 ${inputClass}" value="${escapeAttr(value)}" placeholder="Step ${index}" />
    <button type="button" class="remove-row ${btnIcon} mt-1" aria-label="Remove step">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
    </button>
  `;
  row.querySelector('.remove-row')?.addEventListener('click', () => {
    row.remove();
    renumberMethodSteps(container);
  });
  container.appendChild(row);
}

function renumberMethodSteps(container: HTMLElement) {
  container.querySelectorAll('.method-row').forEach((row, i) => {
    const num = row.querySelector('span');
    if (num) num.textContent = `${i + 1}.`;
    const input = row.querySelector('.method-input') as HTMLInputElement;
    if (input && !input.value) input.placeholder = `Step ${i + 1}`;
  });
}

// ── Tips / substitutions ─────────────────────────────────────────────────────

function renderTextLines(container: HTMLElement, lines: string[], kind: 'tip' | 'sub') {
  container.innerHTML = '';
  if (lines.length === 0) return;
  lines.forEach(text => addTextLineRow(container, kind, text));
}

function addTextLineRow(container: HTMLElement, kind: 'tip' | 'sub', value: string) {
  const row = document.createElement('div');
  row.className = 'flex items-start gap-2';
  row.innerHTML = `
    <span class="shrink-0 w-2 pt-2.5 text-on-surface-muted">•</span>
    <input type="text" class="${kind}-input flex-1 ${inputClass}" value="${escapeAttr(value)}" placeholder="${kind === 'tip' ? 'A helpful tip' : 'A substitution'}" />
    <button type="button" class="remove-row ${btnIcon} mt-1" aria-label="Remove">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
    </button>
  `;
  row.querySelector('.remove-row')?.addEventListener('click', () => row.remove());
  container.appendChild(row);
}

// ── Ingredients ──────────────────────────────────────────────────────────────

function renderIngredients(
  container: HTMLElement,
  rows: ReturnType<typeof emptyIngredientRow>[],
  known: string[],
  onChange: () => void,
) {
  container.innerHTML = '';
  rows.forEach(row => addIngredientRow(container, row, known, onChange));
}

function addIngredientRow(
  container: HTMLElement,
  row: ReturnType<typeof emptyIngredientRow>,
  known: string[],
  onChange: () => void,
) {
  const el = document.createElement('div');
  el.className = 'ingredient-row relative grid grid-cols-[4.5rem_6rem_1fr_auto] gap-2 items-start';
  if (row.pickedCanonical) el.dataset.pickedCanonical = row.pickedCanonical;

  const unitOptions = UNIT_OPTIONS.map(u =>
    `<option value="${u}"${u === row.unit ? ' selected' : ''}>${u}</option>`,
  ).join('');

  el.innerHTML = `
    <input type="number" step="any" min="0" class="ing-qty ${inputClass} !px-2 text-right tabular-nums" value="${escapeAttr(row.quantity)}" placeholder="Qty" />
    <select class="ing-unit ${selectClass}">${unitOptions}</select>
    <div class="relative min-w-0">
      <input type="text" class="ing-name ${inputClass}" value="${escapeAttr(row.name)}" placeholder="Ingredient" autocomplete="off" />
      <ul class="autocomplete-list hidden absolute z-10 left-0 right-0 top-full mt-1 bg-surface border border-outline-soft rounded-xl shadow-lg overflow-hidden max-h-48 overflow-y-auto"></ul>
    </div>
    <button type="button" class="remove-row ${btnIcon} mt-0.5" aria-label="Remove ingredient">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
    </button>
  `;

  const nameInput = el.querySelector('.ing-name') as HTMLInputElement;
  const list = el.querySelector('.autocomplete-list') as HTMLUListElement;

  wireIngredientAutocomplete(nameInput, list, known, (ing) => {
    row.dataset.pickedCanonical = ing;
    onChange();
  });

  el.querySelector('.remove-row')?.addEventListener('click', () => {
    el.remove();
    onChange();
  });

  nameInput.addEventListener('input', () => {
    delete el.dataset.pickedCanonical;
    onChange();
  });

  container.appendChild(el);
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

export { btnSecondary };
