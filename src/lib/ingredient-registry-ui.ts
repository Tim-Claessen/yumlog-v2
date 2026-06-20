import {
  INGREDIENT_SECTIONS,
  sectionDisplayLabel,
  type IngredientSection,
} from './ingredient-sections';
import {
  categoryToSelectValue,
  deleteCanonicalIngredient,
  fetchAllCanonicalIngredients,
  getRecipesUsing,
  getReferenceCounts,
  ingredientExists,
  mergeCanonicalIngredients,
  renameCanonicalIngredient,
  selectValueToCategory,
  updateIngredientCategory,
  validateCanonicalName,
  type CanonicalIngredient,
  type RecipeUsage,
} from './ingredient-registry';

const inputClass =
  'w-full bg-surface-container/50 border border-transparent rounded-xl px-3 py-2.5 text-sm text-on-surface-muted focus:text-on-surface focus:bg-surface-container focus:border-outline-soft/60 focus:outline-none transition-colors';

const selectClass = inputClass;

interface RowDraft {
  name: string;
  categoryValue: string;
}

type ConfirmTone = 'primary' | 'secondary';

interface ConfirmOptions {
  eyebrow: string;
  title: string;
  body: string;
  confirmLabel: string;
  tone?: ConfirmTone;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function categoryLabel(category: IngredientSection | null): string {
  return category ? sectionDisplayLabel(category) : 'Not shopped';
}

function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  return new Promise(resolve => {
    const dialog = document.createElement('div');
    dialog.className =
      'fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');

    const confirmClass =
      opts.tone === 'secondary'
        ? 'flex-1 rounded-xl px-4 py-2.5 text-sm font-medium text-on-primary bg-secondary hover:opacity-90 transition-opacity'
        : 'flex-1 rounded-xl px-4 py-2.5 text-sm font-medium text-on-primary bg-primary hover:opacity-90 transition-opacity';

    dialog.innerHTML = `
      <div class="absolute inset-0 bg-on-surface/25 backdrop-blur-[2px]" data-dialog-backdrop></div>
      <div class="relative w-full sm:max-w-md bg-surface rounded-2xl border border-outline-soft shadow-xl overflow-hidden">
        <div class="bg-primary-container/40 px-5 pt-5 pb-4">
          <p class="text-xs font-medium text-on-surface-muted uppercase tracking-widest mb-1">${escapeHtml(opts.eyebrow)}</p>
          <h2 class="font-serif text-xl font-bold text-on-surface leading-snug">${escapeHtml(opts.title)}</h2>
        </div>
        <div class="px-5 py-4">
          <p class="text-sm text-on-surface-muted leading-relaxed">${opts.body}</p>
          <div class="flex gap-3 mt-5">
            <button type="button" data-cancel class="flex-1 rounded-xl px-4 py-2.5 text-sm font-medium text-on-surface-muted bg-surface-container hover:bg-surface-container/80 transition-colors">
              Cancel
            </button>
            <button type="button" data-confirm class="${confirmClass}">
              ${escapeHtml(opts.confirmLabel)}
            </button>
          </div>
        </div>
      </div>
    `;

    const close = (result: boolean) => {
      dialog.remove();
      document.body.style.overflow = '';
      resolve(result);
    };

    dialog.querySelector('[data-dialog-backdrop]')?.addEventListener('click', () => close(false));
    dialog.querySelector('[data-cancel]')?.addEventListener('click', () => close(false));
    dialog.querySelector('[data-confirm]')?.addEventListener('click', () => close(true));

    document.body.style.overflow = 'hidden';
    document.body.appendChild(dialog);
    dialog.querySelector<HTMLButtonElement>('[data-confirm]')?.focus();
  });
}

function showUsedInDialog(name: string, recipes: RecipeUsage[]): void {
  const dialog = document.createElement('div');
  dialog.className =
    'fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');

  const list =
    recipes.length === 0
      ? '<p class="text-sm text-on-surface-muted">Not used in any recipes.</p>'
      : `<ul class="flex flex-col gap-2 max-h-[50vh] overflow-y-auto">${recipes
          .map(
            r => `<li><a href="/recipes/${encodeURIComponent(r.slug)}" class="text-sm font-medium text-primary hover:underline">${escapeHtml(r.title)}</a></li>`,
          )
          .join('')}</ul>`;

  dialog.innerHTML = `
    <div class="absolute inset-0 bg-on-surface/25 backdrop-blur-[2px]" data-dialog-backdrop></div>
    <div class="relative w-full sm:max-w-md bg-surface rounded-2xl border border-outline-soft shadow-xl overflow-hidden max-h-[90vh] flex flex-col">
      <div class="bg-primary-container/40 px-5 pt-5 pb-4 shrink-0">
        <p class="text-xs font-medium text-on-surface-muted uppercase tracking-widest mb-1">Used in</p>
        <h2 class="font-serif text-xl font-bold text-on-surface leading-snug">${escapeHtml(name)}</h2>
        <p class="text-sm text-on-surface-muted mt-1">${recipes.length} recipe${recipes.length === 1 ? '' : 's'} — view only</p>
      </div>
      <div class="px-5 py-4 overflow-y-auto">${list}</div>
      <div class="px-5 pb-5 pt-2 shrink-0 border-t border-outline-soft/40">
        <button type="button" data-close class="w-full rounded-xl px-4 py-2.5 text-sm font-medium text-on-surface-muted bg-surface-container hover:bg-surface-container/80 transition-colors">
          Close
        </button>
      </div>
    </div>
  `;

  const close = () => {
    dialog.remove();
    document.body.style.overflow = '';
  };

  dialog.querySelector('[data-dialog-backdrop]')?.addEventListener('click', close);
  dialog.querySelector('[data-close]')?.addEventListener('click', close);

  document.body.style.overflow = 'hidden';
  document.body.appendChild(dialog);
}

function sectionOptions(selected: string): string {
  const notShoppedSel = selected === '' ? ' selected' : '';
  const opts = [`<option value=""${notShoppedSel}>Not shopped (recipes only)</option>`];
  for (const section of INGREDIENT_SECTIONS) {
    const sel = section === selected ? ' selected' : '';
    opts.push(`<option value="${section}"${sel}>${sectionDisplayLabel(section)}</option>`);
  }
  return opts.join('');
}

function recipeCountLabel(count: number): string {
  if (count === 0) return '—';
  return `${count} recipe${count === 1 ? '' : 's'}`;
}

const TABLE_CLASS = 'w-full table-fixed text-left border-collapse';
const COLGROUP = `
  <colgroup>
    <col />
    <col class="w-[30%] sm:w-[26%]" />
    <col class="w-[24%] sm:w-[20%]" />
    <col class="w-[4.75rem]" />
  </colgroup>
`;
const TH_CLASS =
  'px-4 py-2.5 text-xs font-medium text-on-surface-muted uppercase tracking-wide align-bottom';
const TD_CLASS = 'px-4 py-3 align-middle min-w-0';
const TD_USED_IN = 'px-4 py-3 align-top min-w-0';
const TD_EDIT = 'px-3 py-3 align-middle w-[4.75rem] text-right';

export async function initIngredientRegistryUI(): Promise<void> {
  const listEl = document.getElementById('ingredient-registry-list');
  const searchEl = document.getElementById('ingredient-search') as HTMLInputElement | null;
  const statusEl = document.getElementById('registry-status');
  if (!listEl) return;

  let ingredients: CanonicalIngredient[] = [];
  let referenceByName = new Map<string, { distinctRecipes: number; shoppingListRows: number }>();
  let filter = '';

  const setStatus = (message: string, isError = false) => {
    if (!statusEl) return;
    statusEl.textContent = message;
    statusEl.classList.toggle('text-primary', isError);
    statusEl.classList.toggle('text-on-surface-muted', !isError);
  };

  const load = async () => {
    setStatus('Loading…');
    ingredients = await fetchAllCanonicalIngredients();
    referenceByName = new Map();

    await Promise.all(
      ingredients.map(async ing => {
        const counts = await getReferenceCounts(ing.name);
        referenceByName.set(ing.name, {
          distinctRecipes: counts.distinctRecipes,
          shoppingListRows: counts.shoppingListRows,
        });
      }),
    );

    render();
    setStatus(`${ingredients.length} canonical ingredient${ingredients.length === 1 ? '' : 's'}`);
  };

  const filtered = () => {
    const q = filter.trim().toLowerCase();
    if (!q) return ingredients;
    return ingredients.filter(ing => ing.name.includes(q));
  };

  const render = () => {
    const rows = filtered();
    if (rows.length === 0) {
      listEl.innerHTML =
        '<p class="text-sm text-on-surface-muted text-center py-10">No ingredients match your search.</p>';
      return;
    }

    const rowHtml = rows
      .map(ing => {
        const counts = referenceByName.get(ing.name) ?? { distinctRecipes: 0, shoppingListRows: 0 };
        const recipeLink =
          counts.distinctRecipes > 0
            ? `<button type="button" data-used-in class="text-xs font-medium text-secondary hover:underline mt-0.5 block">View recipes</button>`
            : '';
        return `
          <tr class="border-b border-outline-soft/40 last:border-b-0" data-ingredient-row data-name="${escapeHtml(ing.name)}">
            <td class="${TD_CLASS}">
              <p class="text-sm font-semibold text-on-surface truncate" title="${escapeHtml(ing.name)}">${escapeHtml(ing.name)}</p>
            </td>
            <td class="${TD_CLASS}">
              <p class="text-xs sm:text-sm text-on-surface-muted truncate" title="${escapeHtml(categoryLabel(ing.category))}">${escapeHtml(categoryLabel(ing.category))}</p>
            </td>
            <td class="${TD_USED_IN}">
              <p class="text-xs sm:text-sm text-on-surface-muted tabular-nums leading-snug">${recipeCountLabel(counts.distinctRecipes)}</p>
              ${recipeLink}
            </td>
            <td class="${TD_EDIT}">
              <button
                type="button"
                data-edit
                class="rounded-full px-3 py-1.5 text-xs font-medium text-on-primary-container bg-primary-container hover:opacity-90 transition-opacity whitespace-nowrap"
              >
                Edit
              </button>
            </td>
          </tr>
        `;
      })
      .join('');

    listEl.innerHTML = `
      <div class="bg-surface-low/80 rounded-2xl overflow-hidden border border-outline-soft/40 overflow-x-auto">
        <table class="${TABLE_CLASS}">
          ${COLGROUP}
          <thead class="hidden sm:table-header-group border-b border-outline-soft/60">
            <tr>
              <th class="${TH_CLASS}">Name</th>
              <th class="${TH_CLASS}">Section</th>
              <th class="${TH_CLASS}">Used in</th>
              <th class="${TH_CLASS} text-right w-[4.75rem]"><span class="sr-only">Edit</span></th>
            </tr>
          </thead>
          <tbody>${rowHtml}</tbody>
        </table>
      </div>
    `;

    listEl.querySelectorAll('[data-ingredient-row]').forEach(rowEl => {
      if (!(rowEl instanceof HTMLElement)) return;
      wireListRow(rowEl);
    });
  };

  const wireListRow = (rowEl: HTMLElement) => {
    const name = rowEl.dataset.name ?? '';
    const ing = ingredients.find(i => i.name === name);
    if (!ing) return;

    rowEl.querySelector('[data-used-in]')?.addEventListener('click', async () => {
      try {
        const recipes = await getRecipesUsing(name);
        showUsedInDialog(name, recipes);
      } catch {
        setStatus('Could not load recipe list.', true);
      }
    });

    rowEl.querySelector('[data-edit]')?.addEventListener('click', () => {
      const counts = referenceByName.get(name) ?? { distinctRecipes: 0, shoppingListRows: 0 };
      showEditDialog(ing, counts);
    });
  };

  const showEditDialog = (
    ing: CanonicalIngredient,
    counts: { distinctRecipes: number; shoppingListRows: number },
  ) => {
    const originalName = ing.name;
    const canDelete = counts.distinctRecipes + counts.shoppingListRows === 0;
    const catValue = categoryToSelectValue(ing.category);

    const dialog = document.createElement('div');
    dialog.className =
      'fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'edit-ingredient-title');

    dialog.innerHTML = `
      <div class="absolute inset-0 bg-on-surface/25 backdrop-blur-[2px]" data-dialog-backdrop></div>
      <div class="relative w-full sm:max-w-md bg-surface rounded-2xl border border-outline-soft shadow-xl overflow-hidden max-h-[90vh] flex flex-col">
        <div class="bg-primary-container/40 px-5 pt-5 pb-4 shrink-0">
          <p class="text-xs font-medium text-on-surface-muted uppercase tracking-widest mb-1">Edit ingredient</p>
          <h2 id="edit-ingredient-title" class="font-serif text-xl font-bold text-on-surface leading-snug">${escapeHtml(originalName)}</h2>
          <p class="text-sm text-on-surface-muted mt-1">${recipeCountLabel(counts.distinctRecipes)}</p>
        </div>
        <div class="px-5 py-4 overflow-y-auto flex flex-col gap-4">
          <label class="flex flex-col gap-1">
            <span class="text-xs font-medium text-on-surface-muted">Canonical name</span>
            <input type="text" data-name value="${escapeHtml(ing.name)}" class="${inputClass}" autocomplete="off" spellcheck="false" />
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-xs font-medium text-on-surface-muted">Shopping section</span>
            <select data-category class="${selectClass}">${sectionOptions(catValue)}</select>
          </label>
        </div>
        <div class="px-5 pb-5 pt-2 flex flex-col gap-2 shrink-0 border-t border-outline-soft/40">
          <div class="flex gap-3">
            <button type="button" data-cancel class="flex-1 rounded-xl px-4 py-2.5 text-sm font-medium text-on-surface-muted bg-surface-container hover:bg-surface-container/80 transition-colors">
              Cancel
            </button>
            <button type="button" data-save class="flex-1 rounded-xl px-4 py-2.5 text-sm font-medium text-on-primary bg-primary hover:opacity-90 transition-opacity">
              Save changes
            </button>
          </div>
          <button
            type="button"
            data-delete
            class="w-full rounded-xl px-4 py-2.5 text-sm font-medium text-on-surface-muted border border-outline-soft/60 hover:text-primary transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            ${canDelete ? '' : 'disabled title="Remove all references before deleting"'}
          >
            Delete ingredient
          </button>
        </div>
      </div>
    `;

    const close = () => {
      dialog.remove();
      document.body.style.overflow = '';
    };

    const readDraft = (): RowDraft => {
      const nameInput = dialog.querySelector<HTMLInputElement>('[data-name]');
      const categorySelect = dialog.querySelector<HTMLSelectElement>('[data-category]');
      return {
        name: nameInput?.value.trim() ?? '',
        categoryValue: categorySelect?.value ?? '',
      };
    };

    dialog.querySelector('[data-dialog-backdrop]')?.addEventListener('click', close);
    dialog.querySelector('[data-cancel]')?.addEventListener('click', close);

    dialog.querySelector('[data-save]')?.addEventListener('click', async () => {
      const saved = await saveChanges(originalName, readDraft(), ing);
      if (saved) close();
    });

    dialog.querySelector('[data-delete]')?.addEventListener('click', async () => {
      const deleted = await deleteIngredient(originalName);
      if (deleted) close();
    });

    document.body.style.overflow = 'hidden';
    document.body.appendChild(dialog);
    dialog.querySelector<HTMLInputElement>('[data-name]')?.focus();
  };

  const saveChanges = async (
    originalName: string,
    draft: RowDraft,
    original: CanonicalIngredient,
  ): Promise<boolean> => {
    const nameCheck = validateCanonicalName(draft.name, originalName);
    if (!nameCheck.ok) {
      setStatus(nameCheck.error, true);
      return false;
    }

    let category: IngredientSection | null;
    try {
      category = selectValueToCategory(draft.categoryValue);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Invalid section.', true);
      return false;
    }

    const newName = nameCheck.normalized;
    const nameChanged = newName !== originalName;
    const categoryChanged = categoryToSelectValue(original.category) !== draft.categoryValue;

    if (!nameChanged && !categoryChanged) {
      setStatus('No changes to save.');
      return false;
    }

    try {
      if (nameChanged) {
        const collision = await ingredientExists(newName);
        const counts = await getReferenceCounts(originalName);

        if (collision) {
          const ok = await confirmDialog({
            eyebrow: 'Merge ingredients',
            title: `Merge into “${newName}”?`,
            body: `“${escapeHtml(originalName)}” would become “${escapeHtml(newName)}”. This reassigns <strong class="font-medium text-on-surface">${counts.distinctRecipes}</strong> recipe${counts.distinctRecipes === 1 ? '' : 's'} (${counts.recipeLines} line${counts.recipeLines === 1 ? '' : 's'}) and <strong class="font-medium text-on-surface">${counts.shoppingListRows}</strong> shopping-list row${counts.shoppingListRows === 1 ? '' : 's'} to the existing name, then removes the duplicate. Recipe pages will rebuild. There is no undo.`,
            confirmLabel: `Yes, merge ${counts.distinctRecipes} recipe${counts.distinctRecipes === 1 ? '' : 's'}`,
            tone: 'secondary',
          });
          if (!ok) return false;

          await mergeCanonicalIngredients(originalName, newName);
          setStatus(`Merged into “${newName}”. Recipe pages will rebuild shortly.`);
        } else {
          const ok = await confirmDialog({
            eyebrow: 'Rename ingredient',
            title: `Rename across ${counts.distinctRecipes} recipe${counts.distinctRecipes === 1 ? '' : 's'}?`,
            body: `Change canonical name from “${escapeHtml(originalName)}” to “${escapeHtml(newName)}”. This updates ${counts.recipeLines} recipe line${counts.recipeLines === 1 ? '' : 's'} and ${counts.shoppingListRows} shopping-list row${counts.shoppingListRows === 1 ? '' : 's'}. Static recipe pages will rebuild when affected.`,
            confirmLabel: `Yes, rename across ${counts.distinctRecipes} recipe${counts.distinctRecipes === 1 ? '' : 's'}`,
          });
          if (!ok) return false;

          const result = await renameCanonicalIngredient(originalName, newName);
          if (result.distinctRecipes > 0 && !result.rebuildTriggered) {
            setStatus(`Renamed to “${newName}”. Run scripts/ingredient-registry-rpc.sql so rebuilds fire automatically.`, true);
          } else if (result.distinctRecipes > 0) {
            setStatus(`Renamed to “${newName}”. Recipe pages will rebuild shortly.`);
          } else {
            setStatus(`Renamed to “${newName}”.`);
          }
        }

        if (categoryChanged) {
          await updateIngredientCategory(newName, category);
        }
      } else if (categoryChanged) {
        await updateIngredientCategory(originalName, category);
        setStatus(`Updated section for “${originalName}”. Shopping list only — no site rebuild.`);
      }

      await load();
      return true;
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Save failed.', true);
      return false;
    }
  };

  const deleteIngredient = async (name: string): Promise<boolean> => {
    const counts = await getReferenceCounts(name);
    if (counts.recipeLines > 0 || counts.shoppingListRows > 0) {
      setStatus(
        `Cannot delete “${name}” — used in ${counts.distinctRecipes} recipe${counts.distinctRecipes === 1 ? '' : 's'} and ${counts.shoppingListRows} shopping-list row${counts.shoppingListRows === 1 ? '' : 's'}.`,
        true,
      );
      return false;
    }

    const ok = await confirmDialog({
      eyebrow: 'Delete ingredient',
      title: `Delete “${name}”?`,
      body: 'This removes the canonical ingredient from the registry. It is not referenced by any recipes or the shopping list. There is no undo.',
      confirmLabel: 'Yes, delete',
    });
    if (!ok) return false;

    try {
      await deleteCanonicalIngredient(name);
      setStatus(`Deleted “${name}”.`);
      await load();
      return true;
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Delete failed.', true);
      return false;
    }
  };

  searchEl?.addEventListener('input', () => {
    filter = searchEl.value;
    render();
  });

  await load();
}
