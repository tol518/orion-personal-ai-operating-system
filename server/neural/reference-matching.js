const WORD = /[\p{L}\p{N}]+/gu;
const TITLE_STOP_WORDS = new Set([
  "about",
  "agent",
  "and",
  "app",
  "for",
  "from",
  "instructions",
  "me",
  "of",
  "project",
  "the",
  "to",
  "university",
]);

function words(value) {
  return (String(value ?? "").toLocaleLowerCase("en").match(WORD) ?? [])
    .filter((word) => word.length >= 4 && !TITLE_STOP_WORDS.has(word));
}

function includesPhrase(sourceWords, phraseWords) {
  if (!phraseWords.length || phraseWords.length > sourceWords.length) return false;
  for (let start = 0; start <= sourceWords.length - phraseWords.length; start += 1) {
    if (phraseWords.every((word, offset) => sourceWords[start + offset] === word)) return true;
  }
  return false;
}

export function explicitReferenceStrength(source, target) {
  const targetTags = new Set((target.tags ?? []).map((tag) => String(tag).toLocaleLowerCase("en")));
  // Consolidations describe entities but are not their canonical identity node.
  if (targetTags.has("consolidation") || targetTags.has("summary")) return 0;

  const sourceWords = words(`${source.title ?? ""} ${source.body ?? ""}`);
  const targetWords = words(target.title);
  if (!sourceWords.length || !targetWords.length) return 0;

  for (let size = targetWords.length; size >= 2; size -= 1) {
    for (let start = 0; start <= targetWords.length - size; start += 1) {
      if (includesPhrase(sourceWords, targetWords.slice(start, start + size))) return 1;
    }
  }

  const sourceSet = new Set(sourceWords);
  const matchingTitleWord = targetWords.find((word) => sourceSet.has(word));
  if (!matchingTitleWord) return 0;
  if (targetTags.has("person") || targetTags.has("identity")) return 1;
  return matchingTitleWord.length >= 5 ? 0.75 : 0;
}
