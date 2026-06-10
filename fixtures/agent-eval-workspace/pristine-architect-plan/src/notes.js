export function createNote({ id, title, body }) {
  return {
    id,
    title: title.trim(),
    body: body.trim(),
    createdAt: new Date().toISOString(),
  };
}

export function searchNotes(notes, query) {
  const normalized = query.trim().toLowerCase();
  return notes.filter((note) => {
    return (
      note.title.toLowerCase().includes(normalized) ||
      note.body.toLowerCase().includes(normalized)
    );
  });
}
