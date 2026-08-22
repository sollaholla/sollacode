export interface ComposerEmoji {
  emoji: string;
  label: string;
  keywords: string;
}

export interface ComposerEmojiUsage {
  count: number;
  lastUsedAt: number;
}

type ComposerEmojiUsageMap = Record<string, ComposerEmojiUsage>;

const COMPOSER_EMOJI_STORAGE_KEY = "t3code:composer-emoji-usage:v1";

export const DEFAULT_COMPOSER_EMOJIS = ["👍", "❤️", "😂", "🎉", "🔥"] as const;

export const COMPOSER_EMOJIS: ReadonlyArray<ComposerEmoji> = [
  { emoji: "😀", label: "grinning face", keywords: "happy smile" },
  { emoji: "😃", label: "grinning face with big eyes", keywords: "happy smile" },
  { emoji: "😄", label: "grinning squinting face", keywords: "happy laugh" },
  { emoji: "😁", label: "beaming face", keywords: "happy grin" },
  { emoji: "😆", label: "laughing face", keywords: "happy squint" },
  { emoji: "😅", label: "grinning face with sweat", keywords: "relief nervous" },
  { emoji: "😂", label: "face with tears of joy", keywords: "laugh funny lol" },
  { emoji: "🤣", label: "rolling on the floor laughing", keywords: "funny lol rofl" },
  { emoji: "😊", label: "smiling face with smiling eyes", keywords: "happy blush" },
  { emoji: "🙂", label: "slightly smiling face", keywords: "happy" },
  { emoji: "🙃", label: "upside down face", keywords: "silly sarcasm" },
  { emoji: "😉", label: "winking face", keywords: "flirt joke" },
  { emoji: "😍", label: "smiling face with heart eyes", keywords: "love crush" },
  { emoji: "🥰", label: "smiling face with hearts", keywords: "love affection" },
  { emoji: "😘", label: "face blowing a kiss", keywords: "love kiss" },
  { emoji: "😋", label: "face savoring food", keywords: "yum delicious" },
  { emoji: "😎", label: "smiling face with sunglasses", keywords: "cool" },
  { emoji: "🤩", label: "star struck", keywords: "excited wow" },
  { emoji: "🥳", label: "partying face", keywords: "celebrate birthday" },
  { emoji: "😏", label: "smirking face", keywords: "smug" },
  { emoji: "😒", label: "unamused face", keywords: "annoyed" },
  { emoji: "😔", label: "pensive face", keywords: "sad thoughtful" },
  { emoji: "😢", label: "crying face", keywords: "sad tear" },
  { emoji: "😭", label: "loudly crying face", keywords: "sad tears" },
  { emoji: "😤", label: "face with steam from nose", keywords: "angry triumph" },
  { emoji: "😡", label: "enraged face", keywords: "angry mad" },
  { emoji: "🤬", label: "face with symbols on mouth", keywords: "angry curse" },
  { emoji: "🤯", label: "exploding head", keywords: "mind blown shocked" },
  { emoji: "😳", label: "flushed face", keywords: "embarrassed shocked" },
  { emoji: "🥺", label: "pleading face", keywords: "please puppy eyes" },
  { emoji: "😬", label: "grimacing face", keywords: "awkward nervous" },
  { emoji: "🤔", label: "thinking face", keywords: "hmm consider" },
  { emoji: "🫡", label: "saluting face", keywords: "respect yes sir" },
  { emoji: "🤭", label: "face with hand over mouth", keywords: "giggle oops" },
  { emoji: "🫢", label: "face with open eyes and hand over mouth", keywords: "gasp surprise" },
  { emoji: "🤫", label: "shushing face", keywords: "quiet secret" },
  { emoji: "🫠", label: "melting face", keywords: "heat embarrassment" },
  { emoji: "😴", label: "sleeping face", keywords: "tired sleep" },
  { emoji: "🤒", label: "face with thermometer", keywords: "sick ill" },
  { emoji: "🤢", label: "nauseated face", keywords: "sick gross" },
  { emoji: "🤡", label: "clown face", keywords: "silly circus" },
  { emoji: "👻", label: "ghost", keywords: "halloween spooky" },
  { emoji: "💀", label: "skull", keywords: "dead dying funny" },
  { emoji: "🤖", label: "robot", keywords: "bot ai machine" },
  { emoji: "👽", label: "alien", keywords: "space ufo" },
  { emoji: "👍", label: "thumbs up", keywords: "like yes approve good" },
  { emoji: "👎", label: "thumbs down", keywords: "dislike no reject bad" },
  { emoji: "👌", label: "ok hand", keywords: "okay perfect" },
  { emoji: "✌️", label: "victory hand", keywords: "peace two" },
  { emoji: "🤞", label: "crossed fingers", keywords: "luck hope" },
  { emoji: "🤟", label: "love you gesture", keywords: "ily hand" },
  { emoji: "🤘", label: "sign of the horns", keywords: "rock metal" },
  { emoji: "🤙", label: "call me hand", keywords: "phone shaka" },
  { emoji: "👋", label: "waving hand", keywords: "hello goodbye hi" },
  { emoji: "👏", label: "clapping hands", keywords: "applause congrats" },
  { emoji: "🙌", label: "raising hands", keywords: "celebrate hooray" },
  { emoji: "👐", label: "open hands", keywords: "hug welcome" },
  { emoji: "🤝", label: "handshake", keywords: "deal agreement" },
  { emoji: "🙏", label: "folded hands", keywords: "please thanks prayer" },
  { emoji: "💪", label: "flexed biceps", keywords: "strong muscle" },
  { emoji: "🫶", label: "heart hands", keywords: "love support" },
  { emoji: "👀", label: "eyes", keywords: "look watching" },
  { emoji: "👂", label: "ear", keywords: "listen hear" },
  { emoji: "🧠", label: "brain", keywords: "think smart" },
  { emoji: "🫀", label: "anatomical heart", keywords: "health organ" },
  { emoji: "👑", label: "crown", keywords: "king queen royal" },
  { emoji: "🐶", label: "dog face", keywords: "pet puppy animal" },
  { emoji: "🐱", label: "cat face", keywords: "pet kitty animal" },
  { emoji: "🐭", label: "mouse face", keywords: "animal" },
  { emoji: "🐹", label: "hamster", keywords: "pet animal" },
  { emoji: "🐰", label: "rabbit face", keywords: "bunny animal" },
  { emoji: "🦊", label: "fox", keywords: "animal" },
  { emoji: "🐻", label: "bear", keywords: "animal" },
  { emoji: "🐼", label: "panda", keywords: "animal" },
  { emoji: "🐨", label: "koala", keywords: "animal" },
  { emoji: "🦁", label: "lion", keywords: "animal" },
  { emoji: "🐯", label: "tiger face", keywords: "animal" },
  { emoji: "🐸", label: "frog", keywords: "animal" },
  { emoji: "🐵", label: "monkey face", keywords: "animal" },
  { emoji: "🙈", label: "see no evil monkey", keywords: "embarrassed animal" },
  { emoji: "🙉", label: "hear no evil monkey", keywords: "animal" },
  { emoji: "🙊", label: "speak no evil monkey", keywords: "secret animal" },
  { emoji: "🐔", label: "chicken", keywords: "bird animal" },
  { emoji: "🐧", label: "penguin", keywords: "bird animal" },
  { emoji: "🐦", label: "bird", keywords: "animal" },
  { emoji: "🦄", label: "unicorn", keywords: "magic animal" },
  { emoji: "🐝", label: "honeybee", keywords: "bug insect" },
  { emoji: "🦋", label: "butterfly", keywords: "bug insect" },
  { emoji: "🐞", label: "lady beetle", keywords: "bug insect" },
  { emoji: "🐢", label: "turtle", keywords: "animal slow" },
  { emoji: "🐙", label: "octopus", keywords: "ocean animal" },
  { emoji: "🐬", label: "dolphin", keywords: "ocean animal" },
  { emoji: "🐳", label: "spouting whale", keywords: "ocean animal" },
  { emoji: "🦖", label: "t rex", keywords: "dinosaur animal" },
  { emoji: "🌱", label: "seedling", keywords: "plant grow nature" },
  { emoji: "🌿", label: "herb", keywords: "plant nature" },
  { emoji: "🍀", label: "four leaf clover", keywords: "luck plant" },
  { emoji: "🌷", label: "tulip", keywords: "flower plant" },
  { emoji: "🌹", label: "rose", keywords: "flower love" },
  { emoji: "🌻", label: "sunflower", keywords: "flower plant" },
  { emoji: "🌈", label: "rainbow", keywords: "weather pride" },
  { emoji: "☀️", label: "sun", keywords: "weather bright" },
  { emoji: "🌙", label: "crescent moon", keywords: "night" },
  { emoji: "⭐", label: "star", keywords: "favorite" },
  { emoji: "✨", label: "sparkles", keywords: "magic shine new" },
  { emoji: "⚡", label: "high voltage", keywords: "lightning fast energy" },
  { emoji: "🔥", label: "fire", keywords: "hot lit flame" },
  { emoji: "❄️", label: "snowflake", keywords: "cold winter" },
  { emoji: "🍎", label: "red apple", keywords: "fruit food" },
  { emoji: "🍌", label: "banana", keywords: "fruit food" },
  { emoji: "🍓", label: "strawberry", keywords: "fruit food" },
  { emoji: "🍉", label: "watermelon", keywords: "fruit food" },
  { emoji: "🍕", label: "pizza", keywords: "food" },
  { emoji: "🍔", label: "hamburger", keywords: "food burger" },
  { emoji: "🌮", label: "taco", keywords: "food" },
  { emoji: "🍿", label: "popcorn", keywords: "food movie" },
  { emoji: "🍪", label: "cookie", keywords: "food dessert" },
  { emoji: "🎂", label: "birthday cake", keywords: "food celebrate" },
  { emoji: "☕", label: "hot beverage", keywords: "coffee tea drink" },
  { emoji: "🍺", label: "beer mug", keywords: "drink cheers" },
  { emoji: "🍷", label: "wine glass", keywords: "drink" },
  { emoji: "🥂", label: "clinking glasses", keywords: "cheers celebrate drink" },
  { emoji: "⚽", label: "soccer ball", keywords: "football sport" },
  { emoji: "🏀", label: "basketball", keywords: "sport" },
  { emoji: "🏈", label: "american football", keywords: "sport" },
  { emoji: "⚾", label: "baseball", keywords: "sport" },
  { emoji: "🎾", label: "tennis", keywords: "sport" },
  { emoji: "🏆", label: "trophy", keywords: "winner award" },
  { emoji: "🥇", label: "gold medal", keywords: "winner first award" },
  { emoji: "🎯", label: "bullseye", keywords: "target goal" },
  { emoji: "🎮", label: "video game", keywords: "controller gaming" },
  { emoji: "🎲", label: "game die", keywords: "dice random" },
  { emoji: "🎨", label: "artist palette", keywords: "art paint design" },
  { emoji: "🎵", label: "musical note", keywords: "music song" },
  { emoji: "🎸", label: "guitar", keywords: "music rock" },
  { emoji: "🎬", label: "clapper board", keywords: "movie film video" },
  { emoji: "🚀", label: "rocket", keywords: "launch space fast" },
  { emoji: "✈️", label: "airplane", keywords: "travel flight" },
  { emoji: "🚗", label: "automobile", keywords: "car travel" },
  { emoji: "🚲", label: "bicycle", keywords: "bike travel" },
  { emoji: "🏠", label: "house", keywords: "home building" },
  { emoji: "🏖️", label: "beach with umbrella", keywords: "vacation travel" },
  { emoji: "🗺️", label: "world map", keywords: "travel location" },
  { emoji: "⌚", label: "watch", keywords: "time" },
  { emoji: "📱", label: "mobile phone", keywords: "iphone device" },
  { emoji: "💻", label: "laptop", keywords: "computer code work" },
  { emoji: "⌨️", label: "keyboard", keywords: "computer type" },
  { emoji: "📷", label: "camera", keywords: "photo picture" },
  { emoji: "💡", label: "light bulb", keywords: "idea insight" },
  { emoji: "🔍", label: "magnifying glass", keywords: "search find" },
  { emoji: "🔒", label: "locked", keywords: "security private" },
  { emoji: "🔑", label: "key", keywords: "password access" },
  { emoji: "🧰", label: "toolbox", keywords: "tools work" },
  { emoji: "🔧", label: "wrench", keywords: "tool fix" },
  { emoji: "⚙️", label: "gear", keywords: "settings config" },
  { emoji: "🧪", label: "test tube", keywords: "science experiment test" },
  { emoji: "📌", label: "pushpin", keywords: "pin location" },
  { emoji: "📎", label: "paperclip", keywords: "attachment" },
  { emoji: "📝", label: "memo", keywords: "write note" },
  { emoji: "📚", label: "books", keywords: "read study" },
  { emoji: "📅", label: "calendar", keywords: "date schedule" },
  { emoji: "📈", label: "chart increasing", keywords: "growth graph analytics" },
  { emoji: "💰", label: "money bag", keywords: "cash finance" },
  { emoji: "🎁", label: "wrapped gift", keywords: "present birthday" },
  { emoji: "🎉", label: "party popper", keywords: "celebrate congrats" },
  { emoji: "🎊", label: "confetti ball", keywords: "celebrate party" },
  { emoji: "🎈", label: "balloon", keywords: "party birthday" },
  { emoji: "❤️", label: "red heart", keywords: "love favorite" },
  { emoji: "🧡", label: "orange heart", keywords: "love" },
  { emoji: "💛", label: "yellow heart", keywords: "love" },
  { emoji: "💚", label: "green heart", keywords: "love" },
  { emoji: "💙", label: "blue heart", keywords: "love" },
  { emoji: "💜", label: "purple heart", keywords: "love" },
  { emoji: "🖤", label: "black heart", keywords: "love" },
  { emoji: "🤍", label: "white heart", keywords: "love" },
  { emoji: "💔", label: "broken heart", keywords: "sad breakup" },
  { emoji: "💯", label: "hundred points", keywords: "perfect score agree" },
  { emoji: "✅", label: "check mark button", keywords: "done yes complete" },
  { emoji: "❌", label: "cross mark", keywords: "no wrong delete" },
  { emoji: "⚠️", label: "warning", keywords: "alert caution" },
  { emoji: "❓", label: "question mark", keywords: "help unknown" },
  { emoji: "❗", label: "exclamation mark", keywords: "important alert" },
  { emoji: "➕", label: "plus", keywords: "add" },
  { emoji: "➖", label: "minus", keywords: "remove" },
  { emoji: "♻️", label: "recycling symbol", keywords: "reuse refresh" },
  { emoji: "🚩", label: "triangular flag", keywords: "warning goal" },
];

function readComposerEmojiUsage(storage: Storage | undefined): ComposerEmojiUsageMap {
  if (!storage) return {};
  try {
    const parsed: unknown = JSON.parse(storage.getItem(COMPOSER_EMOJI_STORAGE_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, ComposerEmojiUsage] => {
        const value = entry[1];
        return (
          typeof value === "object" &&
          value !== null &&
          "count" in value &&
          typeof value.count === "number" &&
          Number.isFinite(value.count) &&
          value.count > 0 &&
          "lastUsedAt" in value &&
          typeof value.lastUsedAt === "number" &&
          Number.isFinite(value.lastUsedAt)
        );
      }),
    );
  } catch {
    return {};
  }
}

function resolveBrowserStorage(): Storage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export function rankComposerEmojis(usage: ComposerEmojiUsageMap, limit = 5): string[] {
  const ranked = Object.entries(usage)
    .sort(([, left], [, right]) => right.count - left.count || right.lastUsedAt - left.lastUsedAt)
    .map(([emoji]) => emoji);
  const combined = [...ranked, ...DEFAULT_COMPOSER_EMOJIS];
  return [...new Set(combined)].slice(0, limit);
}

export function loadRecentComposerEmojis(storage = resolveBrowserStorage()): string[] {
  return rankComposerEmojis(readComposerEmojiUsage(storage));
}

export function recordComposerEmojiUsage(
  emoji: string,
  now = Date.now(),
  storage = resolveBrowserStorage(),
): string[] {
  const usage = readComposerEmojiUsage(storage);
  const previous = usage[emoji];
  usage[emoji] = { count: (previous?.count ?? 0) + 1, lastUsedAt: now };
  try {
    storage?.setItem(COMPOSER_EMOJI_STORAGE_KEY, JSON.stringify(usage));
  } catch {
    // The shortcuts still update for this session when storage is unavailable.
  }
  return rankComposerEmojis(usage);
}

export function searchComposerEmojis(query: string): ReadonlyArray<ComposerEmoji> {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return COMPOSER_EMOJIS;
  return COMPOSER_EMOJIS.filter((item) => {
    const haystack = `${item.emoji} ${item.label} ${item.keywords}`.toLocaleLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}
