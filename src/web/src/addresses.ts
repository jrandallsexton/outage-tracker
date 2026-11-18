import data from '../../data/addresses.json';

export interface Address { id: string; number: number; street: string; label: string }

export const addresses: Address[] = data as Address[];
const byId = new Map(addresses.map((a) => [a.id, a]));

export const findAddress = (id: string | null | undefined) => (id ? byId.get(id.toLowerCase()) : undefined);

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const searchText = new Map(addresses.map((a) => [a.id, norm(a.label)]));

/**
 * Forgiving search: "3283", "3283 bar", "baravaldo 32" and "cozumel" all work.
 * Every typed word must match the start of a word in the address.
 */
export function searchAddresses(query: string, limit = 40): Address[] {
  const words = norm(query).split(' ').filter(Boolean);
  if (words.length === 0) return [];
  const hits = addresses.filter((a) => {
    const parts = searchText.get(a.id)!.split(' ');
    return words.every((w) => parts.some((p) => p.startsWith(w)));
  });
  const firstNumber = words.find((w) => /^\d+$/.test(w));
  if (firstNumber) hits.sort((a, b) => Number(String(b.number) === firstNumber) - Number(String(a.number) === firstNumber));
  return hits.slice(0, limit);
}
