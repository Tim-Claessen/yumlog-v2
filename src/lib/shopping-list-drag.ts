/** Section-scoped drag reorder with lift, FLIP sibling animation, and gentle settle. */

const LIFT_SHADOW =
  '0 8px 24px rgba(60, 40, 20, 0.12), 0 2px 8px rgba(60, 40, 20, 0.08)';

interface DragState {
  row: HTMLElement;
  section: HTMLElement;
  placeholder: HTMLElement;
  pointerId: number;
  offsetY: number;
  width: number;
  onDragEnd: () => void;
}

let active: DragState | null = null;

function sectionItems(section: HTMLElement): HTMLElement[] {
  return [...section.querySelectorAll<HTMLElement>(':scope > .shopping-row, :scope > .shopping-placeholder')];
}

function flipAnimate(elements: HTMLElement[], mutate: () => void) {
  const first = new Map(elements.map(el => [el, el.getBoundingClientRect()]));
  mutate();
  for (const el of elements) {
    const a = first.get(el);
    if (!a) continue;
    const b = el.getBoundingClientRect();
    const dy = a.top - b.top;
    if (Math.abs(dy) < 0.5) continue;
    el.style.transition = 'none';
    el.style.transform = `translateY(${dy}px)`;
    requestAnimationFrame(() => {
      el.style.transition = 'transform 200ms cubic-bezier(0.2, 0, 0, 1)';
      el.style.transform = '';
    });
  }
}

function movePlaceholder(section: HTMLElement, placeholder: HTMLElement, clientY: number) {
  const items = sectionItems(section).filter(el => el !== placeholder);
  let moved = false;

  flipAnimate(items, () => {
    for (const item of items) {
      const rect = item.getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) {
        section.insertBefore(placeholder, item);
        moved = true;
        break;
      }
    }
    if (!moved) {
      section.appendChild(placeholder);
    }
  });
}

function finishDrag(activeState: DragState) {
  const { row, section, placeholder, onDragEnd } = activeState;
  const targetTop = placeholder.getBoundingClientRect().top;

  row.style.transition =
    'top 220ms cubic-bezier(0.2, 0, 0, 1), transform 220ms cubic-bezier(0.2, 0, 0, 1), box-shadow 220ms ease';
  row.style.top = `${targetTop}px`;
  row.style.transform = 'scale(1)';
  row.style.boxShadow = '0 2px 8px rgba(60, 40, 20, 0.06)';

  const commit = () => {
    row.removeEventListener('transitionend', onTransitionEnd);
    section.insertBefore(row, placeholder);
    placeholder.remove();

    row.style.position = '';
    row.style.left = '';
    row.style.top = '';
    row.style.width = '';
    row.style.zIndex = '';
    row.style.transform = '';
    row.style.boxShadow = '';
    row.style.transition = '';
    row.classList.remove('shopping-row--dragging');

    active = null;
    onDragEnd();
  };

  const onTransitionEnd = (e: TransitionEvent) => {
    if (e.propertyName === 'top') commit();
  };

  row.addEventListener('transitionend', onTransitionEnd);
  window.setTimeout(commit, 280);
}

function onPointerMove(e: PointerEvent) {
  if (!active || e.pointerId !== active.pointerId) return;
  e.preventDefault();
  active.row.style.top = `${e.clientY - active.offsetY}px`;
  movePlaceholder(active.section, active.placeholder, e.clientY);
}

function onPointerUp(e: PointerEvent) {
  if (!active || e.pointerId !== active.pointerId) return;
  window.removeEventListener('pointermove', onPointerMove);
  window.removeEventListener('pointerup', onPointerUp);
  window.removeEventListener('pointercancel', onPointerCancel);
  finishDrag(active);
}

function onPointerCancel(e: PointerEvent) {
  if (!active || e.pointerId !== active.pointerId) return;
  window.removeEventListener('pointermove', onPointerMove);
  window.removeEventListener('pointerup', onPointerUp);
  window.removeEventListener('pointercancel', onPointerCancel);
  finishDrag(active);
}

function startDrag(
  row: HTMLElement,
  section: HTMLElement,
  e: PointerEvent,
  onDragEnd: () => void,
) {
  if (active) return;

  const rect = row.getBoundingClientRect();
  const placeholder = document.createElement('li');
  placeholder.className =
    'shopping-placeholder rounded-xl bg-surface-container/40 border border-dashed border-outline-soft/50 my-0.5';
  placeholder.style.height = `${rect.height}px`;
  placeholder.setAttribute('aria-hidden', 'true');

  section.insertBefore(placeholder, row);

  row.classList.add('shopping-row--dragging');
  row.style.position = 'fixed';
  row.style.left = `${rect.left}px`;
  row.style.top = `${rect.top}px`;
  row.style.width = `${rect.width}px`;
  row.style.zIndex = '50';
  row.style.transform = 'scale(1.03)';
  row.style.boxShadow = LIFT_SHADOW;
  row.style.transition = 'transform 150ms cubic-bezier(0.2, 0, 0, 1), box-shadow 150ms ease';

  active = {
    row,
    section,
    placeholder,
    pointerId: e.pointerId,
    offsetY: e.clientY - rect.top,
    width: rect.width,
    onDragEnd,
  };

  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerCancel);
}

/** Wire drag handles inside a list container (section groups). */
export function setupShoppingListDrag(
  container: HTMLElement,
  onReorder: () => void,
  onDragStateChange: (dragging: boolean) => void,
): void {
  container.addEventListener('pointerdown', (e) => {
    const handle = (e.target as HTMLElement).closest('[data-drag-handle]');
    if (!handle || active) return;

    const row = handle.closest('.shopping-row') as HTMLElement | null;
    const section = row?.closest('.shopping-section') as HTMLElement | null;
    if (!row || !section) return;

    e.preventDefault();
    onDragStateChange(true);

    startDrag(row, section, e, () => {
      onDragStateChange(false);
      onReorder();
    });
  });
}

/** Collect row ids — flat list DOM order, or section order then within-section order. */
export function collectOrderedIds(
  container: HTMLElement,
  sectionOrder: readonly string[],
): number[] {
  const flat = container.querySelector<HTMLElement>('.shopping-section[data-flat="true"]');
  if (flat) {
    return [...flat.querySelectorAll<HTMLElement>('.shopping-row')]
      .map(row => Number(row.dataset.id))
      .filter(id => !Number.isNaN(id));
  }

  const ids: number[] = [];

  for (const sectionKey of sectionOrder) {
    const section = container.querySelector<HTMLElement>(
      `.shopping-section[data-section="${CSS.escape(sectionKey)}"]`,
    );
    if (!section) continue;

    for (const row of section.querySelectorAll<HTMLElement>('.shopping-row')) {
      const id = Number(row.dataset.id);
      if (!Number.isNaN(id)) ids.push(id);
    }
  }

  const fallback = container.querySelector<HTMLElement>('.shopping-section[data-section=""]');
  if (fallback) {
    for (const row of fallback.querySelectorAll<HTMLElement>('.shopping-row')) {
      const id = Number(row.dataset.id);
      if (!Number.isNaN(id)) ids.push(id);
    }
  }

  return ids;
}
