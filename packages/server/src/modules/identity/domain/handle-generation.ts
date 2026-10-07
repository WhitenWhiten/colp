import { randomInt } from 'node:crypto';

/**
 * Vocabulary for automatically assigned profile handles.
 *
 * A handle is the account's public identity (`/u/{handle}`), so the default
 * has to read like something a person picked: an opaque random string signals
 * that the value is system-owned, and holders leave it alone rather than
 * setting one of their own.
 *
 * Nothing here derives from the identity provider, the email address or the
 * display name — the handle is public and those are not (see the
 * non-provider-derived contract on ensureAccountHandle). Words are concrete
 * and neutral (colour, texture, landscape, flora, fauna) so no pair can be
 * read as a claim about the account holder.
 *
 * Every word is at most HANDLE_WORD_MAX lowercase ASCII letters, so the
 * longest generated handle is `adjective-noun-99` at 16 characters — inside
 * HANDLE_CLAIM_MAX and inside the `^[a-z0-9._~-]{1,64}$` charset shared by
 * assertValidHandle, the OpenAPI schema and the profile_handles CHECK.
 */
export const HANDLE_ADJECTIVES: readonly string[] = [
  'airy', 'amber', 'ample', 'arid', 'azure', 'balmy', 'blue', 'bold',
  'brave', 'brief', 'brisk', 'calm', 'civic', 'clear', 'close', 'cobalt',
  'cool', 'coral', 'cosmic', 'cozy', 'crisp', 'curly', 'daily', 'damp',
  'dapper', 'deep', 'dense', 'downy', 'dual', 'dusky', 'dusty', 'eager',
  'early', 'easy', 'even', 'exact', 'fair', 'fancy', 'fast', 'fine',
  'firm', 'first', 'fleet', 'fluid', 'foggy', 'fond', 'free', 'fresh',
  'full', 'gentle', 'giant', 'gilded', 'glad', 'glassy', 'golden', 'good',
  'grand', 'grassy', 'gray', 'great', 'green', 'hardy', 'hazel', 'hazy',
  'high', 'hollow', 'honest', 'humble', 'ideal', 'idle', 'indigo', 'inner',
  'ivory', 'jolly', 'keen', 'kind', 'large', 'lavish', 'lean', 'light',
  'lilac', 'linen', 'little', 'lively', 'lofty', 'lone', 'long', 'loose',
  'loud', 'lucid', 'lucky', 'lunar', 'lush', 'main', 'major', 'mellow',
  'merry', 'mild', 'milky', 'mint', 'misty', 'modest', 'mossy', 'muted',
  'narrow', 'near', 'neat', 'nimble', 'noble', 'north', 'novel', 'oaken',
  'ochre', 'olive', 'open', 'orange', 'outer', 'oval', 'pale', 'peach',
  'pearly', 'petite', 'placid', 'plain', 'plum', 'plush', 'polar', 'prime',
  'proper', 'proud', 'pure', 'purple', 'quick', 'quiet', 'rapid', 'rare',
  'ready', 'real', 'rich', 'ripe', 'rosy', 'round', 'royal', 'ruby',
  'rustic', 'safe', 'sage', 'sandy', 'sharp', 'sheer', 'shiny', 'short',
  'silent', 'silky', 'silver', 'simple', 'sleek', 'slight', 'slim', 'small',
  'smart', 'smooth', 'snowy', 'soft', 'solar', 'solid', 'sound', 'south',
  'spare', 'stark', 'steady', 'steel', 'still', 'stony', 'strong', 'sturdy',
  'subtle', 'sunny', 'supple', 'sure', 'swift', 'tall', 'tame', 'teal',
  'tender', 'thin', 'tidal', 'tidy', 'timely', 'tiny', 'topaz', 'true',
  'twin', 'umber', 'upbeat', 'upper', 'urban', 'useful', 'vast', 'velvet',
  'violet', 'vivid', 'warm', 'wavy', 'wide', 'wild', 'windy', 'winter',
  'wise', 'witty', 'wooden', 'woolly', 'young', 'zesty',
];

export const HANDLE_NOUNS: readonly string[] = [
  'acorn', 'alcove', 'alder', 'anchor', 'apple', 'arbor', 'arch', 'arrow',
  'aspen', 'atlas', 'aurora', 'badge', 'bamboo', 'banjo', 'barley', 'basin',
  'beacon', 'beam', 'bell', 'birch', 'bird', 'bloom', 'bluff', 'boat',
  'bough', 'bridge', 'brook', 'cabin', 'cactus', 'camera', 'canoe', 'canopy',
  'canyon', 'cedar', 'cello', 'cider', 'cliff', 'cloud', 'clover', 'comet',
  'cove', 'crane', 'crater', 'creek', 'crest', 'crown', 'dahlia', 'daisy',
  'dale', 'dawn', 'delta', 'dial', 'dome', 'dove', 'dune', 'dusk',
  'eagle', 'earth', 'echo', 'elm', 'ember', 'fable', 'falcon', 'fern',
  'field', 'finch', 'fjord', 'flame', 'flint', 'flute', 'forest', 'forge',
  'fox', 'frost', 'garden', 'gate', 'glade', 'glass', 'globe', 'grove',
  'gulf', 'harbor', 'harp', 'haven', 'hawk', 'heath', 'hedge', 'hill',
  'ibis', 'inlet', 'iris', 'island', 'ivy', 'jetty', 'kayak', 'kelp',
  'kite', 'lagoon', 'lake', 'lamp', 'larch', 'lark', 'laurel', 'leaf',
  'ledge', 'lemon', 'lens', 'lily', 'linden', 'lotus', 'lynx', 'maple',
  'marble', 'marsh', 'meadow', 'mesa', 'meteor', 'mist', 'moon', 'moss',
  'moth', 'mount', 'nectar', 'needle', 'nest', 'oak', 'oasis', 'ocean',
  'onyx', 'opal', 'orbit', 'orchid', 'otter', 'owl', 'palm', 'paper',
  'path', 'pearl', 'pebble', 'petal', 'pier', 'pine', 'planet', 'plume',
  'pond', 'poplar', 'quarry', 'quartz', 'quill', 'rain', 'ranch', 'raven',
  'reed', 'reef', 'ridge', 'river', 'robin', 'rock', 'root', 'rose',
  'sable', 'sail', 'sand', 'season', 'shell', 'shore', 'sky', 'slate',
  'snow', 'spring', 'spruce', 'star', 'stone', 'storm', 'stream', 'summit',
  'sun', 'swan', 'thorn', 'tide', 'timber', 'torch', 'tower', 'trail',
  'tulip', 'tundra', 'vale', 'valley', 'vapor', 'vine', 'vista', 'wave',
  'willow', 'window', 'wing', 'wolf', 'wood', 'wren', 'yarrow', 'zephyr',
];

/**
 * Longest word either list may contain. The generator's contract test pins
 * this, so growing the vocabulary cannot silently lengthen minted handles
 * past HANDLE_CLAIM_MAX.
 */
export const HANDLE_WORD_MAX = 6;

/**
 * Attempts spent on a bare `adjective-noun` pair before falling back to a
 * numeric suffix. The bare space is the product of the two lists, so early
 * accounts get the short form; the suffix multiplies it by 90 once the bare
 * space starts filling up.
 */
export const BARE_HANDLE_ATTEMPTS = 4;

function pick(words: readonly string[]): string {
  // randomInt rejection-samples, so the pick stays uniform for list lengths
  // that do not divide the underlying random range.
  return words[randomInt(words.length)]!;
}

/**
 * Mint a candidate handle. Uniqueness is not checked here: the caller reserves
 * through profile_handles and retries this on conflict.
 */
export function generateAutomaticHandle(
  options: { readonly withSuffix?: boolean } = {},
): string {
  const pair = `${pick(HANDLE_ADJECTIVES)}-${pick(HANDLE_NOUNS)}`;
  return options.withSuffix === true ? `${pair}-${randomInt(10, 100)}` : pair;
}
