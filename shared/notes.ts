/**
 * Notes shown after a transfer. The same remark often applies to many layers
 * (every logo has a gradient, say), so equal remarks are shown once with the
 * places they apply to.
 */
export interface Note {
  /** The layer or composition the note is about; empty when it is about the whole transfer. */
  where: string;
  text: string;
}

export interface NoteGroup {
  text: string;
  count: number;
  /** Distinct places, in the order they came up. */
  where: string[];
}

export function groupNotes(notes: Note[]): NoteGroup[] {
  const groups = new Map<string, NoteGroup>();
  for (const note of notes) {
    let group = groups.get(note.text);
    if (!group) {
      group = { text: note.text, count: 0, where: [] };
      groups.set(note.text, group);
    }
    group.count++;
    if (note.where && group.where.indexOf(note.where) === -1) group.where.push(note.where);
  }
  return [...groups.values()];
}

/** "Logo A, Logo B and 3 more" - as many names as fit in about `room` characters, at least one. */
export function whereLabel(where: string[], room = 28): string {
  let shown = 1;
  let used = where[0]?.length ?? 0;
  while (shown < where.length && used + where[shown]!.length + 2 <= room) {
    used += where[shown]!.length + 2;
    shown++;
  }
  const names = where.slice(0, shown).join(', ');
  return shown < where.length ? `${names} and ${where.length - shown} more` : names;
}
