import {
  INGREDIENT_SECTIONS,
  sectionDisplayLabel,
  type IngredientSection,
} from './ingredient-sections';

const selectClass =
  'w-full bg-surface-container/50 border border-transparent rounded-xl px-3 py-2.5 text-sm text-on-surface-muted focus:text-on-surface focus:bg-surface-container focus:border-outline-soft/60 focus:outline-none transition-colors';

/**
 * Modal picker for shopping sections on brand-new canonical ingredients.
 * Resolves null when the user cancels.
 */
export function promptIngredientCategories(
  ingredientNames: string[],
): Promise<Record<string, IngredientSection> | null> {
  if (ingredientNames.length === 0) return Promise.resolve({});

  return new Promise(resolve => {
    const dialog = document.createElement('div');
    dialog.className =
      'fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'ingredient-category-title');

    const sectionOptions = INGREDIENT_SECTIONS.map(
      s => `<option value="${s}">${sectionDisplayLabel(s)}</option>`,
    ).join('');

    const rows = ingredientNames
      .map(
        name => `
        <label class="flex flex-col gap-1.5">
          <span class="text-sm font-medium text-on-surface">${escapeHtml(name)}</span>
          <select class="section-pick ${selectClass}" data-ingredient="${escapeAttr(name)}" required>
            <option value="" disabled selected>Pick a section…</option>
            ${sectionOptions}
          </select>
        </label>
      `,
      )
      .join('');

    dialog.innerHTML = `
      <div class="absolute inset-0 bg-on-surface/25 backdrop-blur-[2px]" data-dialog-backdrop></div>
      <div class="relative w-full sm:max-w-md bg-surface rounded-2xl border border-outline-soft shadow-xl overflow-hidden max-h-[90vh] flex flex-col">
        <div class="bg-primary-container/40 px-5 pt-5 pb-4 shrink-0">
          <p class="text-xs font-medium text-on-surface-muted uppercase tracking-widest mb-1">New ingredient</p>
          <h2 id="ingredient-category-title" class="font-serif text-xl font-bold text-on-surface leading-snug">
            Where do you buy ${ingredientNames.length === 1 ? 'this' : 'these'}?
          </h2>
          <p class="text-sm text-on-surface-muted mt-2 leading-relaxed">
            Pick a shopping-list section for each new ingredient. Existing ones keep their section.
          </p>
        </div>
        <div class="px-5 py-4 overflow-y-auto flex flex-col gap-4">${rows}</div>
        <div class="px-5 pb-5 pt-2 flex gap-3 shrink-0 border-t border-outline-soft/40">
          <button type="button" data-cancel class="flex-1 rounded-xl px-4 py-2.5 text-sm font-medium text-on-surface-muted bg-surface-container hover:bg-surface-container/80 transition-colors">
            Cancel
          </button>
          <button type="button" data-confirm class="flex-1 rounded-xl px-4 py-2.5 text-sm font-medium text-on-primary bg-primary hover:opacity-90 transition-opacity">
            Save
          </button>
        </div>
      </div>
    `;

    function close(result: Record<string, IngredientSection> | null) {
      dialog.remove();
      document.body.style.overflow = '';
      resolve(result);
    }

    dialog.querySelector('[data-dialog-backdrop]')?.addEventListener('click', () => close(null));
    dialog.querySelector('[data-cancel]')?.addEventListener('click', () => close(null));

    dialog.querySelector('[data-confirm]')?.addEventListener('click', () => {
      const picks: Record<string, IngredientSection> = {};
      const selects = dialog.querySelectorAll<HTMLSelectElement>('.section-pick');

      for (const sel of selects) {
        const name = sel.dataset.ingredient;
        const value = sel.value;
        if (!name || !value) {
          sel.focus();
          return;
        }
        picks[name] = value as IngredientSection;
      }

      close(picks);
    });

    document.body.style.overflow = 'hidden';
    document.body.appendChild(dialog);
    const firstSelect = dialog.querySelector<HTMLSelectElement>('.section-pick');
    firstSelect?.focus();
  });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
