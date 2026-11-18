export const tools = {
  summarize_note: {
    description: "Summarize a note for quick review.",
    parameters: {
      noteId: { type: "string", required: true },
      maxWords: { type: "number", required: false },
      includeTags: { type: "boolean", required: false },
    },
  },
};

export function getTool(name) {
  return tools[name];
}
