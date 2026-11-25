/** Shows grouped notes as list items. Shared by the two user interfaces. */
import { groupNotes, whereLabel } from '../notes.ts';
import type { Note } from '../notes.ts';

/** Fills `list` with one entry per group of notes. */
export function renderNotes(list: HTMLElement, notes: Note[]): number {
  list.textContent = '';
  const groups = groupNotes(notes);
  for (const group of groups) {
    const li = document.createElement('li');
    if (group.where.length) {
      const b = document.createElement('b');
      b.textContent = `${whereLabel(group.where)}: `;
      b.title = group.where.join('\n');
      li.appendChild(b);
    }
    li.appendChild(document.createTextNode(group.text));
    list.appendChild(li);
  }
  return groups.length;
}
