export type UserId = string & { readonly __brand: 'UserId' };

export function userId(raw: string): UserId {
  if (raw === '') {
    throw new Error('empty user id');
  }
  return raw as UserId;
}
