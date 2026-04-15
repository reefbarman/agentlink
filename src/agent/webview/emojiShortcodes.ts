interface EmojiDefinition {
  emoji: string;
  aliases: readonly string[];
  keywords?: readonly string[];
}

export interface EmojiSuggestion {
  emoji: string;
  shortcode: string;
}

const EMOJI_DEFINITIONS: readonly EmojiDefinition[] = [
  { emoji: "👍", aliases: ["thumbsup", "+1", "thumbs_up"] },
  { emoji: "👎", aliases: ["thumbsdown", "-1", "thumbs_down"] },
  { emoji: "👏", aliases: ["clap"] },
  { emoji: "🙌", aliases: ["raised_hands"] },
  { emoji: "🙏", aliases: ["pray", "folded_hands"] },
  { emoji: "👋", aliases: ["wave"] },
  { emoji: "👌", aliases: ["ok_hand"] },
  { emoji: "🤝", aliases: ["handshake"] },
  { emoji: "💪", aliases: ["muscle"] },
  { emoji: "👀", aliases: ["eyes"] },
  { emoji: "✅", aliases: ["white_check_mark", "check", "checkmark"] },
  { emoji: "❌", aliases: ["x", "cross_mark"] },
  { emoji: "⚠️", aliases: ["warning"] },
  { emoji: "🚨", aliases: ["rotating_light", "siren"] },
  { emoji: "💯", aliases: ["100"] },
  { emoji: "🔥", aliases: ["fire"] },
  { emoji: "✨", aliases: ["sparkles"] },
  { emoji: "⭐", aliases: ["star"] },
  { emoji: "🌟", aliases: ["star2"] },
  { emoji: "🎉", aliases: ["tada", "party_popper"] },
  { emoji: "🚀", aliases: ["rocket"] },
  { emoji: "💥", aliases: ["boom", "collision"] },
  { emoji: "🧠", aliases: ["brain"] },
  { emoji: "🐛", aliases: ["bug"] },
  { emoji: "🧪", aliases: ["test_tube"] },
  { emoji: "🛠️", aliases: ["hammer_and_wrench", "tools"] },
  { emoji: "🔒", aliases: ["lock"] },
  { emoji: "🔓", aliases: ["unlock"] },
  { emoji: "🔑", aliases: ["key"] },
  { emoji: "📌", aliases: ["pushpin"] },
  { emoji: "📎", aliases: ["paperclip"] },
  { emoji: "📣", aliases: ["mega", "loudspeaker"] },
  { emoji: "📢", aliases: ["speaker"] },
  { emoji: "📅", aliases: ["calendar"] },
  { emoji: "⏰", aliases: ["alarm_clock"] },
  { emoji: "⌛", aliases: ["hourglass"] },
  { emoji: "🙂", aliases: ["slightly_smiling_face", "slight_smile"] },
  { emoji: "😀", aliases: ["grinning"] },
  { emoji: "😃", aliases: ["smiley"] },
  { emoji: "😄", aliases: ["smile"] },
  { emoji: "😁", aliases: ["grin"] },
  { emoji: "😂", aliases: ["joy"] },
  { emoji: "🤣", aliases: ["rofl"] },
  { emoji: "😅", aliases: ["sweat_smile"] },
  { emoji: "😉", aliases: ["wink"] },
  { emoji: "😊", aliases: ["blush"] },
  { emoji: "😍", aliases: ["heart_eyes"] },
  { emoji: "😘", aliases: ["kissing_heart"] },
  { emoji: "🤔", aliases: ["thinking_face", "thinking"] },
  { emoji: "🫠", aliases: ["melting_face"] },
  { emoji: "😐", aliases: ["neutral_face"] },
  { emoji: "😶", aliases: ["no_mouth"] },
  { emoji: "🙃", aliases: ["upside_down_face"] },
  { emoji: "😕", aliases: ["confused"] },
  { emoji: "😬", aliases: ["grimacing"] },
  { emoji: "😢", aliases: ["cry"] },
  { emoji: "😭", aliases: ["sob"] },
  { emoji: "😮", aliases: ["open_mouth"] },
  { emoji: "😱", aliases: ["scream"] },
  { emoji: "😡", aliases: ["rage"] },
  { emoji: "😠", aliases: ["angry"] },
  { emoji: "🤯", aliases: ["exploding_head", "mind_blown"] },
  { emoji: "🤦", aliases: ["facepalm"] },
  { emoji: "🤷", aliases: ["shrug"] },
  { emoji: "😎", aliases: ["sunglasses"] },
  { emoji: "🤓", aliases: ["nerd_face"] },
  { emoji: "🤖", aliases: ["robot", "robot_face"] },
  { emoji: "💩", aliases: ["poop", "pile_of_poo"] },
  { emoji: "💀", aliases: ["skull"] },
  { emoji: "🙈", aliases: ["see_no_evil"] },
  { emoji: "🙉", aliases: ["hear_no_evil"] },
  { emoji: "🙊", aliases: ["speak_no_evil"] },
  { emoji: "❤️", aliases: ["heart", "red_heart"] },
  { emoji: "🧡", aliases: ["orange_heart"] },
  { emoji: "💛", aliases: ["yellow_heart"] },
  { emoji: "💚", aliases: ["green_heart"] },
  { emoji: "💙", aliases: ["blue_heart"] },
  { emoji: "💜", aliases: ["purple_heart"] },
  { emoji: "🖤", aliases: ["black_heart"] },
  { emoji: "🤍", aliases: ["white_heart"] },
  { emoji: "🤎", aliases: ["brown_heart"] },
  { emoji: "💔", aliases: ["broken_heart"] },
];

const SHORTCODE_CHAR_RE = /^[A-Za-z0-9_+-]$/;

const ALIAS_ENTRIES = EMOJI_DEFINITIONS.flatMap((definition) =>
  definition.aliases.map((alias) => ({
    shortcode: alias.toLowerCase(),
    emoji: definition.emoji,
    keywords: definition.keywords ?? [],
  })),
);

const ALIAS_TO_EMOJI = new Map<string, string>(
  ALIAS_ENTRIES.map((entry) => [entry.shortcode, entry.emoji]),
);

function isBoundaryBeforeShortcode(char: string | undefined): boolean {
  if (char === undefined) {
    return true;
  }
  return /\s/.test(char) || /[([{'"`]/.test(char);
}

export function resolveEmojiShortcode(shortcode: string): string | undefined {
  return ALIAS_TO_EMOJI.get(shortcode.toLowerCase());
}

export function searchEmojiShortcodes(
  query: string,
  limit = 12,
): EmojiSuggestion[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return [];
  }

  const ranked = ALIAS_ENTRIES.map((entry) => {
    const alias = entry.shortcode;
    let rank = Number.POSITIVE_INFINITY;

    if (alias === normalized) {
      rank = 0;
    } else if (alias.startsWith(normalized)) {
      rank = 1;
    } else if (entry.keywords.some((k) => k.startsWith(normalized))) {
      rank = 2;
    } else if (alias.includes(normalized)) {
      rank = 3;
    } else if (entry.keywords.some((k) => k.includes(normalized))) {
      rank = 4;
    }

    return { ...entry, rank };
  })
    .filter((entry) => Number.isFinite(entry.rank))
    .sort((a, b) => {
      if (a.rank !== b.rank) {
        return a.rank - b.rank;
      }
      if (a.shortcode.length !== b.shortcode.length) {
        return a.shortcode.length - b.shortcode.length;
      }
      return a.shortcode.localeCompare(b.shortcode);
    });

  return ranked.slice(0, limit).map((entry) => ({
    emoji: entry.emoji,
    shortcode: entry.shortcode,
  }));
}

export function findTrailingEmojiShortcode(
  text: string,
  cursor: number,
): { start: number; end: number; shortcode: string } | null {
  if (cursor < 2 || text[cursor - 1] !== ":") {
    return null;
  }

  let start = cursor - 2;
  while (start >= 0 && SHORTCODE_CHAR_RE.test(text[start])) {
    start -= 1;
  }

  if (start < 0 || text[start] !== ":") {
    return null;
  }

  if (!isBoundaryBeforeShortcode(text[start - 1])) {
    return null;
  }

  const shortcode = text.slice(start + 1, cursor - 1).toLowerCase();
  if (!shortcode) {
    return null;
  }

  return { start, end: cursor, shortcode };
}

export function shouldOpenEmojiPopup(
  text: string,
  colonIndex: number,
): boolean {
  if (colonIndex < 0 || text[colonIndex] !== ":") {
    return false;
  }
  return isBoundaryBeforeShortcode(text[colonIndex - 1]);
}
