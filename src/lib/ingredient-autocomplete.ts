import { matchIngredients } from './recipe-editor';

/** Wire autocomplete suggestions from known canonical ingredient names. */
export function wireIngredientAutocomplete(
  input: HTMLInputElement,
  list: HTMLUListElement,
  known: string[],
  onSelect: (ingredient: string) => void,
) {
  let activeIndex = -1;

  function hide() {
    list.classList.add('hidden');
    list.innerHTML = '';
    activeIndex = -1;
  }

  function show(matches: string[]) {
    list.innerHTML = '';
    if (matches.length === 0) {
      hide();
      return;
    }

    for (const ing of matches) {
      const li = document.createElement('li');
      li.className =
        'px-3 py-2.5 text-sm text-on-surface cursor-pointer hover:bg-primary-container hover:text-on-primary-container transition-colors';
      li.textContent = ing;
      li.addEventListener('mousedown', (e) => {
        e.preventDefault();
        onSelect(ing);
        hide();
      });
      list.appendChild(li);
    }

    list.classList.remove('hidden');
    activeIndex = -1;
  }

  input.addEventListener('input', () => {
    show(matchIngredients(input.value, known));
  });

  input.addEventListener('focus', () => {
    if (input.value.trim()) show(matchIngredients(input.value, known));
  });

  input.addEventListener('blur', () => {
    setTimeout(hide, 150);
  });

  input.addEventListener('keydown', (e) => {
    const items = list.querySelectorAll('li');
    if (items.length === 0 || list.classList.contains('hidden')) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activeIndex = Math.min(activeIndex + 1, items.length - 1);
      highlightItem(items, activeIndex);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeIndex = Math.max(activeIndex - 1, 0);
      highlightItem(items, activeIndex);
    } else if (e.key === 'Enter' && activeIndex >= 0) {
      e.preventDefault();
      (items[activeIndex] as HTMLLIElement).dispatchEvent(new MouseEvent('mousedown'));
    } else if (e.key === 'Escape') {
      hide();
    }
  });
}

function highlightItem(items: NodeListOf<Element>, index: number) {
  items.forEach((item, i) => {
    item.classList.toggle('bg-primary-container', i === index);
    item.classList.toggle('text-on-primary-container', i === index);
  });
}
