export const POST_CATEGORIES = Object.freeze([
  'Post',
  'HOWILEARN',
  'Interview',
  'Friends',
]);

const postCategorySet = new Set(POST_CATEGORIES);

export function normalizePostCategory(value) {
  const category = String(value || '').trim();
  return postCategorySet.has(category) ? category : null;
}
