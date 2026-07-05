import { supabase } from './supabase';
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

  if (!editSlug) {
    initImportPanel({
      titleEl, categoryEl, proteinEl, cookTimeEl, sourceUrlEl,
      methodList, tipsList, subsList, ingredientsList,
      knownIngredients,
      categories: filterOpts.categories,
      onIngredientChange,
    });
  }

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

// ── Import from URL ──────────────────────────────────────────────────────────

interface ImportPanelRefs {
  titleEl: HTMLInputElement;
  categoryEl: HTMLInputElement | null;
  proteinEl: HTMLInputElement | null;
  cookTimeEl: HTMLInputElement | null;
  sourceUrlEl: HTMLInputElement | null;
  methodList: HTMLElement;
  tipsList: HTMLElement;
  subsList: HTMLElement;
  ingredientsList: HTMLElement;
  knownIngredients: string[];
  categories: string[];
  onIngredientChange: () => void;
}

interface ImportedIngredient {
  quantity: number | null;
  unit: string;
  text: string;
}

interface ImportedRecipe {
  title: string;
  category: string | null;
  protein: string | null;
  cook_time_min: number | null;
  ingredients: ImportedIngredient[];
  method: string[];
  tips: string[];
  substitutions: string[];
}

class ImportError extends Error {}

function initImportPanel(refs: ImportPanelRefs) {
  const urlInput = document.getElementById('import-url') as HTMLInputElement | null;
  const importBtn = document.getElementById('import-btn') as HTMLButtonElement | null;
  const statusEl = document.getElementById('import-status');
  const errorEl = document.getElementById('import-error');
  const banner = document.getElementById('import-success-banner');
  const bannerDismiss = document.getElementById('import-success-dismiss');

  if (!urlInput || !importBtn || !statusEl || !errorEl) return;

  bannerDismiss?.addEventListener('click', () => banner?.classList.add('hidden'));

  importBtn.addEventListener('click', async () => {
    const url = urlInput.value.trim();
    errorEl.classList.add('hidden');
    statusEl.classList.add('hidden');

    if (!url) {
      errorEl.textContent = 'Paste a recipe URL first.';
      errorEl.classList.remove('hidden');
      return;
    }

    if (formHasContent(refs) && !(await confirmOverwrite())) return;

    importBtn.disabled = true;
    statusEl.textContent = 'Fetching recipe…';
    statusEl.classList.remove('hidden');

    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      if (!token) {
        throw new ImportError('Your session has expired — log in again.');
      }

      const res = await fetch('/api/import-recipe', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ url, known_ingredients: refs.knownIngredients }),
      });

      const body = await res.json().catch(() => null);

      if (!res.ok) {
        throw new ImportError(importErrorMessage(res.status, body));
      }

      const { source_url, recipe } = body as { source_url: string; recipe: ImportedRecipe };
      populateFromImport(refs, source_url, recipe);
      banner?.classList.remove('hidden');
      statusEl.classList.add('hidden');
    } catch (err) {
      errorEl.textContent = err instanceof ImportError ? err.message : "Couldn't reach the import service. Try again.";
      errorEl.classList.remove('hidden');
      statusEl.classList.add('hidden');
    } finally {
      importBtn.disabled = false;
    }
  });
}

function importErrorMessage(status: number, body: unknown): string {
  const serverMessage =
    body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string'
      ? (body as { error: string }).error
      : null;

  if (status === 401) return 'Your session has expired — log in again.';
  if (status === 400 || status === 422) return "Couldn't read that page — try entering it manually.";
  if (status === 502) return 'The import service hiccupped — try again.';
  return serverMessage ?? 'Something went wrong importing that recipe.';
}

function formHasContent(refs: ImportPanelRefs): boolean {
  if (refs.titleEl.value.trim()) return true;
  if (refs.categoryEl?.value.trim()) return true;
  if (refs.proteinEl?.value.trim()) return true;
  if (refs.cookTimeEl?.value.trim()) return true;
  if (refs.sourceUrlEl?.value.trim()) return true;
  if (readTextInputs(refs.methodList, '.method-input').some(v => v.trim())) return true;
  if (readTextInputs(refs.tipsList, '.tip-input').some(v => v.trim())) return true;
  if (readTextInputs(refs.subsList, '.sub-input').some(v => v.trim())) return true;
  if (readIngredientRows(refs.ingredientsList).some(r => r.name.trim() || r.quantity.trim())) return true;
  return false;
}

function confirmOverwrite(): Promise<boolean> {
  return new Promise(resolve => {
    const dialog = document.createElement('div');
    dialog.className = 'fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'import-overwrite-title');
    dialog.innerHTML = `
      <div class="absolute inset-0 bg-on-surface/25 backdrop-blur-[2px]" data-dialog-backdrop></div>
      <div class="relative w-full sm:max-w-sm bg-surface rounded-2xl border border-outline-soft shadow-xl overflow-hidden">
        <div class="bg-primary-container/40 px-5 pt-5 pb-4">
          <p class="text-xs font-medium text-on-surface-muted uppercase tracking-widest mb-1">Just checking</p>
          <h2 id="import-overwrite-title" class="font-serif text-xl font-bold text-on-surface leading-snug">Replace what you've entered?</h2>
        </div>
        <div class="px-5 py-4">
          <p class="text-sm text-on-surface-muted leading-relaxed">Importing will overwrite the fields you've already filled in.</p>
        </div>
        <div class="px-5 pb-5 pt-2 flex gap-3 border-t border-outline-soft/40">
          <button type="button" data-cancel class="flex-1 rounded-xl px-4 py-2.5 text-sm font-medium text-on-surface-muted bg-surface-container hover:bg-surface-container/80 transition-colors">
            Cancel
          </button>
          <button type="button" data-confirm class="flex-1 rounded-xl px-4 py-2.5 text-sm font-medium text-on-primary bg-primary hover:opacity-90 transition-opacity">
            Import anyway
          </button>
        </div>
      </div>
    `;

    function close(result: boolean) {
      dialog.remove();
      document.body.style.overflow = '';
      resolve(result);
    }

    dialog.querySelector('[data-dialog-backdrop]')?.addEventListener('click', () => close(false));
    dialog.querySelector('[data-cancel]')?.addEventListener('click', () => close(false));
    dialog.querySelector('[data-confirm]')?.addEventListener('click', () => close(true));

    document.body.style.overflow = 'hidden';
    document.body.appendChild(dialog);
  });
}

function populateFromImport(refs: ImportPanelRefs, sourceUrl: string, recipe: ImportedRecipe) {
  refs.titleEl.value = recipe.title ?? '';

  if (refs.categoryEl) {
    refs.categoryEl.value = recipe.category && refs.categories.includes(recipe.category) ? recipe.category : '';
  }
  if (refs.proteinEl) refs.proteinEl.value = recipe.protein ?? '';
  if (refs.cookTimeEl) refs.cookTimeEl.value = recipe.cook_time_min != null ? String(recipe.cook_time_min) : '';
  if (refs.sourceUrlEl) refs.sourceUrlEl.value = sourceUrl ?? '';

  renderMethodSteps(refs.methodList, recipe.method ?? []);
  renderTextLines(refs.tipsList, recipe.tips ?? [], 'tip');
  renderTextLines(refs.subsList, recipe.substitutions ?? [], 'sub');

  const ingredientRows = (recipe.ingredients ?? []).map(ing => ({
    quantity: ing.quantity != null ? String(ing.quantity) : '',
    unit: normaliseImportUnit(ing.unit),
    name: ing.text,
    pickedCanonical: null,
  }));
  renderIngredients(
    refs.ingredientsList,
    ingredientRows.length > 0 ? ingredientRows : [emptyIngredientRow()],
    refs.knownIngredients,
    refs.onIngredientChange,
  );
}

function normaliseImportUnit(unit: string): string {
  return (UNIT_OPTIONS as readonly string[]).includes(unit) ? unit : 'each';
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
    el.dataset.pickedCanonical = ing;
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
